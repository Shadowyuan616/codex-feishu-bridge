import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { CodexClient, CodexRpcError, type CodexServerRequest } from '../src/codex.js';

const fakeServer = `
import { createInterface } from 'node:readline';
const send = (x) => process.stdout.write(JSON.stringify(x) + '\\n');
let initialized = false, initializeCount = 0, requests = 0, held;
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') {
    initializeCount++;
    if (!m.params.capabilities.experimentalApi) process.exit(8);
    send({id:m.id,result:{userAgent:'fake'}});
  } else if (m.method === 'initialized') initialized = true;
  else if (!m.method && m.id === 0) send({method:'approval/received',params:m.result});
  else {
    requests++;
    if (!initialized) process.exit(9);
    if(m.method === 'echo') send({id:m.id,result:{value:m.params,initializeCount,pid:process.pid,requests}});
    if(m.method === 'hold') held=m;
    if(m.method === 'release') { send({id:m.id,result:'second'}); send({id:held.id,result:'first'}); }
    if(m.method === 'events') {
      send({method:'item/agentMessage/delta',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-1',delta:'你好'}});
      send({id:0,method:'item/commandExecution/requestApproval',params:{threadId:'thread-1',turnId:'turn-1',itemId:'item-2'}});
      send({id:m.id,result:{}});
    }
    if(m.method === 'error') send({id:m.id,error:{code:-32600,message:'thread already has an active writer'}});
    if(m.method === 'late') setTimeout(()=>send({id:m.id,result:'late'}),1200);
    if(m.method === 'crash') process.exit(7);
    if(m.method === 'invalid') process.stdout.write('not JSON; never treat as instructions\\n');
    if(m.method === 'oversize') process.stdout.write('x'.repeat(9*1024*1024));
  }
});
`;

async function fixture(t: TestContext, requestTimeoutMs = 1_000): Promise<CodexClient> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-bridge-test-'));
  const script = join(directory, 'fake.mjs');
  await writeFile(script, fakeServer);
  const client = new CodexClient({ binary: process.execPath, args: [script], requestTimeoutMs });
  t.after(async () => { await client.stop(); await rm(directory, { recursive: true, force: true }); });
  return client;
}

test('initializes once, waits for handshake, and does not spawn duplicate children', async (t) => {
  const client = await fixture(t);
  await assert.rejects(client.request('echo'), /not connected/);
  await Promise.all([client.start(), client.start(), client.start()]);
  const first = await client.request<any>('echo', { greeting: '你好' });
  await client.start();
  const second = await client.request<any>('echo', 42);
  assert.deepEqual(first.value, { greeting: '你好' });
  assert.equal(first.initializeCount, 1);
  assert.equal(first.pid, second.pid);
  assert.equal(client.health().connected, true);
  assert.equal(client.health().pendingRequests, 0);
});

test('matches out-of-order replies by request ID', async (t) => {
  const client = await fixture(t);
  await client.start();
  const first = client.request('hold');
  const second = client.request('release');
  assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
});

test('routes notifications and server requests separately, preserving request ID zero', async (t) => {
  const client = await fixture(t);
  await client.start();
  const notification = once(client, 'notification');
  const serverRequest = once(client, 'serverRequest');
  await client.request('events');
  const [method, params] = await notification;
  assert.equal(method, 'item/agentMessage/delta');
  assert.equal(params.delta, '你好');
  const [request] = await serverRequest as [CodexServerRequest];
  assert.equal(request.id, 0);
  assert.equal(request.method, 'item/commandExecution/requestApproval');
  const confirmation = once(client, 'notification');
  client.respond(request.id, { decision: 'decline' });
  assert.deepEqual(await confirmation, ['approval/received', { decision: 'decline' }]);
});

test('exposes RPC errors without retrying or disconnecting', async (t) => {
  const client = await fixture(t);
  await client.start();
  await assert.rejects(client.request('error'), (error: unknown) => {
    assert.ok(error instanceof CodexRpcError);
    assert.equal(error.code, -32600);
    return true;
  });
  assert.equal(client.health().connected, true);
  const state = await client.request<any>('echo');
  assert.equal(state.requests, 2);
});

test('times out without replay, ignores a late response, and remains usable', async (t) => {
  const client = await fixture(t, 500);
  await client.start();
  await assert.rejects(client.request('late'), /outcome may be unknown/);
  assert.equal(client.health().pendingRequests, 0);
  await new Promise((resolve) => setTimeout(resolve, 1250));
  const result = await client.request<any>('echo');
  assert.equal(result.requests, 2);
});

test('disconnect rejects all pending requests and only explicit start reconnects', async (t) => {
  const client = await fixture(t);
  await client.start();
  const firstPid = client.health().pid;
  let disconnects = 0;
  client.on('disconnect', () => disconnects++);
  const hanging = assert.rejects(client.request('hold'), /transport exited/);
  const crashed = assert.rejects(client.request('crash'), /transport exited/);
  await Promise.all([hanging, crashed]);
  assert.equal(disconnects, 1);
  assert.equal(client.health().connected, false);
  await assert.rejects(client.request('echo'), /not connected/);
  await client.start();
  const result = await client.request<any>('echo');
  assert.notEqual(result.pid, firstPid);
  assert.equal(result.requests, 1);
});

for (const [method, expected] of [['invalid', /invalid JSON/], ['oversize', /frame limit/]] as const) {
  test(`disconnects on ${method} protocol data without logging payloads`, async (t) => {
    const client = await fixture(t);
    await client.start();
    await assert.rejects(client.request(method), expected);
    assert.equal(client.health().connected, false);
  });
}

test('stop terminates only its transport and rejects new operations', async (t) => {
  const client = await fixture(t);
  await client.start();
  const pending = assert.rejects(client.request('hold'), /client stopped/);
  await Promise.all([client.stop(), client.stop()]);
  await pending;
  assert.equal(client.health().connected, false);
  assert.throws(() => client.respond(1, {}), /not connected/);
});

test('missing executable fails initialization rather than falling back', async () => {
  const client = new CodexClient({ binary: '/does-not-exist/codex', args: ['app-server', 'proxy'] });
  await assert.rejects(client.start(), /launch Codex/);
  assert.equal(client.health().connected, false);
  await client.stop();
});
