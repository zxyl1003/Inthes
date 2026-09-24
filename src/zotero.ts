import type { Paper, Source } from './types.ts';
import { sourcePassages } from './context.ts';
import type { PdfCache } from './cache.ts';
import type { PdfReader } from './mineru.ts';
import { redactError } from './errors.ts';
import { readingQueue } from './work-queue.ts';
export function selectedPapers(win: any): Paper[] {
  const reader = Zotero.Reader.getByTabID(win.Zotero_Tabs?.selectedID);
  const selected = reader ? [Zotero.Items.get(reader.itemID)] : win.ZoteroPane.getSelectedItems();
  const papers = new Map<number, Paper>();
  for (let item of selected) {
    if (item.isNote()) continue;
    let attachmentID: number | undefined;
    if (item.isAttachment()) { if (item.isPDFAttachment()) attachmentID = item.id; item = item.parentItem || item; }
    if (!attachmentID && item.isRegularItem()) attachmentID = item.getAttachments().map((id: number) => Zotero.Items.get(id)).find((a: any) => a.isPDFAttachment() && !a.deleted)?.id;
    papers.set(item.id, { id: item.id, title: item.getField('title') || '未命名文献', attachmentID, libraryID: item.libraryID, collectionID: win.ZoteroPane.getSelectedCollection()?.id });
  }
  return [...papers.values()];
}
export interface ReadingResult { sources: Source[]; papers: Paper[]; failures: { paper: Paper; reason: string }[]; warnings: string[]; }
export async function readPaper(p: Paper, ordinal: number, signal: AbortSignal, cache: PdfCache, reader?: PdfReader, priority = 0) {
  const sources: Source[] = [];
  let warning: string | undefined;
  if (p.attachmentID) {
      const parsed = reader?.batched ? await cache.read(p.attachmentID, signal, reader) : await readingQueue.run(signal, () => cache.read(p.attachmentID!, signal, reader), priority);
      const { pages, figures } = parsed; warning = parsed.warning;
      signal.throwIfAborted();
      pages.forEach((text: string, index: number) => {
        const base = { id: `S${ordinal}P${index + 1}`, itemID: p.id, attachmentID: p.attachmentID, title: p.title, page: index + 1, text: text.trim() };
        const passages = text.trim() ? sourcePassages(base) : [];
        for (const figure of figures || []) if (figure.page === index + 1) {
          const passage = passages.length + 1;
          passages.push({ ...base, id: `${base.id}C${passage}`, passage, text: figure.text, image: figure.image });
        }
        sources.push(...passages);
      });
    } else {
      const text = Zotero.Items.get(p.id).getField('abstractNote');
      if (!text) throw new Error(`「${p.title}」没有 PDF 或摘要`);
      sources.push(...sourcePassages({ id: `S${ordinal}A`, itemID: p.id, title: p.title, text }));
    }
  if (!sources.length) throw new Error('没有可读取的原文');
  return { sources, warning };
}
export async function readPapers(papers: Paper[], signal: AbortSignal, progress: (s: string) => void, cache: PdfCache, reader?: PdfReader): Promise<ReadingResult> {
  let done = 0;
  const results = await Promise.all(papers.map(async (paper, i) => {
    try { const result = await readPaper(paper, i + 1, signal, cache, reader, 10); return { paper, ...result }; }
    catch (error) { signal.throwIfAborted(); return { paper, error: redactError(error) }; }
    finally { done++; if (!signal.aborted) progress(`正在读取文献 ${done} / ${papers.length}`); }
  }));
  const successful = results.filter(r => 'sources' in r);
  // The direct reader removes failed papers only after the user's choice. Keep
  // its displayed numbering aligned, independent of the jobs' completion order.
  return { sources: successful.flatMap((r, i) => r.sources.map(s => ({ ...s, id: s.id.replace(/^S\d+/, `S${i + 1}`) }))), papers: successful.map(r => r.paper), failures: results.flatMap(r => r.error !== undefined ? [{ paper: r.paper, reason: r.error }] : []), warnings: results.flatMap(r => 'warning' in r && r.warning ? [`「${r.paper.title}」${r.warning}`] : []) };
}
export function libraryCollections(win: any) {
  const libraryID = win.ZoteroPane.getSelectedLibraryID();
  return Zotero.Collections.getByLibrary(libraryID, true).map((c: any) => ({ id: c.id, name: c.name, level: c.level || 0 }));
}
export async function collectionPapers(collectionID: number, descendants: boolean): Promise<Paper[]> {
  const collection = Zotero.Collections.get(collectionID);
  if (!collection || collection.deleted) throw new Error('该分类已不存在，请重新选择');
  const collections = [collection, ...(descendants ? Zotero.Collections.getByParent(collectionID, true) : [])];
  const papers = new Map<number, Paper>();
  for (const c of collections) {
    await c.loadDataType('childItems');
    for (const item of c.getChildItems()) {
      if (!item.isRegularItem() || item.deleted || papers.has(item.id)) continue;
      const attachment = item.getAttachments().map((id: number) => Zotero.Items.get(id)).find((a: any) => a.isPDFAttachment() && !a.deleted);
      papers.set(item.id, { id: item.id, title: item.getField('title') || '未命名文献', libraryID: item.libraryID, collectionID, attachmentID: attachment?.id, abstract: item.getField('abstractNote') || '', year: item.getField('date') || '', authors: item.getField('firstCreator') || '' });
    }
  }
  return [...papers.values()];
}
export async function libraryFingerprint(paper: Paper, parser: string) {
  if (!paper.attachmentID) return JSON.stringify(['passages-v2', paper.id, Zotero.Items.get(paper.id)?.getField('abstractNote') || '']);
  const item = Zotero.Items.get(paper.attachmentID);
  if (!item || item.deleted) throw new Error('PDF 附件已删除');
  const path = await item.getFilePathAsync();
  if (!path) throw new Error('PDF 附件不在本机，请先下载附件');
  const stat = await IOUtils.stat(path);
  return JSON.stringify(['passages-v2', paper.attachmentID, path, stat.size, stat.lastModified, parser]);
}
export async function indexedText(paper: Paper) {
  if (!paper.attachmentID) return '';
  const item = Zotero.Items.get(paper.attachmentID);
  if (!item || item.deleted) return '';
  const path = Zotero.Fulltext.getItemCacheFile(item).path;
  return await IOUtils.exists(path) ? await IOUtils.readUTF8(path) : '';
}
export function sourceURL(s: Source) {
  const item = Zotero.Items.get(s.attachmentID || s.itemID);
  if (!item) return '';
  const library = Zotero.Libraries.get(item.libraryID);
  const path = library.libraryType === 'group' ? `groups/${library.groupID}` : 'library';
  return s.attachmentID && s.page ? `zotero://open-pdf/${path}/items/${item.key}?page=${s.page}` : `zotero://select/${path}/items/${item.key}`;
}
export function openSource(s: Source) {
  if (s.attachmentID && s.page) return Zotero.Reader.open(s.attachmentID, { pageIndex: s.page - 1 });
  return Zotero.getActiveZoteroPane().selectItem(s.itemID);
}
export async function saveNote(papers: Paper[], html: string) {
  const note = new Zotero.Item('note');
  note.libraryID = papers[0]?.libraryID ?? Zotero.Libraries.userLibraryID;
  if (!Zotero.Libraries.get(note.libraryID).editable) throw new Error('当前文库为只读，无法保存笔记');
  if (papers.length === 1 && Zotero.Items.get(papers[0].id)?.isRegularItem()) note.parentID = papers[0].id;
  else if (papers[0]?.collectionID) note.addToCollection(papers[0].collectionID);
  note.setNote(html);
  for (const p of papers) { const item = Zotero.Items.get(p.id); if (item?.libraryID === note.libraryID) note.addRelatedItem(item); }
  await note.saveTx();
  return note.id;
}
