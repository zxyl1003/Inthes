import type { MinerUSettings, SourceImage } from './types.ts';
import { assetURL, download, mineruRequest, parseMinerUArchive, wait } from './mineru.ts';
import type { ParsedPDF, PdfReader } from './mineru.ts';
import { WorkQueue } from './work-queue.ts';
import { redactError } from './errors.ts';
import { abortable } from './abort.ts';

const parsing = new WorkQueue(50), uploads = new WorkQueue(3), downloads = new WorkQueue(2);

interface Pending { path: string; id: string; resolve: (value: ParsedPDF) => void; reject: (error: unknown) => void; }
export function mineruBatchReader(settings: MinerUSettings, token: string, fetcher: typeof fetch,
  signal: AbortSignal, progress: (text: string) => void, decode: (bytes: Uint8Array, name: string) => Promise<SourceImage>,
  beforeBatch: (paths: string[]) => Promise<void> = async () => {}, checkpoint: () => Promise<void> = async () => {}, concurrency = 50): PdfReader {
  parsing.setLimit(concurrency);
  let pending: Pending[] = [], timer: ReturnType<typeof setTimeout> | undefined, sequence = 0;
  const consumed = new WeakMap<ParsedPDF, () => void>();
  const clean = (error: unknown) => new Error(redactError(error, [token]).replace(/https:\/\/[^\s"'<>]+/g, '[文件服务地址]'));
  const taskSignal = signal;
  const submit = async (entries: Pending[]) => {
    const controller = new AbortController(), signal = controller.signal;
    const cancel = () => controller.abort(taskSignal.reason);
    taskSignal.addEventListener('abort', cancel, { once: true }); if (taskSignal.aborted) cancel();
    const request = (route: string, body?: unknown) => mineruRequest(token, fetcher, signal, route, body, progress);
    const outstanding = new Set(entries);
    const reject = (entry: Pending, error: unknown) => { outstanding.delete(entry); entry.reject(signal.aborted ? signal.reason : clean(error)); };
    try {
      const valid = (await Promise.all(entries.map(async entry => {
        try { const stat = await IOUtils.stat(entry.path); if (stat.size > 200 * 1024 * 1024) throw new Error('MinerU 单个 PDF 不能超过 200 MB'); return entry; }
        catch (error) { reject(entry, error); return undefined; }
      }))).filter((entry): entry is Pending => !!entry);
      if (!valid.length) return;
      await beforeBatch(valid.map(e => e.path)); signal.throwIfAborted();
      progress(`MinerU · 批量提交 ${valid.length} 篇文献`);
      const data = await request('/file-urls/batch', { files: valid.map(e => ({ name: `${e.id}.pdf`, data_id: e.id, is_ocr: settings.ocr })), model_version: settings.model, language: settings.language, enable_formula: true, enable_table: true });
      if (typeof data?.batch_id !== 'string' || !Array.isArray(data.file_urls) || data.file_urls.length !== valid.length) throw new Error('MinerU 未返回完整的批量上传任务');
      const waiting = new Map<string, Pending>();
      const sending = valid.map((entry, i) => uploads.run(signal, async () => {
        await abortable(checkpoint(), signal); signal.throwIfAborted();
        const file = await IOUtils.read(entry.path); signal.throwIfAborted();
        const response = await fetcher(assetURL(data.file_urls[i]), { method: 'PUT', body: file, signal, credentials: 'omit', redirect: 'error' });
        if (!response.ok) throw new Error(`MinerU 文献上传失败（HTTP ${response.status}）`);
        waiting.set(entry.id, entry);
      }).catch(error => reject(entry, error)));
      let sent = false;
      const uploaded = Promise.all(sending).then(() => { sent = true; });
      const receiving: Promise<void>[] = [];
      // Poll while later files are uploading. Each finished document is released independently.
      while (!sent || waiting.size) {
        signal.throwIfAborted();
        if (waiting.size) {
          const result = await request('/extract-results/batch/' + encodeURIComponent(data.batch_id));
          if (!Array.isArray(result?.extract_result)) throw new Error('MinerU 未返回批量解析状态');
          for (const row of result.extract_result) {
            const id = row.data_id || (typeof row.file_name === 'string' ? row.file_name.replace(/\.pdf$/, '') : '');
            if (!valid.some(e => e.id === id)) throw new Error('MinerU 返回了无法对应文献的批量结果');
            const entry = waiting.get(id); if (!entry) continue;
            if (row.state === 'failed') { waiting.delete(id); reject(entry, new Error('MinerU 解析失败：' + (row.err_msg || '请重试'))); }
            else if (row.state === 'done') {
              waiting.delete(id);
              receiving.push(downloads.run(signal, async () => {
                const bytes = await download(await fetcher(assetURL(row.full_zip_url), { signal, credentials: 'omit', redirect: 'error' }));
                const parsed = await parseMinerUArchive(bytes, signal, decode); signal.throwIfAborted();
                const saved = new Promise<void>(resolve => consumed.set(parsed, resolve));
                outstanding.delete(entry); entry.resolve(parsed);
                // Hold a download slot until the cache has written the complete bundle.
                // Otherwise 200 finished archives can accumulate behind disk writes.
                try { await abortable(saved, signal); } finally { consumed.delete(parsed); }
              }).catch(error => reject(entry, error)));
            } else if (!['waiting-file','pending','running','converting'].includes(row.state)) { waiting.delete(id); reject(entry, new Error('MinerU 返回了无法识别的解析状态')); }
          }
        }
        if (!sent || waiting.size) await wait(2000, signal);
      }
      await uploaded; await Promise.all(receiving);
    } catch (error) { for (const entry of outstanding) reject(entry, error); controller.abort(error); }
    finally { taskSignal.removeEventListener('abort', cancel); }
  };
  const flush = () => {
    timer = undefined;
    const batch = pending; pending = [];
    // The detailed upload endpoint currently limits each request to 50 files.
    for (let i = 0; i < batch.length; i += 50) void submit(batch.slice(i, i + 50));
  };
  signal.addEventListener('abort', () => { clearTimeout(timer); for (const entry of pending) entry.reject(signal.reason); pending = []; }, { once: true });
  return { key: JSON.stringify([settings.model, settings.language, settings.ocr]), batched: true, extract: (path, currentSignal) => {
    currentSignal.throwIfAborted(); signal.throwIfAborted();
    if (currentSignal !== signal) throw new Error('批量解析必须属于同一轮任务');
    return parsing.run(signal, () => new Promise<ParsedPDF>((resolve, reject) => {
      pending.push({ path, id: `folio-${++sequence}`, resolve, reject });
      if (timer === undefined) timer = setTimeout(flush, 50);
    }));
  }, release: parsed => consumed.get(parsed)?.() };
}
