import assert from 'node:assert/strict';
import test from 'node:test';
import { scanPrivacy } from '../src/privacy.js';

test('privacy findings identify credentials and identities without returning their values',()=>{
  const app='cli_'+'a1'.repeat(8),user='ou_'+'b2'.repeat(16),token='ghp_'+'AbCd34'.repeat(7);
  const found=scanPrivacy('notes.md',[app,user,token].join('\n'));
  assert.deepEqual(found.map(x=>x.rule),['feishu-app-id','feishu-identity','credential']);
  assert.deepEqual(found.map(x=>x.line),[1,2,3]);
  const encoded=JSON.stringify(found);
  for(const secret of [app,user,token])assert.ok(!encoded.includes(secret));
});

test('private files are caught even without text, while explicit placeholders and examples remain usable',()=>{
  assert.equal(scanPrivacy('config.local.json','{}')[0]?.rule,'private-runtime-file');
  assert.equal(scanPrivacy('state.sqlite','\0')[0]?.rule,'private-runtime-file');
  assert.equal(scanPrivacy('backup.bundle','\0')[0]?.rule,'private-runtime-file');
  assert.equal(scanPrivacy('examples/auth.json','{}')[0]?.rule,'private-runtime-file');
  assert.deepEqual(scanPrivacy('.env.example','KEY=YOUR_VALUE'),[]);
  assert.deepEqual(scanPrivacy('config.example.json','ou_REPLACE_WITH_YOUR_OPEN_ID'),[]);
  assert.deepEqual(scanPrivacy('README.md','cli_EXAMPLE ou_owner123 /home/bridge-user/project'),[]);
});

test('private emails are identified but reserved examples and third-party copyrights are preserved',()=>{
  const email='some-person'+'@'+'private.invalid';
  assert.equal(scanPrivacy('commit:example',email)[0]?.rule,'personal-email');
  assert.deepEqual(scanPrivacy('vendor/library/LICENSE',email),[]);
  assert.deepEqual(scanPrivacy('README.md','owner@example.com owner@users.noreply.github.com'),[]);
});

test('assigned secrets and private infrastructure patterns cannot silently enter docs',()=>{
  const source='app_secret: "'+'Aa123456'.repeat(4)+'"';
  assert.equal(scanPrivacy('notes.md',source)[0]?.rule,'credential-value');
  assert.equal(scanPrivacy('notes.md','/Users/'+'private-person/project')[0]?.rule,'personal-home');
  assert.equal(scanPrivacy('notes.md',['192','168','3','7'].join('.'))[0]?.rule,'private-ip');
});
