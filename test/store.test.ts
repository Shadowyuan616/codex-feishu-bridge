import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Store, stableId, type Pending } from '../src/store.js';

const event = (id: string) => ({ id, chatId: 'chat-a', userId: 'ou_owner', text: '继续任务', kind: 'text' });
const pending = (overrides: Partial<Pending> = {}): Pending => ({
  token: 'token-a', requestId: '"rpc-a"', method: 'item/commandExecution/requestApproval',
  thread: 'thread-a', chat: 'chat-a', user: 'ou_owner', params: '{"command":"pwd"}',
  status: 'pending', ...overrides,
});

test('inbox survives reopening and only deduplicates an identical event ID', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feishu-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.sqlite');
  let store = new Store(path);
  assert.equal(store.ingest(event('message-1')), true);
  assert.equal(store.ingest(event('message-1')), false);
  store.close();
  store = new Store(path);
  t.after(() => store.close());
  assert.equal(store.ingest(event('message-1')), false);
  assert.equal(store.ingest(event('message-2')), true);
  assert.deepEqual(store.queued().map((x) => x.id), ['message-1', 'message-2']);
});

test('recovery never requeues a potentially submitted command', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  for (const id of ['sent-before-crash', 'not-yet-submitted', 'already-done']) store.ingest(event(id));
  store.mark('sent-before-crash', 'dispatching', 'thread-a');
  store.mark('not-yet-submitted', 'processing');
  store.mark('already-done', 'done');
  store.pending(pending());
  const recovered = store.recover();
  assert.deepEqual(recovered.map((x) => x.id), ['sent-before-crash']);
  assert.deepEqual(store.queued().map((x) => x.id), ['not-yet-submitted']);
  assert.equal(store.db.prepare('SELECT status FROM inbox WHERE id=?').get('sent-before-crash')?.status, 'uncertain');
  assert.equal(store.getPending('token-a')?.status, 'stale');
});

test('one thread has one controlling chat and user', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.bind('chat-a', 'ou_owner', 'thread-a', '/workspace/a');
  assert.throws(() => store.bind('chat-b', 'ou_owner', 'thread-a', '/workspace/a'));
  assert.throws(() => store.bind('chat-a', 'ou_other', 'thread-a', '/workspace/a'));
  store.unbind('chat-a', 'ou_owner');
  store.bind('chat-b', 'ou_other', 'thread-a', '/workspace/a');
  assert.equal(store.binding('chat-b', 'ou_other')?.thread, 'thread-a');
});

test('direct chat routes persist across reopening and unbinding', t=>{
  const dir=mkdtempSync(join(tmpdir(),'feishu-p2p-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const path=join(dir,'state.sqlite');let store=new Store(path);
  store.rememberDirectChat('ou_owner','oc_owner');store.bind('oc_owner','ou_owner','thread-a','/workspace');
  store.unbind('oc_owner','ou_owner');store.close();store=new Store(path);t.after(()=>store.close());
  assert.equal(store.directChat('ou_owner'),'oc_owner');
  store.rememberDirectChat('ou_owner','oc_new');assert.equal(store.directChat('ou_owner'),'oc_new');
  assert.throws(()=>store.rememberDirectChat('ou_owner','chat-invalid'));
});

test('old p2p bindings or ingress can seed routing, while menu destinations and ambiguous chats cannot', t=>{
  const store=new Store(':memory:');t.after(()=>store.close());
  store.bind('oc_binding','ou_bound','thread-a','/workspace');assert.equal(store.directChat('ou_bound'),'oc_binding');
  store.ingest({id:'old-p2p',chatId:'oc_message',userId:'ou_known',text:'/help',kind:'message'});
  store.ingest({id:'old-card',chatId:'oc_card',userId:'ou_card',text:'/help',kind:'action'});
  store.ingest({id:'menu-payload',chatId:'oc_untrusted',userId:'ou_new',text:'/more',kind:'menu'});
  assert.equal(store.directChat('ou_known'),'oc_message');assert.equal(store.directChat('ou_card'),'oc_card');
  assert.equal(store.directChat('ou_new'),undefined);
  store.ingest({id:'ambiguous-a',chatId:'oc_a',userId:'ou_ambiguous',text:'/help',kind:'message'});
  store.ingest({id:'ambiguous-b',chatId:'oc_b',userId:'ou_ambiguous',text:'/help',kind:'message'});
  assert.equal(store.directChat('ou_ambiguous'),undefined);
  store.routeMenu('menu-payload','oc_resolved');
  assert.equal(store.db.prepare('SELECT chat FROM inbox WHERE id=?').get('menu-payload')?.chat,'oc_resolved');
  assert.throws(()=>store.routeMenu('menu-payload',''));
});

test('delivery acknowledgement does not drop a newer card version', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.putCard('progress', 'chat-a', { text: 'version 1' });
  const first = store.due()[0]!;
  store.putCard('progress', 'chat-a', { text: 'version 2' });
  store.sent(first, 'receipt-a');
  const next = store.due()[0]!;
  assert.equal(next.version, 2);
  assert.equal(next.sent_version, 1);
  assert.equal(next.message, 'receipt-a');
  assert.deepEqual(JSON.parse(next.content), { text: 'version 2' });
  store.sent(next, 'receipt-a');
  assert.equal(store.due().length, 0);
});

test('identical content does not repeatedly enqueue or reset delivery state', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.putCard('progress', 'chat-a', { text: 'same' });
  const first = store.due()[0]!;
  store.sent(first, 'receipt-a');
  store.putCard('progress', 'chat-a', { text: 'same' });
  assert.equal(store.due().length, 0);
});

test('moving a card key to another chat cannot update the old chat receipt', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.putCard('status:thread-a', 'chat-a', { text: 'private A' });
  store.sent(store.due()[0]!, 'receipt-in-chat-a');
  store.putCard('status:thread-a', 'chat-b', { text: 'private B' });
  const next = store.due()[0]!;
  assert.equal(next.chat, 'chat-b');
  assert.equal(next.message, null);
  assert.deepEqual(JSON.parse(next.content), { text: 'private B' });
});

test('a late receipt from the old chat cannot attach to the new destination', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.putCard('status:thread-a', 'chat-a', { text: 'private A' });
  const inFlight = store.due()[0]!;
  store.putCard('status:thread-a', 'chat-b', { text: 'private B' });
  store.sent(inFlight, 'receipt-in-chat-a');
  const next = store.due()[0]!;
  assert.equal(next.chat, 'chat-b');
  assert.equal(next.message, null);
});

test('outbox retries back off while preserving the stable delivery identity', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.putCard('reply:message-1:0', 'chat-a', { text: 'response' });
  const first = store.due()[0]!;
  const now = first.created;
  const identity = stableId(first.key);
  store.retry(first, 'network error', now);
  assert.equal(store.due(now + 999).length, 0);
  const retry = store.due(now + 1000)[0]!;
  assert.equal(stableId(retry.key), identity);
  assert.equal(retry.attempts, 1);
  store.retry(retry, 'network error', now + 1000);
  assert.equal(store.due(now + 2999).length, 0);
  assert.equal(store.due(now + 3000)[0]?.attempts, 2);
  assert.match(identity, /^[a-f0-9]{32}$/);
  assert.notEqual(identity, stableId('reply:message-2:0'));
});

test('unacknowledged new messages stop retrying past the bounded dedup window', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.putCard('reply:message-1:0', 'chat-a', { text: 'response' });
  const first = store.due()[0]!;
  store.retry(first, 'receipt unknown', first.created + 51 * 60_000);
  assert.equal(store.due(first.created + 7 * 24 * 60 * 60_000).length, 0);
  assert.equal(store.health().unsent, 1);
});

test('new progress content cannot silently unfreeze an expired ambiguous delivery', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.putCard('status:thread-a', 'chat-a', { text: 'progress 1' });
  const first = store.due()[0]!;
  const now = first.created + 51 * 60_000;
  store.retry(first, 'receipt unknown', now);
  store.putCard('status:thread-a', 'chat-a', { text: 'progress 2' });
  assert.equal(store.due(now).length, 0);
  assert.equal(store.health().unsent, 1);
});

test('repeated server requests cannot reactivate an already resolved approval', (t) => {
  const store = new Store(':memory:'); t.after(() => store.close());
  store.pending(pending());
  store.finishPending('token-a');
  const duplicate = store.pending(pending({ token: 'token-b' }));
  assert.notEqual(duplicate.status, 'pending');
  assert.equal(store.pendingFor('thread-a').length, 0);
});
