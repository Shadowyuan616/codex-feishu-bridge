import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { acquireInstanceLock } from '../src/instance-lock.js';

test('instance lock excludes another connection, releases idempotently, and leaves application DB writable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-instance-'));
  let release: (() => void) | undefined;
  try {
    release = acquireInstanceLock(directory);
    assert.throws(() => acquireInstanceLock(directory), /实例锁/);
    const application = new DatabaseSync(join(directory, 'state.sqlite'));
    try {
      application.exec('CREATE TABLE application_data(value TEXT); INSERT INTO application_data VALUES (\'ok\');');
      assert.equal(application.prepare('SELECT value FROM application_data').get()?.value, 'ok');
    } finally { application.close(); }
    release(); release();
    release = acquireInstanceLock(directory);
  } finally {
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});

test('OS releases the instance lock after a holder crashes without cleanup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-instance-crash-'));
  const moduleUrl = pathToFileURL(resolve('src/instance-lock.ts')).href;
  const script = `import {acquireInstanceLock} from ${JSON.stringify(moduleUrl)};
const release=acquireInstanceLock(process.argv[1]);
process.once('SIGTERM',()=>{release();process.exit(0)});
process.stdout.write('locked\\n');
setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, directory], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  let release: (() => void) | undefined;
  try {
    const ready = once(child.stdout, 'data');
    const exited = once(child, 'exit');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try {
      const [data] = await ready;
      assert.match(data.toString(), /locked/);
      assert.throws(() => acquireInstanceLock(directory), /实例锁/);
      child.kill('SIGKILL');
      await exited;
      release = acquireInstanceLock(directory);
    } finally { clearTimeout(timer); }
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await once(child, 'exit');
    }
    release?.();
    await rm(directory, { recursive: true, force: true });
  }
});
