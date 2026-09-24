import { abortable } from './abort.ts';
import type { ParsedPDF, PdfReader } from './mineru.ts';
import { validFigure } from './validation.ts';
import { figureBytes, figureMetadata, figurePath, safeAssetPath } from './figure-assets.ts';
import type { FigureImage, SourceImage } from './types.ts';

export class PdfCache {
  private pending = new Map<string, Promise<ParsedPDF & { warning?: string }>>();
  private epoch = 0;
  private writes = Promise.resolve();
  constructor(public directory: () => string, private enabled: () => boolean = () => true) {}
  invalidate() { this.epoch++; this.pending.clear(); }
  // Run only during startup, before any panel can retain references to an old bundle.
  async pruneOldBundles() {
    const directory=this.directory();if(!await IOUtils.exists(directory))return;
    for(const path of await IOUtils.getChildren(directory)){
      if(!/^folio-mineru-v2-\d+-[A-Za-z0-9]+\.json$/.test(PathUtils.filename(path)))continue;
      const saved=await IOUtils.readJSON(path).catch(()=>undefined);
      if(saved?.version!==2||typeof saved.bundle!=='string'||!/^[a-f0-9-]{36}$/.test(saved.bundle))continue;
      const parent=path.slice(0,-5);
      if(!await IOUtils.exists(PathUtils.join(parent,saved.bundle)))continue;
      for(const bundle of await IOUtils.getChildren(parent)){
        const name=PathUtils.filename(bundle);
        if(name!==saved.bundle&&/^[a-f0-9-]{36}$/.test(name)&&(await IOUtils.stat(bundle)).type==='directory')await IOUtils.remove(bundle,{recursive:true});
      }
    }
  }
  async read(attachmentID: number, signal: AbortSignal, reader?: PdfReader) {
    signal.throwIfAborted();
    const item = Zotero.Items.get(attachmentID);
    if (!item || item.deleted || typeof item.getFilePathAsync !== 'function') throw new Error('PDF 附件不在本机，请先下载附件');
    const path = await abortable(item.getFilePathAsync(), signal) as string;
    if (!path) throw new Error('PDF 附件不在本机，请先下载附件');
    const stat: any = await abortable(IOUtils.stat(path), signal);
    const fingerprint = JSON.stringify([attachmentID, path, stat.size, stat.lastModified, ...(reader ? [reader.key] : [])]);
    const filename = `folio-${reader ? 'mineru-v2' : 'pdf-v1'}-${item.libraryID}-${item.key}.json`;
    if (!/^folio-(?:pdf-v1|mineru-v2)-\d+-[A-Za-z0-9]+\.json$/.test(filename)) throw new Error('附件标识无效');
    const directory = this.directory(), epoch = this.epoch, enabled = this.enabled();
    const cachePath = PathUtils.join(directory, filename), pendingKey = cachePath + fingerprint + enabled;
    const bundleDirectory = PathUtils.join(directory, filename.replace(/\.json$/, ''));
    // A remote upload belongs to its initiating turn and must stop when that turn is cancelled.
    let work = reader ? undefined : this.pending.get(pendingKey);
    if (!work) {
      work = (async () => {
        let warning: string | undefined;
        try {
          if (enabled && await IOUtils.exists(cachePath)) {
            const saved = await IOUtils.readJSON(cachePath);
            if (saved.version !== (reader ? 2 : 1) || !Array.isArray(saved.pages) || !saved.pages.every((p: unknown) => typeof p === 'string')) throw new Error('缓存格式无效');
            if (saved.bundle !== undefined && !/^[a-f0-9-]{36}$/.test(saved.bundle)) throw new Error('缓存结果目录无效');
            if (saved.figures !== undefined && (!saved.bundle || !Array.isArray(saved.figures) || !saved.figures.every((f: any) => Number.isInteger(f?.page) && f.page > 0 && f.page <= saved.pages.length && typeof f.text === 'string' && validFigure(f.image) && f.image.file))) throw new Error('图片缓存格式无效');
            if (saved.fingerprint === fingerprint) {
              const resultDirectory = saved.bundle ? PathUtils.join(bundleDirectory, saved.bundle, 'result') : undefined;
              const parsed: ParsedPDF = { pages: saved.pages, ...(saved.figures ? { figures: saved.figures.map((f: any) => ({ ...f, image: { ...figureMetadata(f.image), directory: resultDirectory } })) } : {}) };
              for (const f of parsed.figures || []) if (!await IOUtils.exists(figurePath(f.image))) throw new Error('图片缓存缺失');
              return parsed;
            }
          }
        } catch { warning = '缓存无法读取，已重新提取 PDF。'; }
        let parsed: ParsedPDF;
        if (reader) parsed = await reader.extract(path, signal);
        else {
          const result = await Zotero.PDFWorker.getFullText(attachmentID, null, true);
          if (!result?.text?.trim()) throw new Error('没有可提取的文字，请先对扫描件完成 OCR 后重试');
          const pages: string[] = result.text.split('\f');
          if (pages.length !== result.extractedPages) {
            if (!Number.isInteger(result.extractedPages) || pages.length > result.extractedPages) throw new Error('当前 Zotero 返回的 PDF 分页格式无法识别');
            // Zotero trims the joined text, including form feeds on empty edge pages.
            // Verify those pages explicitly before restoring their citation positions.
            const missing = result.extractedPages - pages.length;
            const emptyPage = async (index: number) => {
              signal.throwIfAborted();
              const page = await Zotero.PDFWorker.getFullText(attachmentID, [index], true);
              if (page.extractedPages !== 1 || typeof page.text !== 'string') throw new Error('当前 Zotero 无法逐页核对 PDF 页码');
              return !page.text.trim();
            };
            let leading = 0;
            while (leading < missing && await emptyPage(leading)) leading++;
            for (let i = result.extractedPages - missing + leading; i < result.extractedPages; i++) {
              if (!await emptyPage(i)) throw new Error('当前 Zotero 返回的 PDF 分页格式无法识别');
            }
            pages.unshift(...Array(leading).fill(''));
            pages.push(...Array(missing - leading).fill(''));
          }
          parsed = { pages };
        }
        try {
        const after = await IOUtils.stat(path);
        if (after.size !== stat.size || after.lastModified !== stat.lastModified) throw new Error('读取期间 PDF 已修改，请重试');
        let result = parsed;
        this.writes = this.writes.catch(() => {}).then(async () => {
          if (!enabled || !this.enabled() || epoch !== this.epoch || (reader && signal.aborted)) return;
          const bundle = parsed.archive ? crypto.randomUUID() : undefined;
          const resultDirectory = bundle ? PathUtils.join(bundleDirectory, bundle, 'result') : undefined;
          if (parsed.archive) {
            await IOUtils.makeDirectory(resultDirectory, { ignoreExisting: true, createAncestors: true });
            for (const [name, bytes] of Object.entries(parsed.archive.files)) {
              if (!safeAssetPath(name)) throw new Error('MinerU 结果文件路径无效');
              const parts = name.split('/'), file = parts.pop()!;
              const parent = PathUtils.join(resultDirectory, ...parts);
              await IOUtils.makeDirectory(parent, { ignoreExisting: true, createAncestors: true });
              const destination = PathUtils.join(parent, file);
              await IOUtils.write(destination, bytes, { tmpPath: destination + '.tmp' });
            }
            const zip = PathUtils.join(bundleDirectory, bundle, 'result.zip');
            await IOUtils.write(zip, parsed.archive.zip, { tmpPath: zip + '.tmp' });
          }
          const figures: { page: number; text: string; image: FigureImage }[] | undefined = parsed.figures ? [] : undefined;
          for (const f of parsed.figures || []) {
            if (!f.image.file || !parsed.archive?.files[f.image.file]) throw new Error('MinerU 图片未包含在结果包中');
            const image = { ...figureMetadata(f.image), directory: resultDirectory };
            figures!.push({ ...f, image });
          }
          // Disabling/clearing while assets are being written must not publish a late index.
          if (!this.enabled() || epoch !== this.epoch || (reader && signal.aborted)) return;
          await IOUtils.makeDirectory(directory, { ignoreExisting: true, createAncestors: true });
          await IOUtils.writeUTF8(cachePath, JSON.stringify({ version: reader ? 2 : 1, fingerprint, bundle, pages: parsed.pages, ...(figures ? { figures: figures.map(f => ({ ...f, image: figureMetadata(f.image) })) } : {}) }), { tmpPath: cachePath + '.tmp' });
          result = { pages: parsed.pages, ...(figures ? { figures } : {}) };
        });
        try { await this.writes; } catch { warning = 'PDF 已读取，但无法保存缓存；请检查缓存位置。'; }
        return { ...result, warning };
        } finally { reader?.release?.(parsed); }
      })();
      if (!reader) this.pending.set(pendingKey, work);
      const clear = () => { if (this.pending.get(pendingKey) === work) this.pending.delete(pendingKey); };
      work.then(clear, clear);
    }
    return abortable(work, signal);
  }
  async clear(preserve: SourceImage[] = []) {
    this.invalidate();
    const directory = this.directory();
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (!await IOUtils.exists(directory)) return;
      const children: string[] = await IOUtils.getChildren(directory);
      const bundles = children.filter(path => /^folio-mineru-v2-\d+-[A-Za-z0-9]+$/.test(PathUtils.filename(path)));
      for (const image of preserve) if (bundles.some(path => image.directory?.startsWith(path + (path.includes('\\') ? '\\' : '/'))) && !image.bytes) image.bytes = await figureBytes(image);
      for (const path of children) {
        // Only Folio's own cache files, never an arbitrary directory or its other contents.
        if (!/^folio-(?:pdf-v1|mineru-v2)-\d+-[A-Za-z0-9]+\.json(?:\.tmp)?$/.test(PathUtils.filename(path))) continue;
        if ((await IOUtils.stat(path)).type === 'regular') await IOUtils.remove(path);
      }
      for (const path of bundles) if ((await IOUtils.stat(path)).type === 'directory') await IOUtils.remove(path, { recursive: true });
    });
    await this.writes;
  }
}
