import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { DEFAULT_MEDIA, MediaResolver, feishuFileType, findReferences, resolveLocal, type MediaUploader } from '../src/media.js';
import { Store } from '../src/store.js';

function fixture(t: TestContext) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'feishu-media-')));
  const root = join(base, 'allowed'), cwd = join(root, 'project'), outside = join(base, 'outside');
  mkdirSync(join(cwd, 'out'), { recursive: true }); mkdirSync(outside);
  writeFileSync(join(cwd, 'out', 'chart.png'), 'png-bytes');
  writeFileSync(join(cwd, 'out', '盘点 结果.xlsx'), 'xlsx-bytes');
  writeFileSync(join(cwd, 'src.ts'), 'code');
  writeFileSync(join(cwd, '.env'), 'SECRET=1');
  writeFileSync(join(outside, 'leak.png'), 'outside');
  symlinkSync(join(outside, 'leak.png'), join(cwd, 'out', 'link.png'));
  const store = new Store(':memory:');
  const calls: { kind: string; name?: string; type?: string; data: string }[] = [];
  let fail = false;
  const uploader: MediaUploader = {
    async uploadImage(data) { calls.push({ kind: 'image', data: data.toString() }); if (fail) throw new Error('missing scope im:resource'); return `img_v3_${calls.length}`; },
    async uploadFile(data, name, type) { calls.push({ kind: 'file', name, type, data: data.toString() }); if (fail) throw new Error('missing scope'); return `file_v3_${calls.length}`; },
  };
  const media = new MediaResolver([root], DEFAULT_MEDIA, store, uploader);
  t.after(() => { store.close(); rmSync(base, { recursive: true, force: true }); });
  return { base, root, cwd, outside, store, calls, media, setFail: (value: boolean) => { fail = value; } };
}

test('finds links and images outside code', () => {
  const refs = findReferences('see ![a](x.png) and [b](<y z.pdf> "t")\n`[c](no.png)`\n```\n![d](no.png)\n```\n[e](q.csv)');
  assert.deepEqual(refs.map(r => [r.image, r.label, r.target]), [[true, 'a', 'x.png'], [false, 'b', 'y z.pdf'], [false, 'e', 'q.csv']]);
});

test('resolves only allowed deliverables and images', t => {
  const f = fixture(t);
  assert.equal(resolveLocal('out/chart.png', f.cwd, [f.root], DEFAULT_MEDIA)?.kind, 'image');
  assert.equal(resolveLocal(`file://${join(f.cwd, 'out', encodeURIComponent('盘点 结果.xlsx'))}`, f.cwd, [f.root], DEFAULT_MEDIA)?.kind, 'file');
  assert.equal(resolveLocal('out/%E7%9B%98%E7%82%B9%20%E7%BB%93%E6%9E%9C.xlsx', f.cwd, [f.root], DEFAULT_MEDIA)?.kind, 'file');
  for (const denied of ['src.ts', 'src.ts:12', join(f.cwd, 'out/chart.png') + '#L3', '.env', 'out/link.png',
    join(f.outside, 'leak.png'), 'https://example.com/a.png', 'missing.png', 'out']) {
    assert.equal(resolveLocal(denied, f.cwd, [f.root], DEFAULT_MEDIA), undefined, denied);
  }
  assert.equal(feishuFileType('a.XLSX'), 'xls');
  assert.equal(feishuFileType('a.csv'), 'stream');
});

test('final answers embed images and attach files once, with cached uploads', async t => {
  const f = fixture(t);
  const text = `盘点完成：\n![趋势图](out/chart.png)\n导出：[盘点结果](${join(f.cwd, 'out', '盘点 结果.xlsx')})，同一文件 [再次](out/盘点%20结果.xlsx)\n修改了 [src.ts](src.ts:3)\n![远程](https://example.com/a.png)`;
  const first = await f.media.prepare(text, f.cwd);
  assert.match(first.markdown, /\n!\[趋势图\]\(img_v3_1\)\n/);
  assert.match(first.markdown, /📎 \*\*盘点结果\*\*（文件见下方消息）/);
  assert.match(first.markdown, /\[src\.ts\]\(src\.ts:3\)/);
  assert.match(first.markdown, /\[🖼 远程\]\(https:\/\/example\.com\/a\.png\)/);
  assert.deepEqual(first.files, [{ key: 'file_v3_2', name: '盘点 结果.xlsx' }]);
  assert.deepEqual(f.calls.map(c => [c.kind, c.name, c.type]), [['image', undefined, undefined], ['file', '盘点 结果.xlsx', 'xls']]);
  const again = await f.media.prepare(text, f.cwd);
  assert.deepEqual(again, first);
  assert.equal(f.calls.length, 2);
  // Progress cards reuse cached image keys and never upload.
  assert.match(f.media.sanitize('![趋势图](out/chart.png) ![x](missing.png)', f.cwd), /!\[趋势图\]\(img_v3_1\)[\s\S]*🖼 x/);
  assert.equal(f.calls.length, 2);
});

test('failed uploads are reported in the card and backed off', async t => {
  const f = fixture(t); f.setFail(true);
  const result = await f.media.prepare('![图](out/chart.png)\n[表](out/盘点%20结果.xlsx)', f.cwd);
  assert.match(result.markdown, /图片未能发送：missing scope im:resource/);
  assert.match(result.markdown, /文件未能发送：missing scope/);
  assert.deepEqual(result.files, []);
  f.setFail(false);
  const retry = await f.media.prepare('![图](out/chart.png)', f.cwd);
  assert.match(retry.markdown, /稍后点击刷新重试/);
  assert.equal(f.calls.length, 2);
});

test('generated images are uploaded from Codex output bytes', async t => {
  const f = fixture(t);
  const result = await f.media.prepare('完成', f.cwd, [{ id: 'ig', data: Buffer.from('generated').toString('base64') }]);
  assert.match(result.markdown, /!\[生成的图片\]\(img_v3_1\)/);
  assert.equal(f.calls[0]?.data, 'generated');
});

test('disabled media only sanitizes local images', async t => {
  const f = fixture(t);
  const media = new MediaResolver([f.root], { ...DEFAULT_MEDIA, enabled: false }, f.store);
  const result = await media.prepare('![图](out/chart.png) [表](out/盘点%20结果.xlsx)', f.cwd);
  assert.equal(result.markdown, '🖼 图 [表](out/盘点%20结果.xlsx)');
  assert.deepEqual(result.files, []);
  assert.equal(f.calls.length, 0);
});

