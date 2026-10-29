import assert from 'node:assert/strict';
import test from 'node:test';
import { card, splitMarkdown } from '../src/cards.js';

test('card uses schema 2.0, source Markdown, and explicit callback commands', () => {
  const markdown = '## 最新进展\n\n```ts\nconst value = 1;\n```';
  const value = card('dev-a · 开发', markdown, [
    { label: '切换会话', command: '/use 123', type: 'primary' },
    { label: '中断', command: '/stop', type: 'danger' },
  ]);
  assert.equal(value.schema, '2.0');
  assert.equal(value.elements, undefined);
  const elements = (value.body as { elements: any[] }).elements;
  assert.equal(elements[0].content, markdown);
  assert.deepEqual(elements[1].columns[0].elements[0].value, { command: '/use 123' });
  assert.deepEqual(elements[1].columns[0].elements[0].behaviors, [
    { type: 'callback', value: { command: '/use 123' } },
  ]);
  assert.equal(elements[1].columns[1].elements[0].type, 'danger');
  assert.equal((value.config as any).update_multi, true);
});

test('navigation buttons wrap to three per row without losing commands', () => {
  const value = card('', '', Array.from({ length: 8 }, (_, i) => ({
    label: `会话 ${i}`, command: `/use ${i}`,
  })));
  const elements = (value.body as { elements: any[] }).elements;
  assert.equal(elements[0].content, '（暂无内容）');
  assert.deepEqual(elements.slice(1).map((x) => x.columns.length), [3, 3, 2]);
  assert.equal((value.header as any).title.content, 'Codex');
});

test('plain prose splits by UTF-8 bytes without losing text or damaging Unicode', () => {
  const original = '第一行内容 🧑‍💻\n' + '中文🙂é'.repeat(200) + '\nlast line';
  for (const budget of [64, 65, 100, 128, 256, 512, 12_000]) {
    const chunks = splitMarkdown(original, budget);
    assert.equal(chunks.join(''), original);
    for (const chunk of chunks) {
      assert.ok(Buffer.byteLength(chunk, 'utf8') <= budget);
      assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk);
    }
  }
});

test('long fenced code closes and reopens with the language and byte budget', () => {
  const source = 'console.log("中文🙂");'.repeat(60);
  for (const delimiter of ['```', '~~~~']) {
    const original = `${delimiter}ts\n${source}\n${delimiter}`;
    for (const budget of [64, 80, 128, 256]) {
      const chunks = splitMarkdown(original, budget);
      assert.ok(chunks.length > 1);
      const reconstructed: string[] = [];
      for (const chunk of chunks) {
        assert.ok(Buffer.byteLength(chunk, 'utf8') <= budget);
        assert.ok(chunk.startsWith(`${delimiter}ts\n`));
        assert.ok(chunk.endsWith(`\n${delimiter}`));
        reconstructed.push(chunk.slice(delimiter.length + 3, -delimiter.length - 1));
      }
      assert.equal(reconstructed.join('').replace(/\n/g, ''), source);
    }
  }
});

test('prose, complete blocks, and nested shorter fences remain readable', () => {
  const original = '说明\n\n````md\n```js\nconst x = 1;\n```\n````\n\n结论';
  assert.deepEqual(splitMarkdown(original, 512), [original]);
  const chunks = splitMarkdown(original.repeat(30), 128);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 128);
    assert.equal((chunk.match(/^````/gm) || []).length % 2, 0);
  }
});

test('unfinished code fences are closed for display, including CRLF', () => {
  assert.deepEqual(splitMarkdown('```py\nprint(1)'), ['```py\nprint(1)\n```']);
  assert.deepEqual(splitMarkdown('~~~py\r\nprint(1)\r\n'), ['~~~py\r\nprint(1)\r\n~~~']);
  assert.deepEqual(splitMarkdown(''), ['']);
});

test('rejects invalid budgets and an impossibly large atomic fence', () => {
  for (const budget of [0, -10, 63, 64.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => splitMarkdown('text', budget), RangeError);
  }
  assert.throws(() => splitMarkdown('`'.repeat(100) + '\ncode', 64), RangeError);
});
