import assert from 'node:assert/strict';
import test from 'node:test';
import { card, directoryCard, sessionCard, latestMarkdown, splitMarkdown } from '../src/cards.js';

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

test('directory choices pair numbered leaf titles with full paths and full-width callbacks', () => {
  const paths = ['/mnt/shared/code/MTDP/', '/root/other/MTDP', '/'];
  const value = directoryCard('dev-a · 目录', paths.map((path, i) => ({ index: i + 9, path })));
  const elements = (value.body as { elements: any[] }).elements;
  assert.equal(value.schema, '2.0');
  assert.equal(elements.length, 9);
  paths.forEach((path, i) => {
    const [heading, detail, row] = elements.slice(i * 3, i * 3 + 3);
    assert.equal(heading.tag, 'markdown');
    assert.equal(detail.text.tag, 'plain_text');
    assert.equal(detail.text.content, path);
    assert.equal(detail.text.text_size, 'notation');
    assert.equal(detail.text.text_color, 'grey');
    assert.equal(row.columns.length, 1);
    const button = row.columns[0].elements[0];
    assert.equal(button.text.content, `${i + 9}. ${i < 2 ? 'MTDP' : '/'}`);
    assert.equal(button.width, 'fill');
    assert.deepEqual(button.behaviors, [{ type: 'callback', value: { command: `/sessions ${path}` } }]);
  });
  assert.equal((value.body as any).vertical_spacing, '4px');
});

test('session choices show status-colored titles and prompt excerpts with IDs only in callbacks', () => {
  const entries = ['active', 'idle', 'notLoaded'].map((status, i) => ({
    index: i + 1, id: `private-session-${i}`, title: `会话标题 ${i}`, status,
    prompt: '请检查最近一次提交\n\t 并整理结果。' + '尾部内容'.repeat(100),
  }));
  const value = sessionCard('dev-b · 选择会话', entries);
  const elements = (value.body as { elements: any[] }).elements;
  entries.forEach((entry, i) => {
    const [heading, detail, row] = elements.slice(i * 3, i * 3 + 3);
    assert.ok(heading.content.startsWith(`<font color='${i === 0 ? 'green' : 'grey'}'>`));
    assert.ok(heading.content.includes(entry.status));
    assert.equal(detail.text.tag, 'plain_text');
    assert.ok(detail.text.content.startsWith('最近提示：请检查最近一次提交 并整理结果。'));
    assert.ok(detail.text.content.endsWith('…'));
    assert.ok(!detail.text.content.includes('\n'));
    assert.ok(!heading.content.includes(entry.id));
    assert.ok(!detail.text.content.includes(entry.id));
    assert.ok(!detail.text.content.includes('目录：'));
    assert.equal(row.columns.length, 1);
    const button = row.columns[0].elements[0];
    assert.equal(button.text.content, `${i + 1}. 会话标题 ${i}`);
    assert.deepEqual(button.value, { command: `/select ${entry.id}` });
  });
});

test('selection titles cannot inject Markdown actions or override status colors', () => {
  const hostile = "**[link](https://x)** <at id=all></at> <font color='red'>";
  const value = sessionCard('选择会话', [{ index: 1, id: 'session-one', title: hostile, status: 'idle', prompt: hostile }]);
  const elements = (value.body as { elements: any[] }).elements;
  assert.ok(elements[0].content.startsWith("<font color='grey'>"));
  assert.ok(!elements[0].content.includes('<at'));
  assert.ok(!elements[0].content.includes("color='red'"));
  assert.ok(!elements[0].content.includes('[link]'));
  assert.ok(elements[0].content.includes('&#60;at'));
  assert.ok(elements[0].content.includes('&#42;'));
  assert.equal(elements[1].text.tag, 'plain_text');
  assert.equal(elements[1].text.content, '最近提示：' + hostile);
  const notice = "<at id=all></at> **只是说明**";
  const empty = directoryCard('目录', [], { notice, navigation: [{ label: '下一页', command: '/dir-page 8' }] });
  const emptyElements = (empty.body as { elements: any[] }).elements;
  assert.equal(emptyElements[0].text.content, '暂无可见目录');
  assert.equal(emptyElements[1].text.tag, 'plain_text');
  assert.equal(emptyElements[1].text.content, notice);
  assert.equal(emptyElements[2].columns[0].elements[0].value.command, '/dir-page 8');
});

test('selection truncation preserves Unicode and keeps navigation indices and unnamed fallbacks', () => {
  const value = sessionCard('会话', [
    { index: 9, id: 'unicode', title: '🙂'.repeat(100), status: 'active', prompt: '汉🙂'.repeat(100) },
    { index: 10, id: 'empty', title: '  ', status: 'idle', prompt: '\n\t' },
  ], { navigation: [{ label: '上一页', command: '/page 0' }, { label: '下一页', command: '/page 16' }] });
  const elements = (value.body as { elements: any[] }).elements;
  const label = elements[2].columns[0].elements[0].text.content;
  assert.equal(label, '9. ' + '🙂'.repeat(59) + '…');
  assert.equal(Array.from(elements[1].text.content.slice('最近提示：'.length)).length, 80);
  assert.ok(!JSON.stringify(value).includes('\\ud83d'));
  assert.equal(elements[5].columns[0].elements[0].text.content, '10. 未命名会话');
  assert.equal(elements[4].text.content, '暂无可用提示词');
  assert.equal(elements[6].columns.length, 2);
  assert.deepEqual(elements[6].columns.map((c: any) => c.elements[0].value.command), ['/page 0', '/page 16']);
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

test('latest window fills backward from the final reply instead of taking a forward chunk', () => {
  const text='EARLIEST_HISTORY\n'+'中文🙂 history\n'.repeat(500)+'LATEST_REPLY_END';
  const result=latestMarkdown(text,512);
  assert.equal(result.truncated,true);
  assert.ok(result.markdown.endsWith('LATEST_REPLY_END'));
  assert.ok(!result.markdown.includes('EARLIEST_HISTORY'));
  assert.ok(Buffer.byteLength(result.markdown)>=508);
  assert.ok(Buffer.byteLength(result.markdown)<=512);
  assert.ok(text.endsWith(result.markdown));
  assert.equal(Buffer.from(result.markdown).toString(),result.markdown);
});

test('latest window preserves small replies and truncates a huge single line at code point boundaries', () => {
  assert.deepEqual(latestMarkdown('完整最新回复🙂'),{markdown:'完整最新回复🙂',truncated:false});
  for(const budget of [64,65,127,512]) {
    const text='起点'+ '汉🙂'.repeat(1000)+'最后回复🙂';
    const {markdown,truncated}=latestMarkdown(text,budget);
    assert.ok(truncated);
    assert.ok(text.endsWith(markdown));
    assert.ok(markdown.endsWith('最后回复🙂'));
    assert.ok(Buffer.byteLength(markdown)<=budget);
    assert.ok(Buffer.byteLength(markdown)>=budget-3);
    assert.ok(!markdown.includes('\uFFFD'));
  }
});

test('latest window restores fences when its start falls inside completed or streaming code', () => {
  for(const marker of ['```','~~~~']) {
    for(const complete of [false,true]) {
      const raw='旧说明\n'+marker+'ts\n'+'const 中文 = "🙂";\n'.repeat(100)+'LATEST_CODE_END\n'+(complete?marker:'');
      const {markdown,truncated}=latestMarkdown(raw,256);
      assert.ok(truncated);
      assert.ok(markdown.startsWith(marker+'ts\n'));
      assert.ok(markdown.includes('LATEST_CODE_END'));
      assert.ok(markdown.endsWith('\n'+marker));
      assert.ok(Buffer.byteLength(markdown)<=256);
    }
  }
  assert.deepEqual(latestMarkdown('```ts\nlatest'),{markdown:'```ts\nlatest\n```',truncated:false});
});
