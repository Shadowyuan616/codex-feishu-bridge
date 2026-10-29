import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { SocketCodexClient } from '../src/codex-socket.js';

async function fixture(t: TestContext) {
  // macOS Unix socket paths have a short length limit; do not use long TMPDIR.
  const dir = await mkdtemp('/tmp/codex-ws-');
  const path = join(dir, 'control socket.sock');
  const http = createServer();
  const server = new WebSocketServer({ noServer: true });
  const clients: SocketCodexClient[] = [];
  let connections = 0, turns = 0;
  const messages: any[] = [];
  http.on('upgrade', (request, socket, head) => {
    server.handleUpgrade(request, socket, head, (ws) => server.emit('connection', ws));
  });
  server.on('connection', (ws: WebSocket) => {
    connections++;
    let initialized = false;
    ws.on('message', (raw) => {
      const m = JSON.parse(raw.toString()); messages.push(m);
      const reply = (result: unknown) => ws.send(JSON.stringify({ id: m.id, result }));
      if (m.method === 'initialize') { assert.equal(m.params.capabilities.experimentalApi, true); reply({ userAgent: 'test' }); }
      else if (m.method === 'initialized') initialized = true;
      else if (m.method) {
        assert.equal(initialized, true);
        if (m.method === 'thread/list') reply({ data: [{ id: 'thread-1', cwd: '/tmp' }] });
        if (m.method === 'turn/start') { turns++; reply({ turn: { id: 'turn-1' } }); }
        if (m.method === 'approval') {
          ws.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', delta: '你好' } }));
          ws.send(JSON.stringify({ id: 0, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } }));
          reply({});
        }
        if (m.method === 'crash') ws.terminate();
        if (m.method === 'invalid') ws.send('not JSON');
      } else if (m.id === 0) ws.send(JSON.stringify({ method: 'approved', params: m.result }));
    });
  });
  await new Promise<void>((resolve, reject) => { http.once('error', reject); http.listen(path, resolve); });
  t.after(async () => {
    await Promise.all(clients.map((client) => client.stop()));
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await new Promise<void>((resolve) => http.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  return { messages, http, get connections() { return connections; }, get turns() { return turns; },
    client(timeout = 1_000) { const client = new SocketCodexClient({ socketPath: path, requestTimeoutMs: timeout }); clients.push(client); return client; } };
}

test('Unix WebSocket handshake and thread/list use one connection and support spaces in socket path', async (t) => {
  const f = await fixture(t), client = f.client();
  await Promise.all([client.start(), client.start()]);
  const result = await client.request<{ data: { id: string }[] }>('thread/list', { limit: 1 });
  assert.equal(result.data[0]?.id, 'thread-1');
  assert.equal(f.connections, 1);
  assert.equal(client.health().transport, 'unix-websocket');
});

test('Unix WebSocket separates notifications and ID-zero approval requests', async (t) => {
  const f = await fixture(t), client = f.client();
  await client.start();
  const notification = once(client, 'notification'), approval = once(client, 'serverRequest');
  await client.request('approval');
  assert.equal((await notification)[1].delta, '你好');
  const [request] = await approval;
  assert.equal(request.id, 0);
  const resolved = once(client, 'notification');
  client.respond(request.id, { decision: 'decline' });
  assert.deepEqual(await resolved, ['approved', { decision: 'decline' }]);
});

test('two clients share daemon and stopping one leaves daemon and other client usable', async (t) => {
  const f = await fixture(t), first = f.client(), second = f.client();
  await Promise.all([first.start(), second.start()]);
  await first.request('turn/start', { threadId: 'thread-1', input: [] });
  await first.stop();
  assert.equal(f.http.listening, true);
  assert.equal(second.health().connected, true);
  await second.request('thread/list');
  await second.request('turn/start', { threadId: 'thread-1', input: [] });
  assert.equal(f.turns, 2);
});

test('Unix socket timeout does not replay and disconnect requires explicit reconnect', async (t) => {
  const f = await fixture(t), client = f.client(500);
  await client.start();
  await assert.rejects(client.request('never'), /outcome may be unknown/);
  assert.equal(f.messages.filter((m) => m.method === 'never').length, 1);
  const pending = assert.rejects(client.request('never'), /closed/);
  await assert.rejects(client.request('crash'), /closed/);
  await pending;
  assert.equal(client.health().connected, false);
  assert.equal(f.connections, 1);
  await client.start();
  await client.request('thread/list');
  assert.equal(f.connections, 2);
  assert.equal(f.messages.filter((m) => m.method === 'never').length, 2);
});

test('Unix socket rejects invalid frames and missing socket without stdio fallback', async (t) => {
  const f = await fixture(t), client = f.client();
  await client.start();
  await assert.rejects(client.request('invalid'), /invalid JSON/);
  const missing = new SocketCodexClient({ socketPath: '/tmp/codex-does-not-exist.sock', requestTimeoutMs: 200 });
  await assert.rejects(missing.start(), /transport failed/);
  await missing.stop();
});
