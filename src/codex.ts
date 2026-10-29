import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface CodexClientOptions {
  binary: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  requestTimeoutMs?: number;
}

export interface CodexServerRequest {
  id: string | number;
  method: string;
  params: unknown;
}

export class CodexRpcError extends Error {
  constructor(public readonly code: number, message: string) {
    super(message.slice(0, 2_000));
    this.name = 'CodexRpcError';
  }
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Connection = {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string | number, Pending>;
  buffer: string;
  ready: boolean;
  disconnected: boolean;
  exited: Promise<void>;
  killTimer?: ReturnType<typeof setTimeout>;
};

// Limits apply to protocol framing, not to persisted Codex conversation history.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_PENDING = 256;
const STOP_GRACE_MS = 2_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRequestId(value: unknown): value is string | number {
  return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

/** Independent app-server --stdio only; daemon proxy is not JSON-lines. */
export class CodexClient extends EventEmitter {
  private connection?: Connection;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private retiring?: Promise<void>;
  private sequence = 0;
  private readonly timeoutMs: number;

  constructor(private readonly options: CodexClientOptions) {
    super();
    this.timeoutMs = options.requestTimeoutMs ?? 30_000;
    if (!options.binary || !Array.isArray(options.args)) {
      throw new Error('Codex binary and argument array are required');
    }
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('Codex requestTimeoutMs must be positive');
    }
  }

  async start(): Promise<void> {
    if (this.stopping) await this.stopping;
    if (this.retiring) await this.retiring;
    if (this.connection?.ready) return;
    if (this.starting) return this.starting;
    const starting = this.connect();
    this.starting = starting;
    try {
      await starting;
    } finally {
      if (this.starting === starting) this.starting = undefined;
    }
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const connection = this.connection;
    if (!connection?.ready || connection.disconnected) {
      return Promise.reject(new Error('Codex is not connected; no request was sent'));
    }
    return this.sendRequest<T>(connection, method, params);
  }

  respond(id: string | number, result: unknown): void {
    const connection = this.connection;
    if (!connection?.ready || connection.disconnected) {
      throw new Error('Codex is not connected; no approval response was sent');
    }
    if (!isRequestId(id)) throw new Error('Invalid Codex server request ID');
    this.write(connection, { id, result });
  }

  health(): { connected: boolean; pendingRequests: number; pid: number | null; starting: boolean } {
    return {
      connected: this.connection?.ready === true && !this.connection.disconnected,
      pendingRequests: this.connection?.pending.size ?? 0,
      pid: this.connection?.child.pid ?? null,
      starting: this.starting !== undefined,
    };
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    const connection = this.connection;
    if (!connection) {
      if (this.retiring) await this.retiring;
      return;
    }
    const stopping = (async () => {
      // Only our stdio child is signalled. Never call daemon stop/restart here.
      this.disconnect(connection, new Error('Codex client stopped'));
      await connection.exited;
    })();
    this.stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this.stopping === stopping) this.stopping = undefined;
    }
  }

  private async connect(): Promise<void> {
    const child = spawn(this.options.binary, this.options.args, {
      cwd: this.options.cwd,
      env: { ...process.env, ...this.options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    let resolveExit!: () => void;
    const connection: Connection = {
      child,
      pending: new Map(),
      buffer: '',
      ready: false,
      disconnected: false,
      exited: new Promise<void>((resolve) => { resolveExit = resolve; }),
    };
    this.connection = connection;
    const exited = () => {
      if (connection.killTimer) clearTimeout(connection.killTimer);
      resolveExit();
    };
    child.once('error', () => {
      this.disconnect(connection, new Error('Failed to launch Codex transport'));
      exited();
    });
    child.once('exit', (code, signal) => {
      this.disconnect(connection, new Error(`Codex transport exited (${signal ?? code ?? 'unknown'})`));
      exited();
    });
    child.stdin.on('error', () => {
      this.disconnect(connection, new Error('Codex transport input closed'));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.consume(connection, chunk));
    child.stdout.once('end', () => {
      this.disconnect(connection, new Error('Codex transport exited or closed its output'));
    });
    // Diagnostics can contain credentials and conversation text. Drain, never log/store.
    child.stderr.resume();
    try {
      await this.sendRequest(connection, 'initialize', {
        clientInfo: { name: 'codex_feishu_bridge', title: 'Codex Feishu Bridge', version: '0.1.0' },
        capabilities: { experimentalApi: true },
      });
      if (connection.disconnected) throw new Error('Codex disconnected during initialization');
      this.write(connection, { method: 'initialized', params: {} });
      connection.ready = true;
    } catch (error) {
      this.disconnect(connection, error instanceof Error ? error : new Error('Codex initialization failed'));
      throw error;
    }
  }

  private sendRequest<T>(connection: Connection, method: string, params?: unknown): Promise<T> {
    if (connection.disconnected) return Promise.reject(new Error('Codex connection is closed'));
    if (!method || method.length > 256) return Promise.reject(new Error('Invalid Codex method'));
    if (connection.pending.size >= MAX_PENDING) {
      return Promise.reject(new Error('Too many pending Codex requests'));
    }
    const id = `bridge-${++this.sequence}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        connection.pending.delete(id);
        // A timeout does not prove the operation was rejected. Never replay it here.
        reject(new Error(`Codex ${method} timed out; outcome may be unknown`));
      }, this.timeoutMs);
      connection.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      try {
        this.write(connection, { id, method, ...(params === undefined ? {} : { params }) });
      } catch (error) {
        clearTimeout(timer);
        connection.pending.delete(id);
        reject(error instanceof Error ? error : new Error('Could not send Codex request'));
      }
    });
  }

  private write(connection: Connection, message: unknown): void {
    if (connection.disconnected) throw new Error('Codex connection is closed');
    const frame = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) throw new Error('Codex request exceeds frame limit');
    if (connection.child.stdin.writableLength + Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
      throw new Error('Codex transport write buffer is full');
    }
    connection.child.stdin.write(frame, (error) => {
      if (error) this.disconnect(connection, new Error('Codex transport write failed; outcome may be unknown'));
    });
  }

  private consume(connection: Connection, chunk: string): void {
    if (connection.disconnected) return;
    connection.buffer += chunk;
    let newline: number;
    while ((newline = connection.buffer.indexOf('\n')) !== -1) {
      const line = connection.buffer.slice(0, newline);
      connection.buffer = connection.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
        this.disconnect(connection, new Error('Codex response exceeds frame limit'));
        return;
      }
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.disconnect(connection, new Error('Codex emitted invalid JSON protocol data'));
        return;
      }
      if (!isRecord(message)) {
        this.disconnect(connection, new Error('Codex emitted an invalid protocol frame'));
        return;
      }
      if (typeof message.method === 'string') {
        if (Object.hasOwn(message, 'id')) {
          if (!isRequestId(message.id)) {
            this.disconnect(connection, new Error('Codex emitted an invalid request ID'));
            return;
          }
          this.emit('serverRequest', { id: message.id, method: message.method, params: message.params });
        } else {
          this.emit('notification', message.method, message.params);
        }
      } else if (isRequestId(message.id)) {
        const pending = connection.pending.get(message.id);
        if (!pending) continue; // Late reply to a timed-out request; never replay it.
        connection.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (isRecord(message.error)) {
          pending.reject(new CodexRpcError(
            typeof message.error.code === 'number' ? message.error.code : -32603,
            typeof message.error.message === 'string' ? message.error.message : 'Codex request failed',
          ));
        } else if (Object.hasOwn(message, 'result')) {
          pending.resolve(message.result);
        } else {
          pending.reject(new Error('Codex response has no result or error'));
        }
      } else {
        this.disconnect(connection, new Error('Codex emitted an unrecognized protocol frame'));
        return;
      }
      if (connection.disconnected) return;
    }
    if (Buffer.byteLength(connection.buffer) > MAX_FRAME_BYTES) {
      this.disconnect(connection, new Error('Codex unterminated response exceeds frame limit'));
    }
  }

  private disconnect(connection: Connection, reason: Error): void {
    if (connection.disconnected) return;
    connection.disconnected = true;
    connection.ready = false;
    connection.buffer = '';
    for (const pending of connection.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    connection.pending.clear();
    if (this.connection === connection) this.connection = undefined;
    this.retiring = connection.exited;
    void connection.exited.then(() => {
      if (this.retiring === connection.exited) this.retiring = undefined;
    });
    if (connection.child.exitCode === null && connection.child.signalCode === null) {
      connection.child.kill('SIGTERM');
      connection.killTimer = setTimeout(() => {
        if (connection.child.exitCode === null && connection.child.signalCode === null) {
          connection.child.kill('SIGKILL');
        }
      }, STOP_GRACE_MS);
      connection.killTimer.unref();
    }
    this.emit('disconnect', reason);
  }
}
