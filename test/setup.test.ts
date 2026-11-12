import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { configure } from '../src/setup.js';
import { loadConfig } from '../src/config.js';

async function fixture(t:TestContext) {
  const base=mkdtempSync(join(tmpdir(),'bridge-install-')),project=join(base,'project space'),socket=join(base,'control.sock');
  mkdirSync(project);const server=createServer();
  await new Promise<void>((done,reject)=>{server.once('error',reject);server.listen(socket,done);});
  t.after(async()=>{await new Promise<void>(done=>server.close(()=>done()));rmSync(base,{recursive:true,force:true});});
  const output=join(base,'private'),repo=resolve('.');
  const args=['--host','dev-a','--root',project,'--user','ou_owner123','--socket',socket,'--state-dir',join(base,'state'),
    '--profile','existing-profile','--output',output,'--lark-bin',process.execPath,'--codex-bin',process.execPath,'--python-bin',process.execPath];
  return {base,project,socket,output,repo,args};
}

test('configuration generator creates private working config, exact menu identity and service environment',async t=>{
  const f=await fixture(t),paths=configure(f.args,f.repo);
  assert.equal(paths.length,3);
  assert.equal(statSync(f.output).mode&0o777,0o700);
  for(const path of paths)assert.equal(statSync(path).mode&0o777,0o600);
  const config=loadConfig(paths[0]!);
  assert.equal(config.codex.socketPath,f.socket);assert.deepEqual(config.allowedUsers,['ou_owner123']);
  assert.equal(config.lark.profile,'existing-profile');assert.deepEqual(config.codex.args,[]);
  const menu=JSON.parse(readFileSync(paths[2]!,'utf8'));
  assert.equal(menu.user_id,'ou_owner123');assert.equal(menu.bot_menu.bot_menu_items.length,4);
  assert.equal(menu.bot_menu.bot_menu_items[2].behaviors[0].event_key,'codex_status');
  const env=readFileSync(paths[1]!,'utf8');assert.ok(env.includes(`BRIDGE_CONFIG="${paths[0]}"`));
  assert.ok(env.includes(`BRIDGE_NODE="${process.execPath}"`));
});

test('rerunning setup cannot overwrite configuration or follow an output symlink',async t=>{
  const f=await fixture(t),paths=configure(f.args,f.repo),before=paths.map(p=>readFileSync(p,'utf8'));
  assert.throws(()=>configure(f.args,f.repo),/已有配置/);
  assert.deepEqual(paths.map(p=>readFileSync(p,'utf8')),before);
  const alias=join(f.base,'alias');symlinkSync(f.output,alias);
  assert.throws(()=>configure(f.args.map(x=>x===f.output?alias:x),f.repo),/符号链接/);
});

test('setup rejects public output, missing socket, placeholders, and unknown flags without writing files',async t=>{
  const f=await fixture(t),publicDir=join(f.base,'public');mkdirSync(publicDir,{mode:0o755});
  // Service environments use umask 0077; make the unsafe fixture explicit.
  chmodSync(publicDir,0o755);
  assert.throws(()=>configure(f.args.map(x=>x===f.output?publicDir:x),f.repo),/700/);
  const file=join(f.base,'regular-file');writeFileSync(file,'not a socket');
  assert.throws(()=>configure(f.args.map(x=>x===f.socket?file:x),f.repo),/socket/);
  assert.throws(()=>configure(f.args.map(x=>x==='ou_owner123'?'ou_REPLACE_WITH_YOUR_OPEN_ID':x),f.repo),/allowedUsers/);
  assert.throws(()=>configure([...f.args,'--app-secret','do-not-accept-secrets'],f.repo),/参数无效/);
  assert.throws(()=>statSync(f.output),/ENOENT/);
});

test('multiple allowed operators get separate menus without sharing application identity assumptions',async t=>{
  const f=await fixture(t),paths=configure([...f.args,'--user','ou_other123'],f.repo);
  assert.equal(paths.length,4);
  assert.deepEqual(loadConfig(paths[0]!).allowedUsers,['ou_owner123','ou_other123']);
  assert.equal(JSON.parse(readFileSync(paths[3]!,'utf8')).user_id,'ou_other123');
});

test('invalid JSON configuration errors do not echo credential contents',t=>{
  const base=mkdtempSync(join(tmpdir(),'bridge-json-'));t.after(()=>rmSync(base,{recursive:true,force:true}));
  const file=join(base,'bad.json'),secret='private-value-should-never-appear';
  writeFileSync(file,`{"app_secret":"${secret}", BAD JSON}`);
  assert.throws(()=>loadConfig(file),error=>error instanceof Error&&!error.message.includes(secret)&&error.message.includes('内容已隐藏'));
});
