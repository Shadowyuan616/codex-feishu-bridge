import { buildTextCard, toCardKit2 } from '../vendor/openclaw-lark/card-builder.js';

export type CardAction = {
  label: string;
  command: string;
  type?: 'primary' | 'default' | 'danger';
};

/** Build a Feishu JSON 2.0 card. Authorization belongs in the callback handler. */
export function card(
  title: string,
  markdown: string,
  actions: CardAction[] = [],
): Record<string, unknown> {
  const result = buildTextCard(markdown || '（暂无内容）');
  result.header = {
    title: { tag: 'plain_text', content: Array.from(title).slice(0, 100).join('') || 'Codex' },
    template: 'blue',
  };
  // Three buttons per row keep session navigation usable on a phone.
  for (let offset = 0; offset < actions.length; offset += 3) {
    result.elements.push({
      tag: 'column_set',
      flex_mode: 'none',
      columns: actions.slice(offset, offset + 3).map((action) => ({
        tag: 'column',
        width: 'weighted',
        weight: 1,
        elements: [{
          tag: 'button',
          text: { tag: 'plain_text', content: action.label },
          type: action.type || 'default',
          width: 'fill',
          behaviors: [{ type: 'callback', value: { command: action.command } }],
          // Historical attribute retained for clients that predate behaviors.
          value: { command: action.command },
        }],
      })),
    });
  }
  return toCardKit2(result);
}

type Fence = { marker: string; opener: string };
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/**
 * Split UTF-8 Markdown into independently readable chunks. Every returned chunk
 * fits maxBytes, including inserted closing/reopening code fences. Prefer whole
 * lines; split exceptionally long lines at Unicode code-point boundaries.
 * Markdown prose is preserved exactly. Code split across cards receives only
 * the fences/newlines needed to keep each card valid. An unfinished fence is
 * closed for display. maxBytes is the Markdown budget, not the whole JSON card.
 */
export function splitMarkdown(text: string, maxBytes = 12_000): string[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) {
    throw new RangeError('maxBytes must be an integer of at least 64');
  }
  if (!text) return [''];
  const chunks: string[] = [];
  let current = '';
  let currentBytes = 0;
  let fence: Fence | undefined;

  const closure = (value: string, active = fence): string =>
    active ? `${value.endsWith('\n') ? '' : '\n'}${active.marker}` : '';

  function flush(): void {
    if (!current) return;
    chunks.push(current + closure(current));
    current = fence ? `${fence.opener}\n` : '';
    currentBytes = bytes(current);
  }

  function append(value: string): void {
    const valueBytes = bytes(value);
    if (currentBytes + valueBytes + bytes(closure(current + value)) <= maxBytes) {
      current += value;
      currentBytes += valueBytes;
      return;
    }
    const prefix = fence ? `${fence.opener}\n` : '';
    if (bytes(prefix + value + closure(prefix + value)) <= maxBytes) {
      flush();
      current += value;
      currentBytes += valueBytes;
      return;
    }
    for (const point of value) {
      const pointBytes = bytes(point);
      if (currentBytes + pointBytes + bytes(closure(current + point)) > maxBytes) {
        flush();
      }
      if (currentBytes + pointBytes + bytes(closure(current + point)) > maxBytes) {
        throw new RangeError('Code fence leaves no room for content at this maxBytes');
      }
      current += point;
      currentBytes += pointBytes;
    }
  }

  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const stripped = line.replace(/\r?\n$/, '');
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(stripped);
    const marker = match?.[2];
    const tail = match?.[3] || '';
    const closes = fence && marker && marker[0] === fence.marker[0]
      && marker.length >= fence.marker.length && /^\s*$/.test(tail);
    if (closes) {
      // A closing fence is atomic. If it does not fit, repeat the opener in a
      // new chunk and place the original closing fence there.
      if (currentBytes + bytes(line) > maxBytes) flush();
      if (currentBytes + bytes(line) > maxBytes) {
        throw new RangeError('Closing code fence exceeds maxBytes');
      }
      current += line;
      currentBytes += bytes(line);
      fence = undefined;
    } else if (!fence && marker && !(marker[0] === '`' && tail.includes('`'))) {
      const next: Fence = { marker, opener: stripped };
      // Reserve one full Unicode code point plus a terminating newline/fence.
      if (bytes(`${next.opener}\n${next.marker}`) + 5 > maxBytes) {
        throw new RangeError('Code fence exceeds maxBytes');
      }
      if (currentBytes + bytes(line) + bytes(closure(line, next)) > maxBytes) flush();
      current += line;
      currentBytes += bytes(line);
      fence = next;
    } else {
      append(line);
    }
  }
  if (current) chunks.push(current + closure(current));
  return chunks;
}
