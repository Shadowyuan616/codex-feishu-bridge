import assert from 'node:assert/strict';
import test from 'node:test';
import { beforeDeadline, latestUserPrompt, orderedSessions, RecentPromptReader, uniqueSessions } from '../src/session-preview.js';

const deadline = () => Date.now() + 2_000;
const unavailable = '暂时无法读取最近提示词';
const text = (id: string, value: string) => ({ id, type: 'userMessage', content: [{ type: 'text', text: value }] });
const agent = (id: string) => ({ id, type: 'agentMessage', text: 'model progress' });
const entry = (item: unknown) => ({ turnId: 'turn-a', item });
const absent = (method: string) => Object.assign(new Error(`unknown variant '${method}'`), { code: -32600 });

test('sessions prioritize activity, preserve recency within a status, and deduplicate overlapping pages', () => {
  const sessions = [
    { id: 'idle-old', status: { type: 'idle' }, updatedAt: 2 },
    { id: 'not-loaded', status: { type: 'notLoaded' }, updatedAt: 100 },
    { id: 'active-old', status: { type: 'active' }, updatedAt: 1 },
    { id: 'idle-new', status: { type: 'idle' }, updatedAt: 5 },
    { id: 'active-new', status: { type: 'active' }, updatedAt: 3 },
    { id: 'idle-old', status: { type: 'idle' }, updatedAt: 4 },
  ];
  assert.deepEqual(orderedSessions(sessions).map(x => x.id), ['active-new', 'active-old', 'idle-new', 'idle-old', 'not-loaded']);
  assert.equal(uniqueSessions(sessions).find(x => x.id === 'idle-old')?.updatedAt, 4);
  assert.equal(sessions.length, 6);
});

test('turn history takes the final steer input and skips newer model-only goal turns', () => {
  assert.equal(latestUserPrompt([
    { items: [agent('goal-continuation')] },
    { items: [text('original', 'first prompt'), agent('progress'), text('steer', 'latest adjustment'), agent('answer')] },
    { items: [text('old', 'old turn')] },
  ]), 'latest adjustment');
});

test('the newest image, attachment, or empty input never reveals an older text prompt', () => {
  for (const [content, expected] of [
    [[{ type: 'image', url: 'data:image/png;base64,opaque' }], '（图片消息）'],
    [[{ type: 'localImage', path: '/image.png' }], '（图片消息）'],
    [[{ type: 'mention', name: 'file', path: '/file' }], '（附件或非文本消息）'],
    [[], '（空消息）'],
  ] as const) {
    assert.equal(latestUserPrompt([{ items: [text('old', 'old prompt'), { type: 'userMessage', content }] }]), expected);
  }
});

test('item history uses newest-first read pagination and returns the latest steer without resume', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const reader = new RecentPromptReader(async (method, params) => {
    calls.push({ method, params });
    return { data: [entry(agent('answer')), entry(text('steer', 'new instruction')), entry(text('original', 'old instruction'))], nextCursor: null };
  });
  assert.equal(await reader.read('thread-a', deadline()), 'new instruction');
  assert.deepEqual(calls, [{ method: 'thread/items/list', params: { threadId: 'thread-a', limit: 50, sortDirection: 'desc' } }]);
});

test('item pagination searches past tool-only pages and preserves mixed text input parts', async () => {
  const calls: Record<string, unknown>[] = [];
  const reader = new RecentPromptReader(async (method, params) => {
    assert.equal(method, 'thread/items/list'); calls.push(params);
    return params.cursor ? { data: [entry({ type: 'userMessage', id: 'prompt', content: [{ type: 'text', text: 'line 1' }, { type: 'image', url: 'opaque' }, { type: 'text', text: 'line 2' }] })], nextCursor: null }
      : { data: [entry(agent('newer-goal-output'))], nextCursor: 'older' };
  });
  assert.equal(await reader.read('thread-a', deadline()), 'line 1\nline 2');
  assert.equal(calls[1]?.cursor, 'older');
});

test('only explicit missing methods permit full-turn and legacy history fallbacks', async () => {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  const reader = new RecentPromptReader(async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/items/list') throw absent(method);
    if (method === 'thread/turns/list') return params.cursor
      ? { data: [{ items: [text('old-user', 'original'), text('steer-user', 'latest steer')] }], nextCursor: null }
      : { data: [{ items: [agent('continuation')] }], nextCursor: 'older-turn' };
    throw new Error(`Unexpected ${method}`);
  });
  assert.equal(await reader.read('thread-a', deadline()), 'latest steer');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], { method: 'thread/turns/list', params: { threadId: 'thread-a', limit: 2, sortDirection: 'desc', itemsView: 'full' } });
  assert.equal(calls[2]?.params.cursor, 'older-turn');

  const legacyCalls: string[] = [];
  const legacy = new RecentPromptReader(async (method, params) => {
    legacyCalls.push(method);
    if (method !== 'thread/read') throw Object.assign(new Error('method not found'), { code: -32601 });
    assert.deepEqual(params, { threadId: 'legacy-thread', includeTurns: true });
    return { thread: { turns: [{ items: [text('old', 'old')] }, { items: [text('new', 'latest')] }] } };
  });
  assert.equal(await legacy.read('legacy-thread', deadline()), 'latest');
  assert.deepEqual(legacyCalls, ['thread/items/list', 'thread/turns/list', 'thread/read']);
});

test('network, permission, storage, or unrelated unknown-method failures never trigger another history API', async () => {
  for (const error of [new Error('connection closed'), Object.assign(new Error('permission denied'), { code: -32000 }),
    Object.assign(new Error('storage backend does not support pagination'), { code: -32600 }), absent('another/method')]) {
    const methods: string[] = [];
    const reader = new RecentPromptReader(async method => { methods.push(method); throw error; });
    assert.equal(await reader.read('thread-a', deadline()), unavailable);
    assert.deepEqual(methods, ['thread/items/list']);
  }
});

test('an absolute deadline bounds a stalled read and an expired deadline starts no RPC', async () => {
  let requests = 0;
  const reader = new RecentPromptReader(() => { requests++; return new Promise(() => {}); });
  assert.equal(await reader.read('thread-a', Date.now() - 1), unavailable);
  assert.equal(requests, 0);
  assert.equal(await reader.read('thread-a', Date.now() + 15), unavailable);
  assert.equal(requests, 1);
  await assert.rejects(beforeDeadline(async () => 'unused', Number.NaN), /超时/);
});

test('a repeating cursor fails visibly rather than looping or displaying older guessed text', async () => {
  let calls = 0;
  const reader = new RecentPromptReader(async () => { calls++; return { data: [entry(agent(`agent-${calls}`))], nextCursor: 'same' }; });
  assert.equal(await reader.read('thread-a', deadline()), unavailable);
  assert.equal(calls, 2);
});

test('both paginated APIs have finite page bounds even when the server keeps inventing cursors', async () => {
  let itemPages = 0;
  const items = new RecentPromptReader(async () => ({ data: [], nextCursor: `item-${++itemPages}` }));
  assert.equal(await items.read('thread-a', deadline()), unavailable);
  assert.equal(itemPages, 128);
  let turnPages = 0;
  const turns = new RecentPromptReader(async method => {
    if (method === 'thread/items/list') throw absent(method);
    return { data: [], nextCursor: `turn-${++turnPages}` };
  });
  assert.equal(await turns.read('thread-a', deadline()), unavailable);
  assert.equal(turnPages, 64);
});

test('a complete history with no user message returns undefined and can reuse its newest anchor', async () => {
  let calls = 0;
  const reader = new RecentPromptReader(async () => {
    calls++;
    return { data: [entry(agent('same-anchor'))], nextCursor: calls === 1 ? null : 'would-have-more-history' };
  });
  assert.equal(await reader.read('thread-a', deadline()), undefined);
  assert.equal(await reader.read('thread-a', deadline()), undefined);
  assert.equal(calls, 2);
});

test('anchor caching avoids rescanning long goals and a new user input replaces the cached prompt', async () => {
  let phase = 0;
  const calls: Record<string, unknown>[] = [];
  const reader = new RecentPromptReader(async (_method, params) => {
    calls.push(params);
    if (phase === 0) return params.cursor
      ? { data: [entry(text('old-user', 'old prompt'))], nextCursor: null }
      : { data: [entry(agent('old-anchor'))], nextCursor: 'deep-history' };
    if (phase === 1) return { data: [entry(agent('new-anchor')), entry(agent('old-anchor'))], nextCursor: 'deep-history' };
    if (phase === 2) return { data: [entry(agent('newest-anchor')), entry(text('new-user', 'new prompt')), entry(agent('new-anchor'))], nextCursor: 'deep-history' };
    return { data: [entry(agent('newest-anchor'))], nextCursor: 'deep-history' };
  });
  assert.equal(await reader.read('thread-a', deadline()), 'old prompt');
  assert.equal(calls.length, 2);
  phase = 1;
  assert.equal(await reader.read('thread-a', deadline()), 'old prompt');
  assert.equal(calls.length, 3);
  phase = 2;
  assert.equal(await reader.read('thread-a', deadline()), 'new prompt');
  phase = 3;
  assert.equal(await reader.read('thread-a', deadline()), 'new prompt');
  assert.equal(calls.length, 5);
});

test('a failed scan does not cache an incomplete newest anchor or overwrite the last known prompt', async () => {
  let phase = 0;
  const reader = new RecentPromptReader(async (_method, params) => {
    if (phase === 0) return { data: [entry(agent('old-anchor')), entry(text('old-user', 'old prompt'))], nextCursor: null };
    if (phase === 1) {
      if (params.cursor) throw new Error('temporary failure');
      return { data: [entry(agent('incomplete-new-anchor'))], nextCursor: 'older' };
    }
    return params.cursor
      ? { data: [entry(text('new-user', 'new prompt')), entry(agent('old-anchor'))], nextCursor: null }
      : { data: [entry(agent('incomplete-new-anchor'))], nextCursor: 'older' };
  });
  assert.equal(await reader.read('thread-a', deadline()), 'old prompt');
  phase = 1;
  assert.equal(await reader.read('thread-a', deadline()), unavailable);
  phase = 2;
  assert.equal(await reader.read('thread-a', deadline()), 'new prompt');
});

test('anchor cache retains at most 128 recently used threads', async () => {
  let calls = 0;
  const reader = new RecentPromptReader(async (_method, params) => {
    calls++;
    if (params.cursor) return { data: [entry(text('user', `prompt-${params.threadId}`))], nextCursor: null };
    return { data: [entry(agent(`anchor-${params.threadId}`))], nextCursor: 'older' };
  });
  for (let i = 0; i < 129; i++) assert.equal(await reader.read(`thread-${i}`, deadline()), `prompt-thread-${i}`);
  assert.equal(calls, 258);
  assert.equal(await reader.read('thread-128', deadline()), 'prompt-thread-128');
  assert.equal(calls, 259);
  assert.equal(await reader.read('thread-0', deadline()), 'prompt-thread-0');
  assert.equal(calls, 261);
});

test('invalid history responses return an unavailable hint without fallback', async () => {
  const methods: string[] = [];
  const reader = new RecentPromptReader(async method => { methods.push(method); return { data: null }; });
  assert.equal(await reader.read('thread-a', deadline()), unavailable);
  assert.deepEqual(methods, ['thread/items/list']);
});
