import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';

export type Inbound = {
  id: string;
  chatId: string;
  userId: string;
  text: string;
  kind: 'message' | 'action' | 'menu';
  messageId?: string;
};

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : null;
const nonempty = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;
const MENU_COMMANDS = new Map([
  ['codex_dirs', '/dirs'], ['codex_sessions', '/sessions'],
  ['codex_status', '/status'], ['codex_more', '/more'],
]);

/** The CLI's processed event schema is flat; content is already plain text. */
export function normalizeEvent(raw: unknown): Inbound | null {
  const value = object(raw);
  if (!value) return null;
  if (value.type === 'application.bot.menu_v6') {
    const id = nonempty(value.event_id);
    const userId = nonempty(value.operator_open_id) ?? nonempty(value.operator_id);
    const text = typeof value.event_key === 'string' ? MENU_COMMANDS.get(value.event_key) : undefined;
    if (!id || !userId || !/^ou_[A-Za-z0-9_-]+$/.test(userId) || !text) return null;
    if (value.operator_id !== undefined && value.operator_id !== userId) return null;
    // This event has no chat_id. Never trust an injected destination: the durable
    // router resolves the authenticated operator's own P2P conversation.
    return { id, chatId: '', userId, text, kind: 'menu' };
  }
  const chatId = nonempty(value.chat_id);
  const messageId = nonempty(value.message_id) ?? nonempty(value.id);
  if (!chatId) return null;
  if (value.type === 'im.message.receive_v1') {
    if (value.chat_type !== 'p2p' || value.message_type !== 'text') return null;
    const userId = nonempty(value.sender_id);
    const id = nonempty(value.event_id) ?? messageId;
    const text = nonempty(value.content);
    if (!userId || !id || !text) return null;
    return { id, chatId, userId, text, kind: 'message', ...(messageId ? { messageId } : {}) };
  }
  if (value.type !== 'card.action.trigger' || value.action_tag !== 'button' || value.chat_type === 'group') return null;
  const id = nonempty(value.event_id);
  const userId = nonempty(value.operator_id);
  if (!id || !userId || typeof value.action_value !== 'string') return null;
  let action: ObjectValue | null;
  try { action = object(JSON.parse(value.action_value)); } catch { return null; }
  const text = nonempty(action?.command);
  if (!text || !text.startsWith('/')) return null;
  // Card actions have no chat_type in the CLI schema. The router must also check
  // the actor and match messageId/chatId to a card receipt sent by this bridge.
  return { id, chatId, userId, text, kind: 'action', ...(messageId ? { messageId } : {}) };
}

export type LarkCliOptions = {
  binary: string;
  profile?: string;
  cwd?: string;
  startupTimeoutMs?: number;
  commandTimeoutMs?: number;
  uploadTimeoutMs?: number;
  restartBaseMs?: number;
  restartMaxMs?: number;
  maxRestarts?: number;
  configurationRetryMs?: number;
};

/** Carries structured remediation metadata, never raw stdout/stderr or credentials. */
export class LarkCliError extends Error {
  readonly exitCode: number | null;
  readonly errorType?: string;
  readonly subtype?: string;
  readonly missingScopes: string[];
  readonly retryable: boolean;
  constructor(operation: string, exitCode: number | null, envelope?: unknown) {
    const outer = object(envelope);
    const detail = object(outer?.error);
    const errorType = nonempty(detail?.type);
    const subtype = nonempty(detail?.subtype);
    const apiCode = typeof outer?.code === 'number' ? outer.code : undefined;
    super(`Lark CLI ${operation} failed (exit=${exitCode ?? 'none'}${errorType ? `, type=${errorType}` : ''}${subtype ? `, subtype=${subtype}` : ''}${apiCode ? `, apiCode=${apiCode}` : ''})`);
    this.name = 'LarkCliError';
    this.exitCode = exitCode;
    this.errorType = errorType;
    this.subtype = subtype;
    const scopes = detail?.missing_scopes;
    this.missingScopes = Array.isArray(scopes) ? scopes.filter((x): x is string => typeof x === 'string') : [];
    this.retryable = exitCode !== 2 && exitCode !== 3 && exitCode !== 10
      && !['auth', 'authentication', 'authorization', 'permission', 'validation', 'confirmation_required'].includes(errorType ?? '')
      && !['missing_scope', 'missing_scopes', 'permission_denied', 'invalid_token'].includes(subtype ?? '');
  }
}

type Consumer = {
  key: string;
  child?: ChildProcessWithoutNullStreams;
  timer?: ReturnType<typeof setTimeout>;
  ready: boolean;
  failures: number;
  lastReadyAt?: number;
  failure?: string;
  permanent: boolean;
  configurationPending?: boolean;
};

const EVENT_KEYS = ['im.message.receive_v1', 'card.action.trigger', 'application.bot.menu_v6'];
const MAX_OUTPUT = 1024 * 1024;
const cliEnv = () => ({ ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' });

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { /* envelopes can follow diagnostic lines */ }
  for (const line of text.split('\n').reverse()) {
    try { const result: unknown = JSON.parse(line); if (object(result)) return result; } catch { /* not JSON */ }
  }
  const start = text.indexOf('{');
  if (start >= 0) { try { return JSON.parse(text.slice(start)); } catch { /* no complete envelope */ } }
  return undefined;
}

function failedEnvelope(value: unknown): boolean {
  const data = object(value);
  return !!data && (data.ok === false || data.success === false || (typeof data.code === 'number' && data.code !== 0) || !!data.error);
}

export class LarkCli {
  private readonly consumers: Consumer[] = EVENT_KEYS.map(key => ({ key, ready: false, failures: 0, permanent: false }));
  private running = false;
  private onEvent?: (event: Inbound) => void;
  private starting?: Promise<void>;
  private readonly commands = new Set<ChildProcessWithoutNullStreams>();
  constructor(private readonly opts: LarkCliOptions, private readonly logger: (event: string, detail?: unknown) => void = () => {}) {}

  private args(args: string[]): string[] {
    return [...(this.opts.profile ? ['--profile', this.opts.profile] : []), ...args];
  }

  async start(onEvent: (event: Inbound) => void): Promise<void> {
    if (this.starting) return this.starting;
    if (this.running) return;
    this.running = true;
    this.onEvent = onEvent;
    for (const consumer of this.consumers) { consumer.failures = 0; consumer.permanent = false; delete consumer.failure; }
    this.starting = Promise.all(this.consumers.map(consumer => this.launch(consumer).catch(error => {
      // A newly added menu subscription must not take existing messages/cards
      // offline while its administrator confirmation is still pending.
      if (consumer.key === 'application.bot.menu_v6' && error instanceof LarkCliError && error.subtype === 'failed_precondition') return;
      throw error;
    })))
      .then(() => undefined)
      .catch(async error => { await this.stop(); throw error; })
      .finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private launch(consumer: Consumer): Promise<void> {
    if (!this.running) return Promise.resolve();
    consumer.ready = false;
    const child = spawn(this.opts.binary, this.args(['event', 'consume', consumer.key, '--as', 'bot']), {
      cwd: this.opts.cwd, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false,
    });
    consumer.child = child;
    // Intentionally leave stdin open. Unbounded lark-cli consume exits on EOF.
    child.stdin.on('error', () => {});
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let startupTimedOut = false;
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    const timeout = setTimeout(() => {
      startupTimedOut = true;
      if (!settled) { settled = true; rejectReady(new Error(`Lark consumer ${consumer.key} ready timeout`)); }
      child.stdin.end();
      child.kill('SIGTERM');
    }, this.opts.startupTimeoutMs ?? 30_000);
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    // stdout and stderr are separate pipes: an event can arrive before the ready
    // marker is observed even when the CLI wrote the marker first. Buffer it.
    lines.pause();
    lines.on('line', line => {
      outputBytes = 0;
      if (!consumer.ready || !this.running) return;
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch { this.logger('lark.invalid_event', { key: consumer.key }); return; }
      const event = normalizeEvent(parsed);
      if (!event) return;
      try { this.onEvent?.(event); } catch { this.logger('lark.handler_failed', { key: consumer.key }); }
    });
    child.stdout.on('data', (chunk: Buffer) => {
      // Prevent a corrupt/malicious stream without newlines from consuming memory.
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT) { child.stdin.end(); child.kill('SIGTERM'); }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_OUTPUT);
      if (!settled && stderr.split(/\r?\n/).some(line => line.trim() === `[event] ready event_key=${consumer.key}`)) {
        settled = true;
        consumer.ready = true;
        if (consumer.configurationPending) consumer.failures = 0;
        delete consumer.configurationPending;
        consumer.lastReadyAt = Date.now();
        delete consumer.failure;
        clearTimeout(timeout);
        this.logger('lark.ready', { key: consumer.key });
        lines.resume();
        resolveReady();
      }
    });
    child.once('error', () => {
      consumer.permanent = true;
      consumer.failure = 'Unable to start lark-cli; check the configured executable and permissions';
      if (!settled) { settled = true; clearTimeout(timeout); rejectReady(new Error(consumer.failure)); }
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      lines.close();
      consumer.ready = false;
      if (consumer.child === child) delete consumer.child;
      const error = new LarkCliError(`consume ${consumer.key}`, code, parseJson(stderr));
      if (!settled) { settled = true; rejectReady(error); }
      if (!this.running) return;
      if (consumer.lastReadyAt && Date.now() - consumer.lastReadyAt > 60_000) consumer.failures = 0;
      consumer.failures += 1;
      consumer.failure = startupTimedOut ? 'Event consumer did not become ready before timeout' : error.message;
      if (consumer.key === 'application.bot.menu_v6' && error.subtype === 'failed_precondition') {
        consumer.permanent = false;
        consumer.failures = 0;
        if (!consumer.configurationPending) this.logger('lark.menu_subscription_pending', { key: consumer.key });
        consumer.configurationPending = true;
        consumer.timer = setTimeout(() => {
          delete consumer.timer;
          if (this.running) void this.launch(consumer).catch(() => {});
        }, this.opts.configurationRetryMs ?? 60_000);
        return;
      }
      if (!error.retryable || consumer.permanent || consumer.failures > (this.opts.maxRestarts ?? 8)) {
        consumer.permanent = true;
        this.logger('lark.consumer_stopped', { key: consumer.key, failures: consumer.failures, errorType: error.errorType, subtype: error.subtype });
        return;
      }
      const delayMs = Math.min(this.opts.restartMaxMs ?? 30_000, (this.opts.restartBaseMs ?? 1_000) * 2 ** (consumer.failures - 1));
      this.logger('lark.reconnecting', { key: consumer.key, delayMs, failures: consumer.failures });
      consumer.timer = setTimeout(() => {
        delete consumer.timer;
        if (this.running) void this.launch(consumer).catch(() => {});
      }, delayMs);
    });
    return ready;
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(this.consumers.map(async consumer => {
      if (consumer.timer) { clearTimeout(consumer.timer); delete consumer.timer; }
      consumer.ready = false;
      const child = consumer.child;
      if (!child) return;
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { child.kill('SIGTERM'); resolve(); }, 2_000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
        child.kill('SIGTERM');
      });
    }));
    await Promise.all([...this.commands].map(child=>new Promise<void>(resolve=>{
      const timer=setTimeout(resolve,2_000);
      child.once('close',()=>{clearTimeout(timer);resolve();});
      child.stdin.end();child.kill('SIGTERM');
    })));
    // Never call `event stop`: the bus can be shared by unrelated CLI consumers.
  }

  private run(operation: string, args: string[], input?: string | Buffer, timeoutMs = this.opts.commandTimeoutMs ?? 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.binary, this.args(args), { cwd: this.opts.cwd, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
      this.commands.add(child);
      let stdout = '';
      let stderr = '';
      let failure: Error | undefined;
      const timeout = setTimeout(() => {
        failure = new Error(`Lark CLI ${operation} timed out`);
        child.kill('SIGTERM');
        reject(failure);
      }, timeoutMs);
      const collect = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
        if (failure) return;
        if (stream === 'stdout') stdout += chunk.toString(); else stderr += chunk.toString();
        if (stdout.length + stderr.length > MAX_OUTPUT) {
          failure = new Error(`Lark CLI ${operation} response exceeded size limit`);
          child.kill('SIGTERM');
          reject(failure);
        }
      };
      child.stdout.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr.on('data', (chunk: Buffer) => collect('stderr', chunk));
      child.stdin.on('error', () => {});
      child.once('error', () => { clearTimeout(timeout); reject(new Error(`Unable to start lark-cli for ${operation}`)); });
      child.once('close', code => {
        this.commands.delete(child);
        clearTimeout(timeout);
        if (failure) { reject(failure); return; }
        const result = parseJson(stdout);
        const stderrResult = parseJson(stderr);
        if (code !== 0 || failedEnvelope(result) || failedEnvelope(stderrResult)) {
          reject(new LarkCliError(operation, code, failedEnvelope(stderrResult) ? stderrResult : result)); return;
        }
        if (!object(result)) { reject(new Error(`Lark CLI ${operation} returned no JSON receipt`)); return; }
        resolve(result);
      });
      child.stdin.end(input);
    });
  }

  async sendCard(chatId: string, card: Record<string, unknown>, idempotencyKey: string): Promise<string> {
    return this.sendMessage(chatId, 'interactive', card, idempotencyKey);
  }

  async sendMessage(chatId: string, msgType: string, content: Record<string, unknown>, idempotencyKey: string): Promise<string> {
    if (!/^oc_[A-Za-z0-9_-]+$/.test(chatId) || !idempotencyKey.trim()) throw new Error('A chat ID and stable idempotency key are required');
    if (!['interactive', 'file', 'image'].includes(msgType)) throw new Error('Unsupported message type');
    const result = object(await this.run(`send ${msgType}`, ['im', '+messages-send', '--as', 'bot', '--chat-id', chatId,
      '--msg-type', msgType, '--content', JSON.stringify(content), '--idempotency-key', idempotencyKey, '--json']));
    const data = object(result?.data);
    const message = object(result?.message) ?? object(data?.message);
    const id = nonempty(result?.message_id) ?? nonempty(data?.message_id) ?? nonempty(message?.message_id);
    if (!id) throw new Error(`Lark send ${msgType} returned no message ID receipt`);
    return id;
  }

  /** Bytes go through stdin, so no local path is exposed to (or restricted by) the CLI. */
  async uploadImage(data: Buffer): Promise<string> {
    const result = object(await this.run('uploadImage', ['im', 'images', 'create', '--as', 'bot',
      '--data', JSON.stringify({ image_type: 'message' }), '--file', 'image=-', '--json'], data, this.opts.uploadTimeoutMs ?? 120_000));
    const key = nonempty(object(result?.data)?.image_key) ?? nonempty(result?.image_key);
    if (!key || !/^img_[A-Za-z0-9_-]+$/.test(key)) throw new Error('Lark uploadImage returned no image_key');
    return key;
  }

  async uploadFile(data: Buffer, name: string, fileType: string): Promise<string> {
    const fileName = Array.from(name.replace(/[\r\n\0/\\]/g, '_')).slice(0, 200).join('') || 'attachment';
    const result = object(await this.run('uploadFile', ['api', 'POST', '/open-apis/im/v1/files', '--as', 'bot',
      '--data', JSON.stringify({ file_type: fileType, file_name: fileName }), '--file', 'file=-', '--json'], data, this.opts.uploadTimeoutMs ?? 120_000));
    const key = nonempty(object(result?.data)?.file_key) ?? nonempty(result?.file_key);
    if (!key || !/^file_[A-Za-z0-9_-]+$/.test(key)) throw new Error('Lark uploadFile returned no file_key');
    return key;
  }

  /** Only needed before the operator has ever sent this bridge a P2P message. */
  async ensureDirectChat(userId: string, idempotencyKey: string): Promise<string> {
    if (!/^ou_[A-Za-z0-9_-]+$/.test(userId) || !idempotencyKey.trim()) throw new Error('A user ID and stable idempotency key are required');
    const result = object(await this.run('ensureDirectChat', ['im', '+messages-send', '--as', 'bot', '--user-id', userId,
      '--text', 'Codex 控制台已连接，正在打开菜单。', '--idempotency-key', idempotencyKey, '--json']));
    const data = object(result?.data);
    const message = object(result?.message) ?? object(data?.message);
    const chatId = nonempty(result?.chat_id) ?? nonempty(data?.chat_id) ?? nonempty(message?.chat_id);
    if (!chatId || !/^oc_[A-Za-z0-9_-]+$/.test(chatId)) throw new Error('Lark ensureDirectChat returned no chat ID receipt');
    return chatId;
  }

  async updateCard(messageId: string, card: Record<string, unknown>): Promise<void> {
    if (!/^om_[A-Za-z0-9_-]+$/.test(messageId)) throw new Error('Invalid card message ID');
    await this.run('updateCard', ['api', 'PATCH', `/open-apis/im/v1/messages/${messageId}`, '--as', 'bot', '--data', '-'],
      JSON.stringify({ content: JSON.stringify(card) }));
  }

  health(): unknown {
    return { running: this.running, ready: this.running && this.consumers.every(c => c.ready),
      consumers: this.consumers.map(c => ({ key: c.key, ready: c.ready, failures: c.failures, permanent: c.permanent, configurationPending: c.configurationPending === true, failure: c.failure })) };
  }
}
