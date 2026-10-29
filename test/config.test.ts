import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { loadConfig } from '../src/config.js';

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-config-')));
  const root = join(base, 'projects'); mkdirSync(root);
  const path = join(base, 'config.local.json');
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const valid = () => ({
    host: 'dev-a', stateDir: join(base, 'state'),
    allowedUsers: ['ou_owner123'], allowedRoots: [root],
    lark: { binary: '/usr/local/bin/lark-cli', profile: 'test-profile' },
    codex: { binary: '/usr/local/bin/codex', args: [] as string[], socketPath: join(base, 'codex.sock') },
    pollIntervalMs: 10000,
  });
  const read = (value: unknown) => { writeFileSync(path, JSON.stringify(value)); return loadConfig(path); };
  return { base, root, valid, read };
}

test('shared-daemon configuration uses an absolute socket without spawning proxy', (t) => {
  const f = fixture(t); const c = f.read(f.valid());
  assert.equal(c.codex.socketPath, join(f.base, 'codex.sock'));
  assert.deepEqual(c.codex.args, []);
  assert.deepEqual(c.allowedUsers, ['ou_owner123']);
  // Config validation does not claim the socket exists or the daemon is healthy.
});

test('allowedUsers rejects an empty list, wildcards and unedited placeholders', (t) => {
  const f = fixture(t);
  for (const allowedUsers of [[], ['*'], ['ou_*'], ['owner'], ['ou_'], ['ou_REPLACE_WITH_YOUR_OPEN_ID'], ['ou_owner123', '*']]) {
    assert.throws(() => f.read({ ...f.valid(), allowedUsers }), /allowedUsers/);
  }
  assert.throws(() => f.read({ ...f.valid(), allowedUsers: 'ou_owner123' }), /allowedUsers/);
});

test('allowedRoots must be a nonempty list of existing absolute directories', (t) => {
  const f = fixture(t);
  const regularFile = join(f.base, 'not-a-directory'); writeFileSync(regularFile, 'text');
  for (const allowedRoots of [[], ['projects'], [join(f.base, 'missing')], [regularFile]]) {
    assert.throws(() => f.read({ ...f.valid(), allowedRoots }));
  }
  assert.throws(() => f.read({ ...f.valid(), allowedRoots: f.root }));
});

test('configured root symlinks are canonicalized before authorization checks', (t) => {
  const f = fixture(t); const alias = join(f.base, 'project-alias'); symlinkSync(f.root, alias);
  assert.deepEqual(f.read({ ...f.valid(), allowedRoots: [alias] }).allowedRoots, [f.root]);
});

test('shared socket paths must be absolute', (t) => {
  const f = fixture(t);
  for (const socketPath of ['codex.sock', './codex.sock', '../codex.sock', '~/codex.sock']) {
    const value = f.valid(); value.codex.socketPath = socketPath;
    assert.throws(() => f.read(value), /socketPath/);
  }
});

test('raw proxy is not accepted as a JSONL transport', (t) => {
  const f = fixture(t);
  for (const args of [['app-server', 'proxy'], ['app-server', 'proxy', '--stdio']]) {
    const value = { ...f.valid(), codex: { binary: '/usr/local/bin/codex', args } };
    assert.throws(() => f.read(value));
  }
});

test('independent stdio must be selected explicitly', (t) => {
  const f = fixture(t);
  const value = { ...f.valid(), codex: { binary: '/usr/local/bin/codex', args: ['app-server', '--stdio'] } };
  assert.deepEqual(f.read(value).codex.args, ['app-server', '--stdio']);
  for (const args of [[], ['app-server']]) {
    assert.throws(() => f.read({ ...value, codex: { binary: value.codex.binary, args } }));
  }
});

test('invalid host, state paths and tight polling intervals are rejected', (t) => {
  const f = fixture(t);
  for (const host of ['', '../host', 'host name', 'host\nname']) {
    assert.throws(() => f.read({ ...f.valid(), host }), /host/);
  }
  assert.throws(() => f.read({ ...f.valid(), stateDir: './state' }), /stateDir/);
  for (const pollIntervalMs of [0, 999, -100, '10000']) {
    assert.throws(() => f.read({ ...f.valid(), pollIntervalMs }), /pollIntervalMs/);
  }
  const value: Record<string, unknown> = f.valid(); delete value.pollIntervalMs;
  assert.equal(f.read(value).pollIntervalMs, 10000);
});
