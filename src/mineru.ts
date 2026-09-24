import { unzip, strFromU8 } from 'fflate';
import type { SourceImage, MinerUSettings } from './types.ts';
import { redactError } from './errors.ts';
import { safeAssetPath } from './figure-assets.ts';
import { mineruSubmissions, mineruResults } from './mineru-rate-limit.ts';

export const mineruDefaults: MinerUSettings = { enabled: false, model: 'vlm', language: 'ch', ocr: false };
export const mineruCredential = 'mineru-parser';
export const mineruLanguages = [['ch','中文 / 中英混合'],['en','英语'],['japan','日语'],['korean','韩语'],['fr','法语'],['german','德语'],['es','西班牙语']] as const;
export interface ParsedPDF { pages: string[]; figures?: { page: number; text: string; image: SourceImage }[]; archive?: { zip: Uint8Array; files: Record<string, Uint8Array> }; }
export interface PdfReader { key: string; batched?: boolean; extract: (path: string, signal: AbortSignal) => Promise<ParsedPDF>; release?: (result: ParsedPDF) => void; }
const api = 'https://mineru.net/api/v4';
const maxZipBytes = 100 * 1024 * 1024;
const textParts = (value: unknown): string => typeof value === 'string' ? value : Array.isArray(value) ? value.filter(v => typeof v === 'string').join('\n') : '';

export function assetURL(value: unknown): string {
  if (typeof value !== 'string') throw new Error('MinerU 未返回下载或上传地址');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || !['mineru.net','openxlab.org.cn','aliyuncs.com','shlab.tech'].some(host => url.hostname === host || url.hostname.endsWith('.' + host))) throw new Error('MinerU 返回了无法识别的文件服务地址');
  return url.href;
}
export function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const stop = () => { clearTimeout(timer); reject(signal.reason || new DOMException('已停止', 'AbortError')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(); }, ms);
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
}
export async function download(response: Response) {
  if (!response.ok) throw new Error(`MinerU 结果下载失败（HTTP ${response.status}）`);
  if (Number(response.headers.get('content-length')) > maxZipBytes) throw new Error('MinerU 结果包过大，请减少文献页数');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('无法读取 MinerU 结果包');
  const parts: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      total += value.length;
      if (total > maxZipBytes) { await reader.cancel(); throw new Error('MinerU 结果包过大，请减少文献页数'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total); let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
}

// Keep page locations from the cloud content list; Markdown alone loses citation targets.
export async function parseMinerUArchive(bytes: Uint8Array, signal: AbortSignal,
  decodeImage: (bytes: Uint8Array, name: string) => Promise<SourceImage>): Promise<ParsedPDF> {
  if (bytes.length > maxZipBytes) throw new Error('MinerU 结果包过大');
  const files = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
    let total = 0, entries = 0, invalid = false;
    const stop = () => { cancel(); reject(signal.reason || new DOMException('已停止', 'AbortError')); };
    const cancel = unzip(bytes, { filter: file => {
      if (++entries > 10000) { invalid = true; return false; }
      if (file.name === '__proto__' || !safeAssetPath(file.name.replace(/\/$/, ''))) { invalid = true; return false; }
      if (file.name.endsWith('/')) return false;
      total += file.originalSize;
      if (total > 128 * 1024 * 1024) { invalid = true; return false; }
      return true;
    } }, (error, result) => {
      signal.removeEventListener('abort', stop);
      if (invalid) reject(new Error('MinerU 结果包包含无效路径、过大的文件或过多文件（最多 10000 项）'));
      else if (error) reject(new Error('MinerU 结果包损坏，无法解压'));
      else resolve(result);
    });
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
  });
  signal.throwIfAborted();
  const lists = Object.keys(files).filter(name => /(?:^|_)content_list\.json$/.test(name.split('/').at(-1)!));
  if (lists.length !== 1) throw new Error('MinerU 结果缺少可定位页码的内容列表，请重新解析');
  const list = JSON.parse(strFromU8(files[lists[0]]));
  if (!Array.isArray(list) || !list.length) throw new Error('MinerU 未返回可读取的文献内容');
  const prefix = lists[0].slice(0, lists[0].lastIndexOf('/') + 1);
  const pages: string[][] = [], figures: NonNullable<ParsedPDF['figures']> = [];
  let imageBytes = 0;
  for (const block of list) {
    signal.throwIfAborted();
    if (!block || !Number.isInteger(block.page_idx) || block.page_idx < 0 || block.page_idx > 9999) throw new Error('MinerU 内容列表的页码格式无法识别');
    const page = block.page_idx + 1;
    while (pages.length < page) pages.push([]);
    let text = textParts(block.text) || textParts(block.code_body) || textParts(block.list_items);
    if (block.type === 'text' && block.text_level && text) text = '#'.repeat(Math.min(6, Math.max(1, block.text_level))) + ' ' + text;
    if (block.type === 'equation' && text && !text.startsWith('$$')) text = `$$\n${text}\n$$`;
    const caption = [textParts(block.image_caption), textParts(block.table_caption), textParts(block.code_caption)].filter(Boolean).join('\n');
    const footnote = [textParts(block.image_footnote), textParts(block.table_footnote)].filter(Boolean).join('\n');
    const body = textParts(block.table_body);
    const content = [caption, body || text, footnote].filter(Boolean).join('\n\n');
    if (content) pages[page - 1].push(content);
    if (block.img_path && (block.type === 'image' || (!body && !text))) {
      if (typeof block.img_path !== 'string' || !safeAssetPath(block.img_path)) throw new Error('MinerU 图片路径无效');
      const name = Object.hasOwn(files, prefix + block.img_path) ? prefix + block.img_path : block.img_path;
      if (!Object.hasOwn(files, name)) throw new Error(`MinerU 第 ${page} 页的图片缺失，请重新解析`);
      if (files[name].length > 24 * 1024 * 1024) throw new Error('MinerU 返回的单张图片过大');
      const image = await decodeImage(files[name], name);
      imageBytes += files[name].length;
      if (imageBytes > 40 * 1024 * 1024) throw new Error('文献图片总量过大，请减少文献页数');
      figures.push({ page, text: content || `PDF 第 ${page} 页图像（无图注）`, image });
    }
  }
  if (!pages.some(p => p.length) && !figures.length) throw new Error('MinerU 未提取到文字或图片');
  return { pages: pages.map(p => p.join('\n\n')), ...(figures.length ? { figures } : {}), archive: { zip: bytes, files } };
}

export async function mineruRequest(token: string, fetcher: typeof fetch, signal: AbortSignal, route: string, body?: unknown, progress?: (text: string) => void) {
  if (!token.trim()) throw new Error('请在偏好的文献解析中填写 MinerU API Token');
  const submitting = !!body && ['/file-urls/batch','/extract/task','/extract/task/batch'].includes(route);
  const polling = !body && (route.startsWith('/extract/task/') || route.startsWith('/extract-results/batch/'));
  const limiter = submitting ? mineruSubmissions : polling ? mineruResults : undefined;
  const count = submitting ? ((body as { files?: unknown[] }).files?.length ?? 1) : 1;
  for (let attempt = 0; ; attempt++) {
    await limiter?.acquire(count, signal, progress); signal.throwIfAborted();
    const response = await fetcher(api + route, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal, credentials: 'omit', redirect: 'error' });
    if (response.status === 429 && limiter) {
      const detail = await response.text();
      if (/daily|per.day|每天|每日|当天|单日/i.test(detail)) throw new Error('MinerU 当日上传额度已达到上限，请稍后或次日重试');
      const retry = response.headers.get('Retry-After');
      const delay = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : 60000;
      limiter.defer(Math.max(60000, Number.isFinite(delay) ? delay : 60000));
      if (attempt < 2) continue;
      throw new Error('MinerU 持续限流（HTTP 429），已暂停重试；请稍后继续任务');
    }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'MinerU Token 无效或已过期，请在设置中更新' : `MinerU 请求失败（HTTP ${response.status}）`);
    const result = await response.json();
    if (result.code !== 0) throw new Error('MinerU：' + redactError(result.msg || `错误 ${result.code}`, [token]));
    return result.data;
  }
}
