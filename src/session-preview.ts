export type SessionSummary = {
  id: string;
  status?: { type: string };
  updatedAt?: number;
};

const rank = (session: SessionSummary): number =>
  ({ active: 0, idle: 1, notLoaded: 2 }[session.status?.type ?? ''] ?? 3);
const updated = (session: SessionSummary): number =>
  Number.isFinite(session.updatedAt) ? session.updatedAt! : 0;

/** The same thread can occur on overlapping pages of a changing thread list. */
export function uniqueSessions<T extends SessionSummary>(sessions: T[]): T[] {
  const unique = new Map<string, T>();
  for (const session of sessions) {
    const previous = unique.get(session.id);
    if (!previous || updated(session) > updated(previous)
      || (updated(session) === updated(previous) && rank(session) < rank(previous))) {
      unique.set(session.id, session);
    }
  }
  return [...unique.values()];
}

export function orderedSessions<T extends SessionSummary>(sessions: T[]): T[] {
  return uniqueSessions(sessions).sort((a, b) => rank(a) - rank(b) || updated(b) - updated(a));
}

function userPrompt(item: any): string | undefined {
  if (item?.type !== 'userMessage') return undefined;
  const content = Array.isArray(item.content) ? item.content : [];
  const text = content.filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text).join('\n').trim();
  if (text) return text;
  if (content.some((part: any) => ['image', 'localImage'].includes(part?.type))) return '（图片消息）';
  return content.length ? '（附件或非文本消息）' : '（空消息）';
}

/** Turns arrive newest first; items within each turn remain chronological. */
export function latestUserPrompt(turns: any[]): string | undefined {
  for (const turn of turns) {
    for (const item of [...(Array.isArray(turn?.items) ? turn.items : [])].reverse()) {
      const prompt = userPrompt(item);
      if (prompt !== undefined) return prompt;
    }
  }
  return undefined;
}

export function historyMethodUnavailable(error: unknown, method = 'thread/turns/list'): boolean {
  const rpc = error as { code?: number; message?: string };
  return rpc?.code === -32601 || (rpc?.code === -32600
    && /unknown (?:variant|method)/i.test(rpc.message ?? '')
    && (rpc.message ?? '').includes(method));
}

/** Bound navigation latency without resuming or subscribing to any thread. */
export async function beforeDeadline<T>(read: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('提示词读取超时');
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('提示词读取超时')), remaining); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

type ReadHistory = (method: string, params: Record<string, unknown>) => Promise<any>;
type PromptCache = { anchor: string; prompt: string | undefined };
const unavailablePrompt = '暂时无法读取最近提示词';

/** Only historical read methods are used; navigation never resumes a thread. */
export class RecentPromptReader {
  private itemsUnavailable = false;
  private turnsUnavailable = false;
  private readonly cache = new Map<string, PromptCache>();
  constructor(private readonly request: ReadHistory) {}

  async read(threadId: string, deadline: number): Promise<string | undefined> {
    try {
      if (!this.itemsUnavailable) {
        try { return await this.fromItems(threadId, deadline); }
        catch (error) {
          if (!historyMethodUnavailable(error, 'thread/items/list')) throw error;
          this.itemsUnavailable = true;
        }
      }
      if (!this.turnsUnavailable) {
        try { return await this.fromTurns(threadId, deadline); }
        catch (error) {
          if (!historyMethodUnavailable(error, 'thread/turns/list')) throw error;
          this.turnsUnavailable = true;
        }
      }
      const result = await beforeDeadline(() => this.request('thread/read', { threadId, includeTurns: true }), deadline);
      if (!Array.isArray(result?.thread?.turns)) throw new Error('无效的会话历史');
      return latestUserPrompt([...result.thread.turns].reverse());
    } catch { return unavailablePrompt; }
  }

  private remember(threadId: string, anchor: string | undefined, prompt: string | undefined) {
    if (anchor) {
      this.cache.delete(threadId);
      // Cards display only the opening 80 characters; do not retain entire
      // pasted files or other very large inputs in the long-lived cache.
      this.cache.set(threadId, { anchor, prompt: prompt === undefined ? undefined : Array.from(prompt).slice(0,512).join('') });
      while (this.cache.size > 128) this.cache.delete(this.cache.keys().next().value!);
    }
    return prompt;
  }

  private async fromItems(threadId: string, deadline: number): Promise<string | undefined> {
    const cached = this.cache.get(threadId);
    let anchor: string | undefined;
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 128; pageNumber++) {
      const result = await beforeDeadline(() => this.request('thread/items/list', {
        threadId, limit: 50, sortDirection: 'desc', ...(cursor ? { cursor } : {}),
      }), deadline);
      if (!Array.isArray(result?.data)) throw new Error('无效的会话历史');
      if (pageNumber === 0 && typeof result.data[0]?.item?.id === 'string') anchor = result.data[0].item.id;
      for (const entry of result.data) {
        if (!entry?.item || typeof entry.item !== 'object') throw new Error('无效的会话历史');
        const prompt = userPrompt(entry.item);
        if (prompt !== undefined) return this.remember(threadId, anchor, prompt);
        // No new user input precedes the old newest item, so the old prompt
        // remains current even when a long-running goal has added many tools.
        if (cached && entry.item.id === cached.anchor) return this.remember(threadId, anchor, cached.prompt);
      }
      if (result.nextCursor == null) return this.remember(threadId, anchor, undefined);
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) {
        throw new Error('无效的会话历史分页游标');
      }
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('会话历史分页超出范围');
  }

  private async fromTurns(threadId: string, deadline: number): Promise<string | undefined> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    for (let pageNumber = 0; pageNumber < 64; pageNumber++) {
      const result = await beforeDeadline(() => this.request('thread/turns/list', {
        threadId, limit: 2, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}),
      }), deadline);
      if (!Array.isArray(result?.data)) throw new Error('无效的会话历史');
      const prompt = latestUserPrompt(result.data);
      if (prompt !== undefined) return prompt;
      if (result.nextCursor == null) return undefined;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || seen.has(result.nextCursor)) {
        throw new Error('无效的会话历史分页游标');
      }
      seen.add(result.nextCursor); cursor = result.nextCursor;
    }
    throw new Error('会话历史分页超出范围');
  }
}
