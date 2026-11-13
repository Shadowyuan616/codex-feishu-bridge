import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedPath, type Config } from './config.js';

/**
 * Turns local images and deliverable files referenced by a Codex answer into
 * Feishu resources: images are embedded as `![alt](img_key)` in the card
 * Markdown, and files are sent as native file messages that Feishu can preview.
 */

export type MediaOptions = {
  enabled: boolean;
  /** Extensions (without dot) of linked files that are sent as attachments. */
  fileExtensions: string[];
  maxImageBytes: number;
  maxFileBytes: number;
  maxImages: number;
  maxFiles: number;
};

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'tif', 'tiff', 'ico'];
export const DEFAULT_FILE_EXTENSIONS = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'tsv', 'ppt', 'pptx', 'zip', 'html', 'htm'];
export const DEFAULT_MEDIA: MediaOptions = {
  enabled: true,
  fileExtensions: DEFAULT_FILE_EXTENSIONS,
  // Feishu IM limits: images 10 MB, files 30 MB.
  maxImageBytes: 10 * 1024 * 1024,
  maxFileBytes: 30 * 1024 * 1024,
  maxImages: 10,
  maxFiles: 10,
};

export function mediaOptions(config: Config): MediaOptions {
  return {
    ...DEFAULT_MEDIA,
    ...(config.media?.enabled !== undefined ? { enabled: config.media.enabled } : {}),
    ...(config.media?.fileExtensions ? { fileExtensions: config.media.fileExtensions.map(x => x.toLowerCase()) } : {}),
  };
}

export interface MediaUploader {
  uploadImage(data: Buffer): Promise<string>;
  uploadFile(data: Buffer, name: string, fileType: string): Promise<string>;
}

export interface MediaCache {
  mediaGet(sig: string): { key: string | null; error: string | null; next_at: number } | undefined;
  mediaPut(sig: string, key: string): void;
  mediaFail(sig: string, error: string, now?: number): void;
}

export type Reference = { start: number; end: number; image: boolean; label: string; target: string };
export type Attachment = { key: string; name: string };
export type PreparedAnswer = { markdown: string; files: Attachment[] };
export type GeneratedImage = { id: string; data: string; savedPath?: string };

/** Find Markdown links/images outside fenced and inline code. */
export function findReferences(markdown: string): Reference[] {
  const found: Reference[] = [];
  let fence: string | undefined;
  let offset = 0;
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) || []) {
    const stripped = line.replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(stripped);
    if (fence) {
      if (marker && marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && !marker[2]!.trim()) fence = undefined;
    } else if (marker && !(marker[1]![0] === '`' && marker[2]!.includes('`'))) {
      fence = marker[1];
    } else {
      const code: [number, number][] = [];
      for (const span of stripped.matchAll(/(`+)[^`]*?\1/g)) code.push([span.index!, span.index! + span[0].length]);
      const link = /(!?)\[([^\]\n]*)\]\(\s*(<[^>\n]+>|(?:[^\s()"']|\([^\s()]*\))+(?:[ \t]+(?:[^\s()"']|\([^\s()]*\))+)*)(?:\s+"[^"\n]*")?\s*\)/g;
      for (const match of stripped.matchAll(link)) {
        const start = match.index!, end = start + match[0].length;
        if (code.some(([a, b]) => start < b && end > a)) continue;
        let target = match[3]!;
        if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
        found.push({ start: offset + start, end: offset + end, image: match[1] === '!', label: match[2]!, target });
      }
    }
    offset += line.length;
  }
  return found;
}

const LINE_SUFFIX = /(?::\d+(?::\d+)?|#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?)$/;
const DENIED_SEGMENT = /^(?:\.git|\.ssh|\.gnupg|\.aws|\.codex|\.lark-cli|node_modules)$/i;
const DENIED_NAME = /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|auth\.json|config\.local\..*|bridge\.env)$|\.(?:pem|key|p12|pfx|sqlite[^.]*)$/i;

type Local = { path: string; kind: 'image' | 'file'; size: number; mtime: number };

/** Resolve a link target to an allowed, regular local file or return undefined. */
export function resolveLocal(target: string, cwd: string, roots: string[], options: MediaOptions): Local | undefined {
  let value = target.trim();
  if (/^file:\/\//i.test(value)) {
    try { value = fileURLToPath(value); } catch { return undefined; }
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('#') || value.startsWith('//')) {
    return undefined;
  }
  const forms = [value];
  try { const decoded = decodeURIComponent(value); if (decoded !== value) forms.push(decoded); } catch { /* keep raw form */ }
  for (const form of forms) {
    // `path:12` and `#L12` are source references, never deliverables.
    if (LINE_SUFFIX.test(form)) return undefined;
    const candidate = isAbsolute(form) ? form : resolve(cwd, form);
    if (!allowedPath(candidate, roots)) continue;
    let actual: string;
    try { actual = realpathSync(candidate); } catch { continue; }
    if (actual.split(sep).some(part => DENIED_SEGMENT.test(part)) || DENIED_NAME.test(basename(actual))) return undefined;
    let info;
    try { info = statSync(actual); } catch { continue; }
    if (!info.isFile()) return undefined;
    const ext = extname(actual).slice(1).toLowerCase();
    const kind = IMAGE_EXTENSIONS.includes(ext) ? 'image' : options.fileExtensions.includes(ext) ? 'file' : undefined;
    if (!kind) return undefined;
    return { path: actual, kind, size: info.size, mtime: info.mtimeMs };
  }
  return undefined;
}

/** Feishu im/v1/files `file_type`. */
export function feishuFileType(name: string): string {
  const ext = extname(name).slice(1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (ext === 'doc' || ext === 'docx') return 'doc';
  if (ext === 'xls' || ext === 'xlsx') return 'xls';
  if (ext === 'ppt' || ext === 'pptx') return 'ppt';
  if (ext === 'mp4') return 'mp4';
  if (ext === 'opus') return 'opus';
  return 'stream';
}

const plainLabel = (value: string, fallback: string): string =>
  value.replace(/[\[\]*_`<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || fallback;
const imageMarkdown = (label: string, key: string): string => `\n![${plainLabel(label, '图片')}](${key})\n`;
const signature = (...parts: (string | number)[]): string => createHash('sha256').update(parts.join('\0')).digest('hex');
const reason = (error: unknown): string => (error instanceof Error ? error.message : '上传失败').slice(0, 200);
const safeRealpath = (path: string): string | undefined => { try { return realpathSync(path); } catch { return undefined; } };

export class MediaResolver {
  constructor(
    private readonly roots: string[],
    private readonly options: MediaOptions,
    private readonly cache: MediaCache,
    private readonly uploader?: MediaUploader,
  ) {}

  get uploads(): boolean { return this.options.enabled && !!this.uploader; }

  /**
   * Progress cards never upload. They embed images already cached for this exact
   * file version and replace other non-Feishu image sources with readable text:
   * a card containing an invalid image key may be rejected entirely.
   */
  sanitize(markdown: string, cwd: string): string {
    return this.rewrite(markdown, ref => {
      if (!ref.image) return undefined;
      if (/^img_[A-Za-z0-9_-]+$/.test(ref.target)) return undefined;
      if (/^https?:\/\//i.test(ref.target)) return `[🖼 ${plainLabel(ref.label, '图片')}](${ref.target})`;
      const local = this.options.enabled ? resolveLocal(ref.target, cwd, this.roots, this.options) : undefined;
      const cached = local?.kind === 'image' ? this.cache.mediaGet(this.localSig(local))?.key : undefined;
      if (cached) return imageMarkdown(ref.label, cached);
      return `🖼 ${plainLabel(ref.label, local ? basename(local.path) : '图片')}`;
    });
  }

  /** Upload referenced media for a completed answer. Never throws for one asset. */
  async prepare(markdown: string, cwd: string, generated: GeneratedImage[] = [], deadlineMs = 60_000): Promise<PreparedAnswer> {
    if (!this.uploads) return { markdown: this.sanitize(markdown, cwd), files: [] };
    const deadline = Date.now() + deadlineMs;
    const replacements = new Map<number, string>();
    const files: Attachment[] = [];
    const sentFiles = new Map<string, string>();
    const embedded = new Set<string>();
    let images = 0;
    for (const ref of findReferences(markdown)) {
      if (ref.image && /^img_[A-Za-z0-9_-]+$/.test(ref.target)) continue;
      if (ref.image && /^https?:\/\//i.test(ref.target)) { replacements.set(ref.start, `[🖼 ${plainLabel(ref.label, '图片')}](${ref.target})`); continue; }
      const local = resolveLocal(ref.target, cwd, this.roots, this.options);
      if (!local) {
        if (ref.image) replacements.set(ref.start, `🖼 ${plainLabel(ref.label, '图片')}（无法读取该图片）`);
        continue;
      }
      const name = basename(local.path);
      const label = plainLabel(ref.label, name);
      if (local.kind === 'image') {
        if (++images > this.options.maxImages) { replacements.set(ref.start, `🖼 ${label}（超过单条回答 ${this.options.maxImages} 张图片上限）`); continue; }
        if (local.size > this.options.maxImageBytes) { replacements.set(ref.start, `🖼 ${label}（图片超过 ${this.options.maxImageBytes / 1048576} MB）`); continue; }
        const result = await this.upload(this.localSig(local), deadline, () => this.uploader!.uploadImage(readFileSync(local.path)));
        replacements.set(ref.start, result.key ? imageMarkdown(label, result.key) : `🖼 ${label}（图片未能发送：${result.error}）`);
        if (result.key) embedded.add(local.path);
        continue;
      }
      const already = sentFiles.get(local.path);
      if (already) { replacements.set(ref.start, `📎 **${label}**（${already}）`); continue; }
      let status: string;
      if (files.length >= this.options.maxFiles) status = `超过单条回答 ${this.options.maxFiles} 个文件上限`;
      else if (local.size > this.options.maxFileBytes) status = `文件超过 ${this.options.maxFileBytes / 1048576} MB`;
      else if (local.size === 0) status = '空文件未发送';
      else {
        const result = await this.upload(this.localSig(local), deadline, () =>
          this.uploader!.uploadFile(readFileSync(local.path), name, feishuFileType(name)));
        if (result.key) { files.push({ key: result.key, name }); status = '文件见下方消息'; }
        else status = `文件未能发送：${result.error}`;
      }
      sentFiles.set(local.path, status);
      replacements.set(ref.start, `📎 **${label}**（${status}）`);
    }
    let output = this.rewrite(markdown, ref => replacements.get(ref.start));
    for (const item of generated) {
      if (item.savedPath && [...embedded].some(path => path === item.savedPath || path === safeRealpath(item.savedPath!))) continue;
      let data: Buffer;
      try { data = Buffer.from(item.data, 'base64'); } catch { continue; }
      if (!data.length || data.length > this.options.maxImageBytes || ++images > this.options.maxImages) continue;
      const result = await this.upload(signature('generated', createHash('sha256').update(data).digest('hex')), deadline,
        () => this.uploader!.uploadImage(data));
      output += result.key ? `\n${imageMarkdown('生成的图片', result.key)}` : `\n\n🖼 生成的图片未能发送：${result.error}`;
    }
    return { markdown: output, files };
  }

  private localSig(local: Local): string { return signature(local.kind, local.path, local.size, local.mtime); }

  private async upload(sig: string, deadline: number, run: () => Promise<string>): Promise<{ key?: string; error?: string }> {
    const cached = this.cache.mediaGet(sig);
    if (cached?.key) return { key: cached.key };
    if (cached?.error && cached.next_at > Date.now()) return { error: `${cached.error}；稍后点击刷新重试` };
    if (Date.now() > deadline) return { error: '处理超时，点击刷新重试' };
    try {
      const key = await run();
      this.cache.mediaPut(sig, key);
      return { key };
    } catch (error) {
      this.cache.mediaFail(sig, reason(error));
      return { error: reason(error) };
    }
  }

  private rewrite(markdown: string, replace: (ref: Reference) => string | undefined): string {
    let output = '', cursor = 0;
    for (const ref of findReferences(markdown)) {
      const replacement = replace(ref);
      if (replacement === undefined) continue;
      output += markdown.slice(cursor, ref.start) + replacement;
      cursor = ref.end;
    }
    return output + markdown.slice(cursor);
  }
}
