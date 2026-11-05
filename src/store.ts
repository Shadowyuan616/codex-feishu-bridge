import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash } from 'node:crypto';

export interface Binding { chat: string; user: string; thread: string; cwd: string; fingerprint: string }
export interface Inbox { id: string; chat: string; user: string; text: string; kind: string; status: string; thread: string | null; created: number }
export interface Outbox { key: string; chat: string; content: string; version: number; sent_version: number; message: string | null; attempts: number; created: number }
export interface Pending { token: string; requestId: string; method: string; thread: string; chat: string; user: string; params: string; status: string }

/** SQLite is the durability boundary. Keep it on a local, persistent filesystem. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS bindings(chat TEXT, user TEXT, thread TEXT, cwd TEXT, fingerprint TEXT DEFAULT '', PRIMARY KEY(chat,user));
      CREATE TABLE IF NOT EXISTS inbox(id TEXT PRIMARY KEY, chat TEXT, user TEXT, text TEXT, kind TEXT, status TEXT DEFAULT 'received', thread TEXT, created INTEGER);
      CREATE TABLE IF NOT EXISTS outbox(key TEXT PRIMARY KEY, chat TEXT, content TEXT, version INTEGER DEFAULT 1, sent_version INTEGER DEFAULT 0, message TEXT, attempts INTEGER DEFAULT 0, next_at INTEGER DEFAULT 0, created INTEGER, error TEXT);
      CREATE TABLE IF NOT EXISTS pending(token TEXT PRIMARY KEY, requestId TEXT, method TEXT, thread TEXT, chat TEXT, user TEXT, params TEXT, status TEXT DEFAULT 'pending');
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS direct_chats(user TEXT PRIMARY KEY, chat TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS pending_request ON pending(requestId);
    `);
  }
  close() { this.db.close(); }
  ingest(e: {id:string; chatId:string; userId:string; text:string; kind:string}): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO inbox(id,chat,user,text,kind,created) VALUES(?,?,?,?,?,?)').run(e.id,e.chatId,e.userId,e.text,e.kind,Date.now()).changes) === 1;
  }
  queued(): Inbox[] { return this.db.prepare("SELECT * FROM inbox WHERE status='received' ORDER BY created LIMIT 100").all() as unknown as Inbox[]; }
  mark(id: string, status: string, thread?: string) { this.db.prepare('UPDATE inbox SET status=?,thread=COALESCE(?,thread) WHERE id=?').run(status,thread ?? null,id); }
  rememberDirectChat(user:string,chat:string) {
    if(!/^ou_[A-Za-z0-9_-]+$/.test(user)||!/^oc_[A-Za-z0-9_-]+$/.test(chat))throw new Error('无效的单聊映射');
    this.db.prepare('INSERT INTO direct_chats(user,chat) VALUES(?,?) ON CONFLICT(user) DO UPDATE SET chat=excluded.chat').run(user,chat);
  }
  directChat(user:string):string|undefined {
    const saved=this.db.prepare('SELECT chat FROM direct_chats WHERE user=?').get(user)?.chat;
    if(typeof saved==='string'&&/^oc_[A-Za-z0-9_-]+$/.test(saved))return saved;
    // Only bindings and authenticated p2p/card ingress can seed old databases.
    // Menu payloads have no chat_id and must never supply their own destination.
    const previous=this.db.prepare("SELECT chat FROM bindings WHERE user=? UNION SELECT chat FROM inbox WHERE user=? AND kind IN ('message','action')").all(user,user);
    const chats=[...new Set(previous.map(x=>x.chat).filter((chat):chat is string=>typeof chat==='string'&&/^oc_[A-Za-z0-9_-]+$/.test(chat)))];
    if(chats.length!==1)return undefined;
    this.rememberDirectChat(user,chats[0]!);return chats[0];
  }
  routeMenu(id:string,chat:string) {
    if(!/^oc_[A-Za-z0-9_-]+$/.test(chat))throw new Error('无效的单聊会话');
    this.db.prepare("UPDATE inbox SET chat=? WHERE id=? AND kind='menu'").run(chat,id);
  }
  recover(): Inbox[] {
    const unknown = this.db.prepare("SELECT * FROM inbox WHERE status='dispatching'").all() as unknown as Inbox[];
    this.db.prepare("UPDATE inbox SET status='uncertain' WHERE status='dispatching'").run();
    this.db.prepare("UPDATE inbox SET status='received' WHERE status='processing'").run();
    this.invalidatePending();
    return unknown;
  }
  bind(chat: string,user: string,thread: string,cwd: string) {
    // One controlling conversation per thread makes approval routing unambiguous.
    const other = this.db.prepare('SELECT chat,user FROM bindings WHERE thread=? AND NOT (chat=? AND user=?)').get(thread,chat,user);
    if (other) throw new Error('该会话已绑定另一个飞书对话，请先在那里 /unbind');
    this.db.prepare("INSERT INTO bindings(chat,user,thread,cwd) VALUES(?,?,?,?) ON CONFLICT(chat,user) DO UPDATE SET thread=excluded.thread,cwd=excluded.cwd,fingerprint=''").run(chat,user,thread,cwd);
  }
  unbind(chat:string,user:string) { this.db.prepare('DELETE FROM bindings WHERE chat=? AND user=?').run(chat,user); }
  binding(chat:string,user:string) { return this.db.prepare('SELECT * FROM bindings WHERE chat=? AND user=?').get(chat,user) as unknown as Binding | undefined; }
  bindings(): Binding[] { return this.db.prepare('SELECT * FROM bindings').all() as unknown as Binding[]; }
  fingerprint(chat:string,user:string,value:string) { this.db.prepare('UPDATE bindings SET fingerprint=? WHERE chat=? AND user=?').run(value,chat,user); }
  putCard(key:string,chat:string,content:Record<string,unknown>) {
    // A Feishu receipt belongs to one destination forever, including after rebind.
    key = `${chat}:${key}`;
    const serialized = JSON.stringify(content);
    this.db.prepare(`INSERT INTO outbox(key,chat,content,created) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET content=excluded.content, version=outbox.version+1,
      next_at=CASE WHEN outbox.next_at=9007199254740991 THEN outbox.next_at ELSE 0 END,
      attempts=CASE WHEN outbox.next_at=9007199254740991 THEN outbox.attempts ELSE 0 END,
      error=CASE WHEN outbox.next_at=9007199254740991 THEN outbox.error ELSE NULL END
      WHERE outbox.content!=excluded.content`).run(key,chat,serialized,Date.now());
  }
  due(now=Date.now()): Outbox[] {
    return this.db.prepare('SELECT * FROM outbox WHERE sent_version<version AND next_at<=? ORDER BY created LIMIT 20').all(now) as unknown as Outbox[];
  }
  sent(row:Outbox,message:string) { this.db.prepare('UPDATE outbox SET message=?,sent_version=?,attempts=0,next_at=0,error=NULL WHERE key=?').run(message,row.version,row.key); }
  retry(row:Outbox,error:string,now=Date.now()) {
    // Sending may have succeeded without a receipt. Feishu UUID dedup is bounded;
    // after 50 min require inspection rather than risking a duplicate new message.
    const next = !row.message && now-row.created>50*60_000 ? Number.MAX_SAFE_INTEGER : now+Math.min(300_000,1000*2**Math.min(row.attempts,8));
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,next_at=?,error=? WHERE key=?').run(next,error.slice(0,200),row.key);
  }
  pending(p:Pending) {
    this.db.prepare(`INSERT INTO pending(token,requestId,method,thread,chat,user,params,status) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(requestId) DO NOTHING`).run(p.token,p.requestId,p.method,p.thread,p.chat,p.user,p.params,p.status);
    return this.db.prepare('SELECT * FROM pending WHERE requestId=?').get(p.requestId) as unknown as Pending;
  }
  getPending(token:string) { return this.db.prepare('SELECT * FROM pending WHERE token=?').get(token) as unknown as Pending|undefined; }
  finishPending(token:string,status='resolved') { this.db.prepare('UPDATE pending SET status=? WHERE token=?').run(status,token); }
  resolveRequest(id:string) { this.db.prepare("UPDATE pending SET status='resolved' WHERE requestId=?").run(id); }
  invalidatePending() { this.db.prepare("UPDATE pending SET status='stale' WHERE status IN ('pending','responding')").run(); }
  hasReceipt(message:string,chat:string):boolean { return !!this.db.prepare('SELECT 1 FROM outbox WHERE message=? AND chat=?').get(message,chat); }
  pendingFor(thread:string): Pending[] { return this.db.prepare("SELECT * FROM pending WHERE thread=? AND status='pending'").all(thread) as unknown as Pending[]; }
  health() { return {
    queued: this.db.prepare("SELECT COUNT(*) n FROM inbox WHERE status='received'").get()?.n,
    uncertain: this.db.prepare("SELECT COUNT(*) n FROM inbox WHERE status='uncertain'").get()?.n,
    unsent: this.db.prepare('SELECT COUNT(*) n FROM outbox WHERE sent_version<version').get()?.n,
  }; }
}
export function stableId(key:string):string { return createHash('sha256').update(key).digest('hex').slice(0,32); }
