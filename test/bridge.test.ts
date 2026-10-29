import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import test, { type TestContext } from 'node:test';
import { Bridge, type CodexPort, type LarkPort, type Thread } from '../src/bridge.js';
import { allowedPath, type Config } from '../src/config.js';
import { Store } from '../src/store.js';

class FakeCodex extends EventEmitter implements CodexPort {
  calls: { method: string; params: any }[] = [];
  responses: { id: string | number; result: unknown }[] = [];
  threads = new Map<string, Thread>();
  failSubmit = false;
  failRespond = false;
  async request<T = any>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'thread/read' || method === 'thread/resume') {
      const thread = this.threads.get(params.threadId);
      if (!thread) throw new Error('thread not found');
      return { thread: structuredClone(thread) } as T;
    }
    if (method === 'thread/list') return {
      data: [...this.threads.values()].filter((x) => !params.cwd || params.cwd === x.cwd), nextCursor: null,
    } as T;
    if (method === 'thread/turns/list') return {
      data: [...(this.threads.get(params.threadId)?.turns || [])].reverse().slice(0, params.limit),
      nextCursor: null,
    } as T;
    if (['turn/start', 'turn/steer'].includes(method)) {
      if (this.failSubmit) throw new Error('response lost after request submission');
      return { turn: { id: params.expectedTurnId || 'new-turn-123' } } as T;
    }
    if (method === 'turn/interrupt') return {} as T;
    throw new Error(`Unexpected RPC: ${method}`);
  }
  respond(id: string | number, result: unknown): void {
    this.responses.push({ id, result });
    if (this.failRespond) throw new Error('socket closed during response');
  }
  health() { return { connected: true }; }
}

class FakeLark implements LarkPort {
  sent: { chat: string; body: Record<string, unknown>; key: string }[] = [];
  updates: { message: string; body: Record<string, unknown> }[] = [];
  failSend = false;
  async sendCard(chat: string, body: Record<string, unknown>, key: string) {
    this.sent.push({ chat, body, key });
    if (this.failSend) throw new Error('temporary send failure');
    return `receipt-${this.sent.length}`;
  }
  async updateCard(message: string, body: Record<string, unknown>) { this.updates.push({ message, body }); }
  health() { return { connected: true }; }
}

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-bridge-')));
  const root = join(base, 'allowed'); const outside = join(base, 'outside');
  const cwd = join(root, 'project');
  mkdirSync(cwd, { recursive: true }); mkdirSync(outside);
  const config: Config = {
    host: 'dev-a', stateDir: join(base, 'state'),
    allowedRoots: [root], allowedUsers: ['ou_owner', 'ou_other'],
    lark: { binary: 'fake-lark' }, codex: { binary: 'fake-codex', args: [], socketPath: join(base, 'fake.sock') },
    pollIntervalMs: 60_000,
  };
  const store = new Store(join(base, 'state.sqlite'));
  const codex = new FakeCodex(); const lark = new FakeLark();
  const thread: Thread = { id: 'session-a-123', cwd, name: 'existing session', status: { type: 'idle' }, turns: [] };
  codex.threads.set(thread.id, thread);
  codex.threads.set('session-b-123', { ...thread, id: 'session-b-123', name: 'another session' });
  const bridge = new Bridge(config, store, codex, lark);
  t.after(async () => { await bridge.stop(); store.close(); rmSync(base, { recursive: true, force: true }); });
  return { base, root, cwd, outside, config, store, codex, lark, thread, bridge };
}

async function settled(store: Store, id: string): Promise<string> {
  const until = Date.now() + 2_000;
  while (Date.now() < until) {
    const status = store.db.prepare('SELECT status FROM inbox WHERE id=?').get(id)?.status as string | undefined;
    if (status && !['received', 'processing', 'dispatching'].includes(status)) {
      await immediate(); return status;
    }
    await immediate();
  }
  throw new Error(`Inbox event ${id} did not settle`);
}

async function send(f: ReturnType<typeof fixture>, id: string, text: string, chat = 'chat-a', user = 'ou_owner') {
  f.bridge.receive({ id, text, chatId: chat, userId: user, kind: 'text' });
  return settled(f.store, id);
}

function requestApproval(f: ReturnType<typeof fixture>, id: string | number = 'approval-123') {
  f.codex.emit('serverRequest', {
    id, method: 'item/commandExecution/requestApproval',
    params: { threadId: f.thread.id, command: 'pwd', reason: 'inspect working directory', availableDecisions: ['accept', 'decline'] },
  });
  return f.store.pendingFor(f.thread.id)[0]!;
}

test('unauthorized senders are rejected before persistence or Codex calls', async (t) => {
  const f = fixture(t);
  f.bridge.receive({ id: 'intruder', text: 'run shell', userId: 'ou_intruder', chatId: 'chat-a', kind: 'text' });
  await immediate();
  assert.equal(f.store.db.prepare('SELECT id FROM inbox WHERE id=?').get('intruder'), undefined);
  assert.equal(f.codex.calls.length, 0);
  assert.equal(f.lark.sent.length, 0);
  f.store.ingest({ id: 'revoked', text: 'run shell', userId: 'ou_intruder', chatId: 'chat-a', kind: 'text' });
  await f.bridge.drain();
  assert.equal(await settled(f.store, 'revoked'), 'rejected');
});

test('duplicate inbound events cause exactly one turn submission', async (t) => {
  const f = fixture(t);
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  const event = { id: 'message-123', text: '继续原来的任务', userId: 'ou_owner', chatId: 'chat-a', kind: 'text' };
  f.bridge.receive(event); f.bridge.receive(event);
  assert.equal(await settled(f.store, event.id), 'done');
  assert.equal(f.codex.calls.filter((x) => x.method === 'turn/start').length, 1);
  f.bridge.receive(event); await f.bridge.tick();
  assert.equal(f.codex.calls.filter((x) => x.method === 'turn/start').length, 1);
});

test('restart treats dispatching input as uncertain and never replays it', async (t) => {
  const f = fixture(t);
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  f.store.ingest({ id: 'before-crash', text: '执行任务', chatId: 'chat-a', userId: 'ou_owner', kind: 'text' });
  f.store.mark('before-crash', 'dispatching', f.thread.id);
  await f.bridge.start();
  assert.equal(await settled(f.store, 'before-crash'), 'uncertain');
  assert.equal(f.codex.calls.some((x) => ['turn/start', 'turn/steer'].includes(x.method)), false);
  assert.ok(f.lark.sent.some((x) => JSON.stringify(x.body).includes('没有自动重发')));
});

test('existing-session selection preserves thread identity and original cwd', async (t) => {
  const f = fixture(t);
  assert.equal(await send(f, 'select-1', `/select ${f.thread.id}`), 'done');
  assert.deepEqual(f.store.binding('chat-a', 'ou_owner')?.cwd, f.cwd);
  assert.equal(f.store.binding('chat-a', 'ou_owner')?.thread, f.thread.id);
  const resume = f.codex.calls.find((x) => x.method === 'thread/resume');
  assert.equal(resume?.params.threadId, f.thread.id);
  assert.equal(resume?.params.cwd, undefined);
  await send(f, 'task-1', '调整当前实现');
  const turn = f.codex.calls.find((x) => x.method === 'turn/start');
  assert.equal(turn?.params.threadId, f.thread.id);
  assert.equal(turn?.params.cwd, undefined);
  assert.equal(f.codex.calls.some((x) => x.method === 'thread/start'), false);
});

test('active tasks are steered with the exact active turn ID', async (t) => {
  const f = fixture(t);
  f.thread.status = { type: 'active' };
  f.thread.turns = [{ id: 'old-turn', status: 'completed' }, { id: 'running-turn', status: 'inProgress' }];
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  await send(f, 'steer-1', '补充：保留现有数据');
  const calls = f.codex.calls.filter((x) => ['turn/start', 'turn/steer'].includes(x.method));
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, 'turn/steer');
  assert.equal(calls[0]?.params.expectedTurnId, 'running-turn');
  assert.equal(calls[0]?.params.threadId, f.thread.id);
});

test('active status without a turn ID never starts a concurrent turn', async (t) => {
  const f = fixture(t); f.thread.status = { type: 'active' };
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  assert.equal(await send(f, 'missing-turn', '继续'), 'failed');
  assert.equal(f.codex.calls.some((x) => ['turn/start', 'turn/steer'].includes(x.method)), false);
});

test('lost turn receipt remains uncertain and is not retried by polling', async (t) => {
  const f = fixture(t); f.codex.failSubmit = true;
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  assert.equal(await send(f, 'lost-receipt', '执行一次'), 'uncertain');
  await f.bridge.tick(); await f.bridge.tick();
  assert.equal(f.codex.calls.filter((x) => x.method === 'turn/start').length, 1);
});

test('traversal, sibling-prefix, and symlink escapes are rejected', async (t) => {
  const f = fixture(t);
  const link = join(f.root, 'escape'); symlinkSync(f.outside, link);
  const sibling = join(f.base, 'allowed-sibling'); mkdirSync(sibling);
  for (const path of [join(f.root, '..', 'outside'), link, sibling, join(f.root, 'missing')]) {
    assert.equal(allowedPath(path, [f.root]), false);
  }
  assert.equal(allowedPath(f.cwd, [f.root]), true);
  f.codex.threads.set('session-escape', { ...f.thread, id: 'session-escape', cwd: link });
  assert.equal(await send(f, 'escape-select', '/select session-escape'), 'failed');
  assert.equal(f.store.binding('chat-a', 'ou_owner'), undefined);
  assert.equal(f.codex.calls.some((x) => x.method === 'thread/resume'), false);
  const before = f.codex.calls.length;
  assert.equal(await send(f, 'escape-list', `/sessions ${f.root}/../outside`), 'failed');
  assert.equal(f.codex.calls.length, before);
});

test('approval binds to user, chat, thread and request ID, and duplicate clicks do not repeat', async (t) => {
  const f = fixture(t);
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  const p = requestApproval(f, 47);
  assert.ok(p.token);
  f.store.bind('chat-b', 'ou_owner', 'session-b-123', f.cwd);
  await send(f, 'wrong-user', `/approve ${p.token}`, 'chat-a', 'ou_other');
  await send(f, 'wrong-chat', `/approve ${p.token}`, 'chat-b');
  f.store.unbind('chat-b', 'ou_owner');
  f.store.bind('chat-a', 'ou_owner', 'session-b-123', f.cwd);
  await send(f, 'wrong-thread', `/approve ${p.token}`);
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  await send(f, 'wrong-token', '/approve nonexistent-token');
  assert.equal(f.codex.responses.length, 0);
  assert.equal(await send(f, 'correct-click', `/approve ${p.token}`), 'done');
  assert.deepEqual(f.codex.responses, [{ id: 47, result: { decision: 'accept' } }]);
  await send(f, 'duplicate-click', `/approve ${p.token}`);
  assert.equal(f.codex.responses.length, 1);
});

test('resolved server-request redelivery cannot reactivate its approval token', async (t) => {
  const f = fixture(t); f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  const p = requestApproval(f, 'same-rpc-id');
  await send(f, 'first-approval', `/approve ${p.token}`);
  requestApproval(f, 'same-rpc-id');
  assert.equal(f.store.pendingFor(f.thread.id).length, 0);
  await send(f, 'second-approval', `/approve ${p.token}`);
  assert.equal(f.codex.responses.length, 1);
});

test('disconnect invalidates old approval buttons before RPC IDs can be reused', async (t) => {
  const f = fixture(t); f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  const old = requestApproval(f, 1);
  f.codex.emit('disconnect');
  await send(f, 'stale-click', `/approve ${old.token}`);
  assert.equal(f.codex.responses.length, 0);
  const fresh = requestApproval(f, 1);
  assert.notEqual(fresh.token, old.token);
  await send(f, 'old-click-again', `/approve ${old.token}`);
  assert.equal(f.codex.responses.length, 0);
  await send(f, 'fresh-click', `/approve ${fresh.token}`);
  assert.deepEqual(f.codex.responses, [{ id: 1, result: { decision: 'accept' } }]);
});

test('a response transport failure never authorizes a second response attempt', async (t) => {
  const f = fixture(t); f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  const p = requestApproval(f); f.codex.failRespond = true;
  assert.equal(await send(f, 'response-failed', `/approve ${p.token}`), 'uncertain');
  await send(f, 'response-duplicate', `/approve ${p.token}`);
  assert.equal(f.codex.responses.length, 1);
});

test('malformed or incomplete user answers never reach Codex', async (t) => {
  const f = fixture(t); f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  f.codex.emit('serverRequest', { id: 'question-1', method: 'item/tool/requestUserInput', params: {
    threadId: f.thread.id, questions: [{ id: 'choice', question: '选择模式', options: [{ label: 'A', description: '第一种' }] }],
  } });
  const p = f.store.pendingFor(f.thread.id)[0]!;
  await send(f, 'bad-answer', `/answer ${p.token} {"unknown":{"answers":["A"]}}`);
  await send(f, 'bad-approval', `/approve ${p.token}`);
  assert.equal(f.codex.responses.length, 0);
  await send(f, 'good-answer', `/answer ${p.token} {"choice":{"answers":["A"]}}`);
  assert.deepEqual(f.codex.responses, [{ id: 'question-1', result: { answers: { choice: { answers: ['A'] } } } }]);
});

test('a newer progress version survives an in-flight message receipt', async (t) => {
  const f = fixture(t);
  let release!: (id: string) => void;
  f.lark.sendCard = async (chat, body, key) => {
    f.lark.sent.push({ chat, body, key });
    return new Promise<string>((resolve) => { release = resolve; });
  };
  f.store.putCard('progress', 'chat-a', { text: 'version 1' });
  const flushing = f.bridge.flush();
  f.store.putCard('progress', 'chat-a', { text: 'version 2' });
  release('progress-receipt'); await flushing;
  assert.equal(f.store.due()[0]?.version, 2);
  await f.bridge.flush();
  assert.deepEqual(f.lark.updates, [{ message: 'progress-receipt', body: { text: 'version 2' } }]);
  assert.equal(f.store.due().length, 0);
});

test('unknown and forwarded card receipts are rejected before inbox ingestion', async (t) => {
  const f = fixture(t);
  f.store.putCard('menu', 'chat-a', { text: 'menu' });
  await f.bridge.flush();
  assert.equal(f.store.hasReceipt('receipt-1', 'chat-a'), true);
  for (const [id, chatId, messageId] of [
    ['unknown-card', 'chat-a', 'unknown-receipt'],
    ['forwarded-card', 'chat-b', 'receipt-1'],
    ['missing-receipt', 'chat-a', undefined],
  ]) {
    f.bridge.receive({ id: id!, chatId: chatId!, messageId, userId: 'ou_owner', text: '/help', kind: 'action' });
    assert.equal(f.store.db.prepare('SELECT id FROM inbox WHERE id=?').get(id!), undefined);
  }
  f.bridge.receive({ id: 'valid-card', chatId: 'chat-a', messageId: 'receipt-1', userId: 'ou_owner', text: '/help', kind: 'action' });
  assert.equal(await settled(f.store, 'valid-card'), 'done');
});

test('an old session card cannot interrupt the newly selected session', async (t) => {
  const f = fixture(t);
  f.thread.status = { type: 'active' };
  f.thread.turns = [{ id: 'turn-a', status: 'inProgress' }];
  const second = f.codex.threads.get('session-b-123')!;
  second.status = { type: 'active' }; second.turns = [{ id: 'turn-b', status: 'inProgress' }];
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  await f.bridge.refresh(f.store.binding('chat-a', 'ou_owner')!, true);
  await f.bridge.flush();
  assert.ok(JSON.stringify(f.lark.sent[0]?.body).includes(`/interrupt ${f.thread.id}`));
  f.store.bind('chat-a', 'ou_owner', second.id, second.cwd);
  f.bridge.receive({ id: 'old-interrupt', chatId: 'chat-a', userId: 'ou_owner',
    kind: 'action', messageId: 'receipt-1', text: `/interrupt ${f.thread.id}` });
  assert.equal(await settled(f.store, 'old-interrupt'), 'failed');
  assert.equal(f.codex.calls.some((x) => x.method === 'turn/interrupt'), false);
  await send(f, 'current-interrupt', '/interrupt');
  const interruption = f.codex.calls.filter((x) => x.method === 'turn/interrupt');
  assert.deepEqual(interruption.map((x) => x.params), [{ threadId: second.id, turnId: 'turn-b' }]);
});

test('send failure retries with the same Feishu UUID and does not busy-loop', async (t) => {
  const f = fixture(t); f.lark.failSend = true;
  f.store.putCard('reply:event-1', 'chat-a', { text: 'answer' });
  await f.bridge.flush();
  assert.equal(f.lark.sent.length, 1);
  assert.equal(f.store.due().length, 0);
  await f.bridge.flush();
  assert.equal(f.lark.sent.length, 1);
  f.store.db.prepare('UPDATE outbox SET next_at=0').run();
  f.lark.failSend = false;
  await f.bridge.flush();
  assert.equal(f.lark.sent.length, 2);
  assert.equal(f.lark.sent[0]?.key, f.lark.sent[1]?.key);
  assert.equal(f.store.due().length, 0);
});

function progressMarkdown(f: ReturnType<typeof fixture>): string {
  const row = f.store.db.prepare('SELECT content FROM outbox WHERE key=?')
    .get(`chat-a:status:${f.thread.id}`);
  assert.equal(typeof row?.content, 'string');
  const value = JSON.parse(row!.content as string);
  return value.body.elements.filter((element: any) => element.tag === 'markdown')
    .map((element: any) => element.content).join('\n');
}

test('live output from item B is visible alongside already persisted commentary item A', async (t) => {
  const f = fixture(t);
  f.thread.status = { type: 'active' };
  f.thread.turns = [{ id: 'active-turn', status: 'inProgress', items: [
    { id: 'item-a', type: 'agentMessage', text: '先检查已有实现。' },
  ] }];
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  await f.bridge.refresh(f.store.binding('chat-a', 'ou_owner')!, true);
  assert.ok(progressMarkdown(f).includes('先检查已有实现。'));
  f.codex.emit('notification', 'item/agentMessage/delta', {
    threadId: f.thread.id, turnId: 'active-turn', itemId: 'item-b', delta: '现在开始输出新的结果。',
  });
  await f.bridge.refresh(f.store.binding('chat-a', 'ou_owner')!);
  const body = progressMarkdown(f);
  assert.ok(body.includes('先检查已有实现。'));
  assert.ok(body.includes('现在开始输出新的结果。'));
  assert.ok(body.includes('正在输出'));
});

test('long goal progress keeps the latest entire reply and pinned metadata inside the card budget', async (t) => {
  const f=fixture(t);
  const last='最新进展：最后一批文件已复制，开始校验。';
  const turn={id:'long-goal',status:'inProgress',items:[
    {id:'old',type:'agentMessage',text:'EARLIEST_HISTORY\n'+'很长的历史记录🙂\n'.repeat(3000)},
    {id:'recent',type:'agentMessage',text:last},
  ]};
  f.thread.status={type:'active'};f.thread.turns=[turn];
  f.store.bind('chat-a','ou_owner',f.thread.id,f.cwd);
  await f.bridge.refresh(f.store.binding('chat-a','ou_owner')!,true);
  const body=progressMarkdown(f);
  assert.ok(body.endsWith(last));
  assert.ok(body.includes(f.thread.id));assert.ok(body.includes(f.cwd));
  assert.ok(body.includes('较早内容已省略'));
  assert.ok(!body.includes('EARLIEST_HISTORY'));
  assert.ok(Buffer.byteLength(body)<=12_000);
  turn.items.push({id:'newest',type:'agentMessage',text:'下一次回复：校验仍在继续。'});
  await f.bridge.refresh(f.store.binding('chat-a','ou_owner')!);
  assert.ok(progressMarkdown(f).endsWith('下一次回复：校验仍在继续。'));
});

test('one oversized reply and later live output remain anchored at their latest ends', async (t) => {
  const f=fixture(t);
  f.thread.status={type:'active'};
  f.thread.turns=[{id:'long-goal',status:'inProgress',items:[
    {id:'reply',type:'agentMessage',text:'OLD_REPLY_START\n'+'过长的单条回复🙂'.repeat(3000)+'最新回复的末尾'},
  ]}];
  f.store.bind('chat-a','ou_owner',f.thread.id,f.cwd);
  await f.bridge.refresh(f.store.binding('chat-a','ou_owner')!,true);
  assert.ok(progressMarkdown(f).endsWith('最新回复的末尾'));
  assert.ok(!progressMarkdown(f).includes('OLD_REPLY_START'));
  f.codex.emit('notification','item/agentMessage/delta',{
    threadId:f.thread.id,turnId:'long-goal',itemId:'live',delta:'正在生成的最新内容🙂',
  });
  await f.bridge.refresh(f.store.binding('chat-a','ou_owner')!);
  assert.ok(progressMarkdown(f).endsWith('正在生成的最新内容🙂'));
  assert.ok(Buffer.byteLength(progressMarkdown(f))<=12_000);
});

test('a new turn with no reply still shows the last available assistant reply', async (t) => {
  const f=fixture(t);
  f.thread.status={type:'active'};
  f.thread.turns=[
    {id:'previous',status:'completed',items:[{id:'reply',type:'agentMessage',text:'最后一次回复：继续监控数据传输。'}]},
    {id:'current',status:'inProgress',items:[{id:'tool',type:'commandExecution',status:'inProgress'}]},
  ];
  f.store.bind('chat-a','ou_owner',f.thread.id,f.cwd);
  await f.bridge.refresh(f.store.binding('chat-a','ou_owner')!,true);
  assert.ok(progressMarkdown(f).endsWith('最后一次回复：继续监控数据传输。'));
  assert.ok(progressMarkdown(f).includes('状态：inProgress'));
});

test('new deltas for a partially persisted item appear and disappear from live area after persistence', async (t) => {
  const f = fixture(t);
  const item = { id: 'item-a', type: 'agentMessage', text: '回复开头' };
  const turn = { id: 'active-turn', status: 'inProgress', items: [item] };
  f.thread.status = { type: 'active' }; f.thread.turns = [turn];
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  for (const delta of ['回复开头', '，这是刚生成的新段落。']) {
    f.codex.emit('notification', 'item/agentMessage/delta', {
      threadId: f.thread.id, turnId: turn.id, itemId: item.id, delta,
    });
  }
  await f.bridge.refresh(f.store.binding('chat-a', 'ou_owner')!, true);
  assert.ok(progressMarkdown(f).includes('这是刚生成的新段落。'));
  item.text = '回复开头，这是刚生成的新段落。';
  turn.status = 'completed'; f.thread.status = { type: 'idle' };
  // Persistence can catch up before the terminal notification arrives. The
  // exact same item must not be rendered again in the live-output area.
  await f.bridge.refresh(f.store.binding('chat-a', 'ou_owner')!);
  const completed = progressMarkdown(f);
  assert.equal(completed.split(item.text).length - 1, 1);
  assert.equal(completed.includes('**正在输出**'), false);
  await f.bridge.flush();
  const sentBefore = f.lark.sent.length; const updatedBefore = f.lark.updates.length;
  f.codex.emit('notification', 'turn/completed', { threadId: f.thread.id, turnId: turn.id });
  await immediate(); await immediate();
  await f.bridge.refresh(f.store.binding('chat-a', 'ou_owner')!);
  await f.bridge.flush();
  assert.equal(f.lark.sent.length, sentBefore);
  assert.equal(f.lark.updates.length, updatedBefore);
  const answerCards = f.lark.sent.filter((row) => String((row.body.header as any)?.title?.content).includes('回答'));
  assert.equal(answerCards.length, 1);
});

test('live text from a previous turn cannot leak into a later active turn', async (t) => {
  const f = fixture(t);
  f.thread.status = { type: 'active' };
  f.thread.turns = [{ id: 'new-turn', status: 'inProgress', items: [] }];
  f.store.bind('chat-a', 'ou_owner', f.thread.id, f.cwd);
  f.codex.emit('notification', 'item/agentMessage/delta', {
    threadId: f.thread.id, turnId: 'old-turn', itemId: 'old-item', delta: '旧轮次中不应展示的内容',
  });
  await f.bridge.refresh(f.store.binding('chat-a', 'ou_owner')!, true);
  assert.equal(progressMarkdown(f).includes('旧轮次中不应展示的内容'), false);
});

test('stop blocks new inbound work and waits for an in-flight send receipt', async (t) => {
  const f = fixture(t);
  let release!: (receipt: string) => void;
  f.lark.sendCard = async (chat, body, key) => {
    f.lark.sent.push({ chat, body, key });
    return new Promise<string>((resolve) => { release = resolve; });
  };
  f.store.putCard('first', 'chat-a', { text: 'in-flight' });
  f.store.putCard('second', 'chat-a', { text: 'must remain queued' });
  const flushing = f.bridge.flush();
  assert.equal(f.lark.sent.length, 1);
  let stopped = false;
  const stopping = f.bridge.stop().then(() => { stopped = true; });
  f.bridge.receive({ id: 'after-stop', text: '不要处理', chatId: 'chat-a', userId: 'ou_owner', kind: 'message' });
  await immediate();
  assert.equal(stopped, false);
  assert.equal(f.store.db.prepare('SELECT id FROM inbox WHERE id=?').get('after-stop'), undefined);
  release('last-receipt');
  await flushing; await stopping;
  assert.equal(stopped, true);
  assert.equal(f.store.hasReceipt('last-receipt', 'chat-a'), true);
  assert.equal(f.store.due().length, 1);
  assert.equal(f.lark.sent.length, 1);
  await f.bridge.tick(); await f.bridge.drain(); await f.bridge.flush();
  assert.equal(f.lark.sent.length, 1);
  assert.equal(f.codex.calls.length, 0);
  await f.bridge.stop();
});
