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

/** A byte-bounded window anchored at the end, with fences kept readable. */
export function latestMarkdown(text: string, maxBytes = 12_000): { markdown: string; truncated: boolean } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64) {
    throw new RangeError('maxBytes must be an integer of at least 64');
  }
  const lines: { start: number; end: number; fence?: Fence; atomic: boolean }[] = [];
  let fence: Fence | undefined;
  let offset = 0;
  for (const line of text.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const before = fence;
    const stripped = line.replace(/\r?\n$/, '');
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(stripped);
    const marker = match?.[2], tail = match?.[3] || '';
    const closes = !!(fence && marker && marker[0] === fence.marker[0]
      && marker.length >= fence.marker.length && /^\s*$/.test(tail));
    const opens = !!(!fence && marker && !(marker[0] === '`' && tail.includes('`')));
    if (closes) fence = undefined;
    else if (opens) fence = { marker: marker!, opener: stripped };
    lines.push({ start: offset, end: offset + line.length, fence: before, atomic: closes || opens });
    offset += line.length;
  }
  const closing = fence ? `${text.endsWith('\n') ? '' : '\n'}${fence.marker}` : '';
  if (bytes(text + closing) <= maxBytes) return { markdown: text + closing, truncated: false };

  let selected = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    const prefix = line.fence ? `${line.fence.opener}\n` : '';
    const candidate = prefix + text.slice(line.start) + closing;
    if (bytes(candidate) <= maxBytes) { selected = candidate; continue; }
    // Never cut a fence marker or language declaration in half.
    if (line.atomic) {
      if (!selected) throw new RangeError('Code fence exceeds maxBytes');
      break;
    }
    const rest = text.slice(line.end);
    const room = maxBytes - bytes(prefix + rest + closing);
    if (room >= 0) {
      const encoded = Buffer.from(text.slice(line.start, line.end), 'utf8');
      let start = Math.max(0, encoded.length - room);
      // Start on a complete Unicode code point, not a UTF-8 continuation byte.
      while (start < encoded.length && (encoded[start]! & 0xc0) === 0x80) start++;
      selected = prefix + encoded.subarray(start).toString('utf8') + rest + closing;
    }
    break;
  }
  return { markdown: selected, truncated: true };
}

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
