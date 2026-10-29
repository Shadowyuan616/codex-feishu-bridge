import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import { isAbsolute } from 'node:path';
import WebSocket, { type RawData } from 'ws';
import { CodexRpcError } from './codex.js';

export interface SocketCodexOptions {
  socketPath: string;
  requestTimeoutMs?: number;
}
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
type Connection = {
  socket: WebSocket;
  pending: Map<string | number, Pending>;
  ready: boolean;
  disconnected: boolean;
  closed: Promise<void>;
  rejectOpen: (error: Error) => void;
  closeTimer?: NodeJS.Timeout;
};
const MAX_PAYLOAD = 8 * 1024 * 1024;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const requestId = (value: unknown): value is string | number => typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** JSON-RPC in WebSocket frames over a Unix socket, never raw JSONL on the UDS. */
export class SocketCodexClient extends EventEmitter {
  private connection?: Connection;
  private starting?: Promise<void>;
  private retiring?: Promise<void>;
  private sequence = 0;
  private readonly timeoutMs: number;

  constructor(private readonly options: SocketCodexOptions) {
    super();
    if (!isAbsolute(options.socketPath) || options.socketPath.includes('\0')) {
      throw new Error('Codex socketPath must be an absolute Unix socket path');
    }
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error('Invalid Codex request timeout');
  }

  async start(): Promise<void> {
    if (this.retiring) await this.retiring;
    if (this.connection?.ready) return;
    if (this.starting) return this.starting;
    const starting = this.connect();
    this.starting = starting;
    try { await starting; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const connection = this.connection;
    if (!connection?.ready || connection.disconnected) return Promise.reject(new Error('Codex is not connected; no request was sent'));
    return this.sendRequest<T>(connection, method, params);
  }

  respond(id: string | number, result: unknown): void {
    const connection = this.connection;
    if (!connection?.ready || connection.disconnected) throw new Error('Codex is not connected; no approval response was sent');
    if (!requestId(id)) throw new Error('Invalid Codex server request ID');
    this.send(connection, { id, result });
  }

  health(): { connected: boolean; pendingRequests: number; transport: string; starting: boolean } {
    return { connected: this.connection?.ready === true && !this.connection.disconnected,
      pendingRequests: this.connection?.pending.size ?? 0, transport: 'unix-websocket', starting: this.starting !== undefined };
  }

  async stop(): Promise<void> {
    const connection = this.connection;
    if (connection) this.disconnect(connection, new Error('Codex socket client stopped'));
    if (this.retiring) await this.retiring;
  }

  private async connect(): Promise<void> {
    let resolveOpen!: () => void, rejectOpen!: (error: Error) => void, resolveClose!: () => void;
    const opened = new Promise<void>((resolve, reject) => { resolveOpen = resolve; rejectOpen = reject; });
    // ws supports ws+unix URLs and createConnection. Passing the actual socket to
    // net avoids URL escaping/colon ambiguity in filesystem names. No TCP fallback.
    const socket = new WebSocket('ws+unix:///codex-control:/', {
      createConnection: () => createConnection({ path: this.options.socketPath }),
      handshakeTimeout: this.timeoutMs,
      maxPayload: MAX_PAYLOAD,
      perMessageDeflate: false,
      followRedirects: false,
    });
    const connection: Connection = { socket, pending: new Map(), ready: false, disconnected: false,
      closed: new Promise<void>((resolve) => { resolveClose = resolve; }), rejectOpen };
    this.connection = connection;
    socket.once('open', resolveOpen);
    socket.on('message', (data: RawData, binary: boolean) => this.consume(connection, data, binary));
    socket.on('error', () => this.disconnect(connection, new Error('Codex Unix WebSocket transport failed')));
    socket.once('close', (code) => {
      this.disconnect(connection, new Error(`Codex Unix WebSocket closed (${code})`));
      if (connection.closeTimer) clearTimeout(connection.closeTimer);
      resolveClose();
    });
    try {
      await opened;
      await this.sendRequest(connection, 'initialize', {
        clientInfo: { name: 'codex_feishu_bridge', title: 'Codex Feishu Bridge', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      this.send(connection, { method: 'initialized', params: {} });
      connection.ready = true;
    } catch (error) {
      this.disconnect(connection, error instanceof Error ? error : new Error('Codex socket initialization failed'));
      throw error;
    }
  }

  private sendRequest<T>(connection: Connection, method: string, params?: unknown): Promise<T> {
    if (connection.disconnected) return Promise.reject(new Error('Codex connection is closed'));
    if (!method || method.length > 256) return Promise.reject(new Error('Invalid Codex method'));
    if (connection.pending.size >= 256) return Promise.reject(new Error('Too many pending Codex requests'));
    const id = `bridge-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        reject(new Error(`Codex ${method} timed out; outcome may be unknown`));
      }, this.timeoutMs);
      connection.pending.set(id, { resolve: (result) => resolve(result as T), reject, timer });
      try { this.send(connection, { id, method, ...(params === undefined ? {} : { params }) }); }
      catch (error) {
        clearTimeout(timer); connection.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Could not send Codex request'));
      }
    });
  }

  private send(connection: Connection, value: unknown): void {
    if (connection.disconnected || connection.socket.readyState !== WebSocket.OPEN) throw new Error('Codex socket is closed');
    const frame = JSON.stringify(value);
    const bytes = Buffer.byteLength(frame);
    if (bytes > MAX_PAYLOAD || bytes + connection.socket.bufferedAmount > MAX_PAYLOAD) throw new Error('Codex socket write exceeds buffer limit');
    connection.socket.send(frame, (error) => {
      if (error) this.disconnect(connection, new Error('Codex socket write failed; outcome may be unknown'));
    });
  }

  private consume(connection: Connection, data: RawData, binary: boolean): void {
    if (connection.disconnected) return;
    if (binary) { this.disconnect(connection, new Error('Codex emitted an unexpected binary frame')); return; }
    let message: unknown;
    try { message = JSON.parse(data.toString()); }
    catch { this.disconnect(connection, new Error('Codex emitted invalid JSON protocol data')); return; }
    if (!record(message)) { this.disconnect(connection, new Error('Codex emitted an invalid protocol frame')); return; }
    if (typeof message.method === 'string' && message.method.length <= 256) {
      if (Object.hasOwn(message, 'id')) {
        if (!requestId(message.id)) { this.disconnect(connection, new Error('Codex emitted an invalid request ID')); return; }
        this.emit('serverRequest', { id: message.id, method: message.method, params: message.params });
      } else this.emit('notification', message.method, message.params);
    } else if (requestId(message.id)) {
      const pending = connection.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer); connection.pending.delete(message.id);
      if (record(message.error)) pending.reject(new CodexRpcError(
        typeof message.error.code === 'number' ? message.error.code : -32603,
        typeof message.error.message === 'string' ? message.error.message : 'Codex request failed',
      ));
      else if (Object.hasOwn(message, 'result')) pending.resolve(message.result);
      else pending.reject(new Error('Codex response has no result or error'));
    } else this.disconnect(connection, new Error('Codex emitted an unrecognized protocol frame'));
  }

  private disconnect(connection: Connection, reason: Error): void {
    if (connection.disconnected) return;
    connection.disconnected = true; connection.ready = false;
    connection.rejectOpen(reason);
    for (const pending of connection.pending.values()) { clearTimeout(pending.timer); pending.reject(reason); }
    connection.pending.clear();
    if (this.connection === connection) this.connection = undefined;
    this.retiring = connection.closed;
    void connection.closed.then(() => { if (this.retiring === connection.closed) this.retiring = undefined; });
    if (connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.close(1000, 'bridge connection closed');
      connection.closeTimer = setTimeout(() => connection.socket.terminate(), 1_000);
      connection.closeTimer.unref();
    } else if (connection.socket.readyState === WebSocket.CONNECTING) connection.socket.terminate();
    this.emit('disconnect', reason);
  }
}
