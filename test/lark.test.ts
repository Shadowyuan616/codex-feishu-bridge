import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LarkCli, LarkCliError, normalizeEvent } from '../src/lark.js';

const message = { type: 'im.message.receive_v1', event_id: 'evt_1', message_id: 'om_one', chat_id: 'oc_one',
  chat_type: 'p2p', sender_id: 'ou_owner', message_type: 'text', content: 'hello $HOME `touch /tmp/no`' };
const action = { type: 'card.action.trigger', event_id: 'evt_2', message_id: 'om_card', chat_id: 'oc_one',
  operator_id: 'ou_owner', action_tag: 'button', action_value: '{"command":"/status"}' };

test('normalizes CLI text literally without double decoding', () => {
  assert.deepEqual(normalizeEvent(message), { id: 'evt_1', chatId: 'oc_one', userId: 'ou_owner',
    text: message.content, kind: 'message', messageId: 'om_one' });
  assert.equal(normalizeEvent({ ...message, event_id: undefined })?.id, 'om_one');
  assert.equal(normalizeEvent({ ...message, content: '{"text":"literal JSON text"}' })?.text, '{"text":"literal JSON text"}');
});

test('ignores groups, unsupported content and events without a deduplication ID', () => {
  for (const invalid of [null, [], {}, { ...message, chat_type: 'group' }, { ...message, message_type: 'post' },
    { ...message, event_id: undefined, message_id: undefined }, { ...message, sender_id: '' }, { ...message, content: '' }]) {
    assert.equal(normalizeEvent(invalid), null);
  }
});

test('card clicks require distinct event IDs and a button command', () => {
  assert.equal(normalizeEvent(action)?.text, '/status');
  assert.equal(normalizeEvent({ ...action, event_id: 'evt_3' })?.id, 'evt_3');
  for (const invalid of [{ ...action, event_id: undefined }, { ...action, action_tag: 'input' },
    { ...action, action_value: '{"command":"rm -rf"}' }, { ...action, action_value: 'invalid' },
    { ...action, action_value: { command: '/status' } }, { ...action, chat_type: 'group' }]) assert.equal(normalizeEvent(invalid), null);
});

async function fixture(source: string): Promise<{ directory: string; binary: string; clean: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-feishu-lark-'));
  const binary = join(directory, 'fake-lark');
  await writeFile(binary, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  return { directory, binary, clean: () => rm(directory, { recursive: true, force: true }) };
}

const waitFor = async (predicate: () => boolean, ms = 2_000): Promise<void> => {
  const until = Date.now() + ms;
  while (!predicate()) { if (Date.now() >= until) throw new Error('condition timed out'); await new Promise(resolve => setTimeout(resolve, 10)); }
};

test('waits for both consumers, keeps stdin open and stops only its children', async () => {
  const f = await fixture(`
const fs = require('node:fs');
const args = process.argv.slice(2); fs.appendFileSync('calls.ndjson', JSON.stringify(args)+'\\n');
const key = args[args.indexOf('consume')+1];
process.stdin.resume(); process.stdin.on('end', () => process.exit(0));
setTimeout(() => {
  process.stderr.write('[event] ready event_key='+key+'\\n');
  if (key==='im.message.receive_v1') setTimeout(() => process.stdout.write(JSON.stringify(${JSON.stringify(message)})+'\\n'), 20);
}, 25);
`);
  const received: string[] = [];
  const logs: unknown[] = [];
  const cli = new LarkCli({ binary: f.binary, cwd: f.directory, profile: 'test', startupTimeoutMs: 2_000 }, (event, detail) => logs.push({ event, detail }));
  try {
    await cli.start(event => received.push(event.id));
    await waitFor(() => received.length === 1);
    assert.deepEqual(received, ['evt_1']);
    assert.equal((cli.health() as { ready: boolean }).ready, true);
    await cli.stop();
    const calls = (await readFile(join(f.directory, 'calls.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert(calls.every(args => args.includes('consume') && !args.includes('stop')));
    assert(!JSON.stringify(logs).includes(message.content));
  } finally { await cli.stop(); await f.clean(); }
});

test('card sends preserve argv and idempotency; patches use stdin', async () => {
  const f = await fixture(`
const fs = require('node:fs'); const args = process.argv.slice(2); let input='';
process.stdin.on('data', c => input+=c);
process.stdin.on('end', () => {
 fs.appendFileSync('calls.ndjson',JSON.stringify({args,input})+'\\n');
 process.stdout.write(JSON.stringify(args.includes('+messages-send') ? {ok:true,data:{message_id:'om_receipt'}} : {code:0,data:{}}));
});

`);
  const cli = new LarkCli({ binary: f.binary, cwd: f.directory });
  const card = { schema: '2.0', body: { elements: [{ tag: 'markdown', content: 'hello `command` $HOME\nquote "' }] } };
  try {
    assert.equal(await cli.sendCard('oc_target', card, 'same-retry-key'), 'om_receipt');
    await cli.updateCard('om_receipt', card);
    const calls = (await readFile(join(f.directory, 'calls.ndjson'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.equal(calls[0].args[calls[0].args.indexOf('--content') + 1], JSON.stringify(card));
    assert.equal(calls[0].args[calls[0].args.indexOf('--idempotency-key') + 1], 'same-retry-key');
    assert.deepEqual(calls[1].args.slice(0, 3), ['api', 'PATCH', '/open-apis/im/v1/messages/om_receipt']);
    assert.deepEqual(JSON.parse(calls[1].input), { content: JSON.stringify(card) });
    await assert.rejects(cli.updateCard('om_bad/../../x', card), /Invalid/);
  } finally { await f.clean(); }
});

test('buffers events while waiting for the independent stderr ready marker', async () => {
  const f = await fixture(`
const key=process.argv[process.argv.indexOf('consume')+1]; process.stdin.resume();
process.stdin.on('end',()=>process.exit(0));
if(key==='im.message.receive_v1')process.stdout.write(JSON.stringify(${JSON.stringify(message)})+'\\n');
setTimeout(()=>process.stderr.write('[event] ready event_key='+key+'\\n'),50);
`);
  const cli = new LarkCli({ binary: f.binary, startupTimeoutMs: 2_000 });
  const received: string[] = [];
  try {
    await cli.start(event => received.push(event.id));
    await waitFor(() => received.length === 1);
    assert.deepEqual(received, ['evt_1']);
  } finally { await cli.stop(); await f.clean(); }
});

test('successful sends without a receipt and API business errors are rejected', async () => {
  const f = await fixture(`
process.stdout.write(JSON.stringify(process.argv.includes('+messages-send')?{ok:true,data:{}}:{code:99991672,msg:'SECRET'}));
`);
  const cli = new LarkCli({ binary: f.binary });
  try {
    await assert.rejects(cli.sendCard('oc_target', {}, 'key'), /no message ID receipt/);
    await assert.rejects(cli.updateCard('om_card', {}), error => error instanceof LarkCliError && !error.message.includes('SECRET'));
  } finally { await f.clean(); }
});

test('nonzero and zero-exit structured auth failures are raised without secret text', async () => {
  const f = await fixture(`
const error = {ok:false,error:{type:'auth',subtype:'missing_scope',message:'SECRET MUST NOT BE LOGGED',missing_scopes:['im:message:send_as_bot']}};
process.stderr.write(JSON.stringify(error));process.exit(0);
`);
  const cli = new LarkCli({ binary: f.binary });
  try {
    await assert.rejects(cli.sendCard('oc_target', {}, 'key'), (error: unknown) => {
      assert(error instanceof LarkCliError);
      assert.equal(error.subtype, 'missing_scope');
      assert.deepEqual(error.missingScopes, ['im:message:send_as_bot']);
      assert.equal(error.retryable, false);
      assert(!error.message.includes('SECRET'));
      return true;
    });
  } finally { await f.clean(); }
});

test('auth startup failure rejects promptly and never calls auth login', async () => {
  const f = await fixture(`
const fs=require('node:fs'); fs.appendFileSync('calls.ndjson',JSON.stringify(process.argv.slice(2))+'\\n');
process.stderr.write(JSON.stringify({ok:false,error:{type:'auth',subtype:'missing_scope'}})); process.exit(3);
`);
  const cli = new LarkCli({ binary: f.binary, cwd: f.directory, restartBaseMs: 10, startupTimeoutMs: 2_000 });
  try {
    await assert.rejects(cli.start(() => {}), LarkCliError);
    const calls = await readFile(join(f.directory, 'calls.ndjson'), 'utf8');
    assert(!calls.includes('login'));
    assert.equal((cli.health() as { running: boolean }).running, false);
  } finally { await cli.stop(); await f.clean(); }
});

test('missing ready marker has a bounded startup failure', async () => {
  const f = await fixture(`process.stdin.resume(); process.stdin.on('end',()=>process.exit(0));`);
  const cli = new LarkCli({ binary: f.binary, startupTimeoutMs: 50 });
  try { await assert.rejects(cli.start(() => {}), /ready timeout/); }
  finally { await cli.stop(); await f.clean(); }
});

test('unexpected runtime exits reconnect with a finite retry budget', async () => {
  const f = await fixture(`
const key=process.argv[process.argv.indexOf('consume')+1]; process.stdin.resume();
process.stderr.write('[event] ready event_key='+key+'\\n'); setTimeout(()=>process.exit(4),30);
`);
  const cli = new LarkCli({ binary: f.binary, restartBaseMs: 10, restartMaxMs: 20, maxRestarts: 1, startupTimeoutMs: 2_000 });
  try {
    await cli.start(() => {});
    await waitFor(() => (cli.health() as { consumers: { permanent: boolean }[] }).consumers.every(c => c.permanent));
    const health = cli.health() as { consumers: { failures: number }[] };
    assert(health.consumers.every(c => c.failures === 2));
  } finally { await cli.stop(); await f.clean(); }
});
