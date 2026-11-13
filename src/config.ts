import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { MediaOptions } from './media.js';

export interface Config {
  host: string;
  stateDir: string;
  allowedUsers: string[];
  allowedRoots: string[];
  lark: { binary: string; profile?: string; cwd?: string };
  codex: { binary: string; args: string[]; socketPath?:string; cwd?: string; env?: Record<string, string> };
  pollIntervalMs: number;
  /** Images/files referenced by final answers. Optional; defaults to DEFAULT_MEDIA. */
  media?: Partial<Pick<MediaOptions,'enabled'|'fileExtensions'>>;
}


export function loadConfig(path: string): Config {
  const source=readFileSync(path, 'utf8');
  let value:unknown;
  try { value=JSON.parse(source); }
  catch { throw new Error('配置文件不是有效 JSON（内容已隐藏）'); }
  return validateConfig(value);
}

export function validateConfig(value: unknown): Config {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('配置必须是 JSON 对象');
  const c = structuredClone(value) as Config;
  if (!c.host || !/^[a-zA-Z0-9_-]+$/.test(c.host)) throw new Error('host 必须是机器标识');
  if (!isAbsolute(c.stateDir ?? '')) throw new Error('stateDir 必须是绝对路径');
  if (!Array.isArray(c.allowedUsers) || !c.allowedUsers.length || c.allowedUsers.some(x => !/^ou_[A-Za-z0-9]+$/.test(x))) {
    throw new Error('allowedUsers 必须明确列出飞书 open_id；拒绝空白名单和通配符');
  }
  if (!Array.isArray(c.allowedRoots) || !c.allowedRoots.length) throw new Error('必须配置 allowedRoots');
  c.allowedRoots = c.allowedRoots.map(p => {
    if (!isAbsolute(p)) throw new Error('allowedRoots 必须是绝对路径');
    const actual=realpathSync(p);
    if(!statSync(actual).isDirectory())throw new Error('allowedRoots 必须指向目录');
    return actual;
  });
  if (!c.lark?.binary || !c.codex?.binary || !Array.isArray(c.codex.args)) throw new Error('缺少 CLI 配置');
  for(const binary of [c.lark.binary,c.codex.binary])if(typeof binary!=='string'||!isAbsolute(binary))throw new Error('CLI binary 必须使用绝对路径');
  if(c.codex.args.includes('proxy'))throw new Error('proxy 透传 WebSocket，不能使用 JSONL 客户端；请配置 socketPath');
  if(c.codex.socketPath&&!isAbsolute(c.codex.socketPath))throw new Error('codex.socketPath 必须是共享 daemon socket 的绝对路径');
  if (!c.codex.socketPath&&!c.codex.args.includes('--stdio')) {
    throw new Error('共享会话需要 codex.socketPath；独立进程需明确选择 --stdio。proxy 原始字节不是 JSONL。');
  }
  c.pollIntervalMs ??= 10_000;
  if (!Number.isFinite(c.pollIntervalMs) || c.pollIntervalMs < 1000) throw new Error('pollIntervalMs 至少 1000');
  if (c.media !== undefined) {
    if (!c.media || typeof c.media !== 'object' || Array.isArray(c.media)) throw new Error('media 必须是对象');
    if (c.media.enabled !== undefined && typeof c.media.enabled !== 'boolean') throw new Error('media.enabled 必须是布尔值');
    if (c.media.fileExtensions !== undefined && (!Array.isArray(c.media.fileExtensions)
      || c.media.fileExtensions.some(x => typeof x !== 'string' || !/^[A-Za-z0-9]{1,10}$/.test(x)))) {
      throw new Error('media.fileExtensions 必须是不带点的扩展名数组，如 ["xlsx","pdf"]');
    }
  }
  return c;
}

export function allowedPath(path: string, roots: string[]): boolean {
  try {
    const actual = realpathSync(path);
    return roots.some(root => {
      const r = relative(realpathSync(root), actual);
      return r === '' || (!r.startsWith('..' + '/') && r !== '..' && !isAbsolute(r));
    });
  } catch { return false; }
}

export const configPath = (arg?: string) => resolve(arg ?? process.env.BRIDGE_CONFIG ?? 'config.local.json');
