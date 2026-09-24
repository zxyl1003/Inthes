import createDOMPurify from 'dompurify';
import type { Session, SourceImage, ImageInput } from './types.ts';
import { marked, renderFormula } from './markdown.ts';
import { figureBytes } from './figure-assets.ts';
import { saveNote, sourceURL } from './zotero.ts';
import { wordDocument } from './word-export.ts';
import { replaceCitations } from './citations.ts';

export type ExportFormat = 'md' | 'json' | 'pdf' | 'docx';
export const exportFormats: [ExportFormat, string][] = [['md','Markdown (.md)'],['json','JSON (.json)'],['pdf','PDF (.pdf)'],['docx','Word (.docx)']];
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const mdText = (text: string) => text.replace(/[\\`*_{}[\]<>#!|]/g, '\\$&').replace(/\r?\n/g, ' ');
export function exportName(title: string) {
  const name = title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '').slice(0, 90);
  return !name || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) ? 'Inthes 对话' : name;
}
async function portableImage(image: SourceImage | ImageInput): Promise<ImageInput> {
  if ('data' in image) return { data:image.data, mimeType:image.mimeType, width:image.width, height:image.height };
  const bytes = await figureBytes(image); let binary = '';
  for (let i=0;i<bytes.length;i+=32768) binary += String.fromCharCode(...bytes.subarray(i,i+32768));
  return { data:btoa(binary), mimeType:image.mimeType, width:image.width, height:image.height };
}
type ExportPart = { kind: 'title' | 'meta' | 'papers' | 'question' | 'answer-label' | 'answer' | 'sources-label' | 'source'; text: string };
async function historyContent(sessions: Session[]) {
  const documents: { parts: ExportPart[]; definitions: string[] }[] = [];
  let citationNumber=0;
  for (const [index,session] of sessions.entries()) {
    const parts:ExportPart[]=[], definitions:string[]=[];
    const add=(kind:ExportPart['kind'],text:string)=>parts.push({kind,text});
    add('title',`# ${mdText(session.title)}`);
    add('meta',`Inthes · 阅读记录 · ${new Date(session.updated).toLocaleString('zh-CN')}`);
    if (session.papers.length) add('papers','**阅读文献**\n\n'+session.papers.map((p,i)=>`${i+1}. ${mdText(p.title)}`).join('\n'));
    const cited = new Map<string,number>();
    let question=0,imageNumber=0;
    const imageMarkdown=async(image:SourceImage | ImageInput,label:string)=>{
      const value=await portableImage(image),ref=`folio-${index+1}-image-${++imageNumber}`;
      definitions.push(`[${ref}]: data:${value.mimeType};base64,${value.data}`);
      return `![${mdText(label)}][${ref}]`;
    };
    const cite=(text:string)=>replaceCitations(text,session.sources,source=>{
      const id=source.id;
      if (!cited.has(id)) cited.set(id,++citationNumber);
      const number=cited.get(id);
      return sourceURL(source)?`[\\[${number}\\]][folio-${index+1}-${id}]`:`[${number}]`;
    });
    for (const message of session.messages) {
      // Keep response headings below the conversation structure, without touching code or formula blocks.
      const tokens=marked.lexer(message.text);
      const firstLevel=Math.min(6,...tokens.map(t=>t.type==='heading'?t.depth:6));
      const body=[tokens.map(t=>t.type==='code'?t.raw:t.type==='heading'?`${'#'.repeat(Math.min(6,3+t.depth-firstLevel))} ${cite(t.text)}\n\n`:cite(t.raw)).join('').trim()];
      for (const [i,image] of (message.images||[]).entries()) body.push(await imageMarkdown(image,`附图 ${i+1}`));
      for (const [i,image] of (message.generatedImages||[]).entries()) body.push(await imageMarkdown(image,`生成图片 ${i+1}`));
      if (message.error) body.push(`> 未完成：${mdText(message.error)}`);
      else if (message.partial) body.push('> 此回答未完成。');
      if (message.role==='user') add('question',`## 问题 ${++question}\n\n${body.join('\n\n')}`);
      else {
        add('answer-label',`**Inthes**${message.model?` · ${mdText(message.model)}`:''}`);
        add('answer',body.join('\n\n'));
      }
    }
    if (cited.size) add('sources-label','## 引用原文');
    for (const [id,number] of cited) {
      const source=session.sources.find(s=>s.id===id)!,ref=`folio-${index+1}-${id}`,url=sourceURL(source);
      if (url) definitions.push(`[${ref}]: ${url}`);
      // MinerU excerpts already contain Markdown, LaTeX and HTML tables.
      const content=[`**[${number}] ${mdText(source.title)}${source.page?` · 第 ${source.page} 页`:''}**${url?` · [返回原文](${url})`:''}`,source.text.split(/\r?\n/).map(line=>`> ${line}`).join('\n')];
      if (source.image) content.push(await imageMarkdown(source.image,`引用 ${number} 原图`));
      add('source',content.join('\n\n'));
    }
    documents.push({parts,definitions});
  }
  return documents;
}
export async function historyMarkdown(sessions: Session[]): Promise<string> {
  const documents=await historyContent(sessions);
  return documents.map(d=>d.parts.map(p=>p.text).join('\n\n')).join('\n\n---\n\n')+'\n\n'+documents.flatMap(d=>d.definitions).join('\n')+'\n';
}
export async function historyJSON(sessions: Session[]): Promise<string> {
  const portable = [];
  for (const session of sessions) {
    const sources = [];
    for (const source of session.sources) sources.push({...source, ...(source.image?{image:await portableImage(source.image)}:{})});
    const messages=[];
    for(const message of session.messages){const generatedImages=[];for(const image of message.generatedImages||[])generatedImages.push(await portableImage(image));messages.push({...message,...(message.generatedImages?{generatedImages}:{})});}
    portable.push({...session,sources,messages});
  }
  return JSON.stringify({format:'folio-conversations',version:1,exportedAt:new Date().toISOString(),sessions:portable},null,2);
}
export async function historyDocument(win: any, sessions: Session[], note = false): Promise<Document> {
  const purify=createDOMPurify(win),documents=await historyContent(sessions);
  const doc=new win.DOMParser().parseFromString('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>','text/html') as Document;
  for (const document of documents) for (const part of document.parts) {
    const definitions=document.definitions.filter(d=>part.text.includes(d.slice(0,d.indexOf(']:')+1)));
    const markup=marked.parse(part.text+'\n\n'+definitions.join('\n'),{async:false}) as string;
    const clean=purify.sanitize(markup,{ALLOWED_TAGS:['p','br','strong','em','del','ul','ol','li','blockquote','pre','code','h1','h2','h3','h4','h5','h6','table','thead','tbody','tfoot','caption','tr','td','th','a','hr','span','img'],ALLOWED_ATTR:['href','src','alt','start','rowspan','colspan','data-folio-math'],ALLOW_DATA_ATTR:false,ADD_URI_SAFE_ATTR:['data-folio-math','rowspan','colspan'],ALLOWED_URI_REGEXP:/^(?:https?:|zotero:|data:image\/(?:png|jpeg|webp);base64,)/i});
    const section=doc.createElement('section');section.className='export-'+part.kind;section.dataset.folioKind=part.kind;
    const fragment=new win.DOMParser().parseFromString(clean,'text/html');section.append(...Array.from(fragment.body.childNodes) as Node[]);doc.body.append(section);
  }
  for (const link of doc.querySelectorAll('a')) if (!/^(https?:|zotero:)/i.test(link.getAttribute('href')||'')) link.removeAttribute('href');
  for (const img of doc.querySelectorAll('img')) if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/i.test(img.getAttribute('src')||'')) img.replaceWith(doc.createTextNode(img.alt||'[图片]'));
  for (const formula of doc.querySelectorAll<HTMLElement>('[data-folio-math]')) {
    const display=formula.dataset.folioMath==='display',tex=formula.textContent||'';
    if(note){
      const math=doc.createElement(display?'pre':'span');math.className='math';math.textContent=display?`$$${tex}$$`:`$${tex}$`;formula.replaceWith(math);continue;
    }
    const math=new win.DOMParser().parseFromString(renderFormula(tex,display),'text/html');formula.replaceChildren(...Array.from(math.body.childNodes) as Node[]);
    formula.className=display?'display-formula':'formula';formula.removeAttribute('data-folio-math');
  }
  return doc;
}
export async function saveHistoryNote(win:any,session:Session) {
  const doc=await historyDocument(win,[session],true),images=Array.from(doc.querySelectorAll('img'));
  const libraryID=session.papers[0]?.libraryID??Zotero.Libraries.userLibraryID;
  if(images.length&&!Zotero.Libraries.get(libraryID).filesEditable)throw new Error('当前文库不允许保存图片附件，无法保存完整会话笔记');
  const id=await saveNote(session.papers,`<div data-schema-version="9"><h1>${escape(session.title)}</h1></div>`),note=Zotero.Items.get(id);
  try {
    for(const image of images){
      const src=image.getAttribute('src')!,binary=atob(src.slice(src.indexOf(',')+1)),bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));
      const attachment=await Zotero.Attachments.importEmbeddedImage({blob:new win.Blob([bytes],{type:src.slice(5,src.indexOf(';'))}),parentItemID:id});
      image.removeAttribute('src');image.setAttribute('data-attachment-key',attachment.key);
    }
    for(const section of doc.querySelectorAll('section'))section.replaceWith(...Array.from(section.childNodes));
    note.setNote(`<div data-schema-version="9">${doc.body.innerHTML}</div>`);await note.saveTx();return id;
  }catch(error){await note.eraseTx();throw error;}
}
const printStyle=`
@page{size:A4;margin:18mm 20mm}
body{font:10.5pt/1.5 'Microsoft YaHei','Noto Sans CJK SC',sans-serif;color:#252b28;margin:0}
h1,h2,h3,h4,h5,h6{font-weight:650;text-align:left;line-height:1.35;page-break-inside:avoid;page-break-after:avoid}h1+p,h2+p,h3+p,h4+p,h5+p,h6+p{page-break-before:avoid}
h1{font-size:18pt;margin:0 0 7pt}h2{font-size:12pt;margin:16pt 0 7pt}h3{font-size:12pt;margin:12pt 0 5pt}h4{font-size:11pt;margin:10pt 0 4pt}h5,h6{font-size:10.5pt;margin:8pt 0 4pt}
p{margin:0 0 6pt;overflow-wrap:anywhere;orphans:2;widows:2}
.export-title:not(:first-child){break-before:page}.export-meta{font-size:9pt;color:#738078;margin-bottom:12pt}
.export-papers{font-size:9.5pt;color:#59655e;margin-bottom:14pt}.export-papers p{margin-bottom:3pt}.export-papers ol{margin:0}
.export-question{background:#f2f5f2;padding:8pt 10pt;margin:14pt 0 10pt;border-left:2pt solid #a6b7a9}.export-question h2{font-size:9pt;color:#596e60;margin:0 0 4pt}.export-question>:last-child{margin-bottom:0}
.export-answer-label{font-size:9pt;color:#738078;margin:10pt 0 5pt;break-after:avoid}.export-answer>:first-child{margin-top:0}
.export-sources-label{margin-top:18pt;border-top:1px solid #dce2dc;padding-top:10pt}.export-sources-label h2{font-size:11pt;margin:0 0 8pt}
.export-source{font-size:9pt;line-height:1.5;color:#657067;margin-bottom:11pt}.export-source>p:first-child{color:#455249;break-after:avoid}
ul,ol{padding-left:20pt;margin:4pt 0 7pt}li{margin:2pt 0}li p{margin:0 0 3pt}
blockquote{margin:6pt 0;padding-left:10pt;border-left:2px solid #d3ddd4;color:#657067}blockquote p{margin-bottom:4pt}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f3;padding:8pt;border-radius:3pt}code{font:9pt/1.45 Consolas,monospace}
table{width:100%;border-collapse:collapse;margin:8pt 0;font-size:9.5pt;line-height:1.4}th,td{border:1px solid #dce2dc;padding:5pt 7pt;text-align:left;overflow-wrap:anywhere}th{background:#f1f4f1;font-weight:600}thead{display:table-header-group}tr,p:has(>img){break-inside:avoid}
img{display:block;margin:7pt auto;max-width:100%;max-height:210mm;object-fit:contain}a{color:#496e59;text-decoration:none}hr{border:0;border-top:1px solid #dce2dc;margin:10pt 0}
.display-formula{display:block;text-align:center;margin:9pt 0;break-inside:avoid}math{font-family:'Cambria Math',serif}
.export-heading-group{break-inside:avoid;page-break-inside:avoid}
`;

export async function writeHistoryExport(win: any, sessions: Session[], format: ExportFormat, path: string) {
  if (!sessions.length) throw new Error('没有可导出的对话');
  if (format==='json'||format==='md') {
    const text=await (format==='json'?historyJSON(sessions):historyMarkdown(sessions));
    await IOUtils.writeUTF8(path,text,{tmpPath:path+'.folio-tmp'}); return;
  }
  const doc=await historyDocument(win,sessions);
  if (format==='docx') { await IOUtils.write(path,await wordDocument(win,doc),{tmpPath:path+'.folio-tmp'});return; }
  // Gecko can ignore keep-with-next on a heading at the page boundary.
  for (const heading of doc.querySelectorAll('h2,h3,h4,h5,h6')) {
    const next=heading.nextElementSibling;
    if(next?.localName==='p') {const group=doc.createElement('div');group.className='export-heading-group';heading.before(group);group.append(heading,next);}
  }
  const {HiddenBrowser}=ChromeUtils.importESModule('chrome://zotero/content/HiddenBrowser.mjs');
  const browser=new HiddenBrowser({useHiddenFrame:false,blockRemoteResources:true});
  const htmlPath=PathUtils.join(PathUtils.tempDir,`folio-export-${crypto.randomUUID()}.html`), pdfPath=path+'.folio-tmp';
  try {
    await IOUtils.writeUTF8(htmlPath,`<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>${escape(sessions.length===1?sessions[0].title:'Inthes 已归档对话')}</title><style>${printStyle}</style></head><body>${doc.body.innerHTML}</body></html>`);
    if (!await browser.load(htmlPath)) throw new Error('无法准备 PDF 导出');
    await browser.waitForDocument();
    const settings=win.PrintUtils.getPrintSettings(win.PrintUtils.SAVE_TO_PDF_PRINTER,true);
    Object.assign(settings,{outputDestination:Ci.nsIPrintSettings.kOutputDestinationFile,outputFormat:Ci.nsIPrintSettings.kOutputFormatPDF,toFileName:pdfPath,printSilent:true,printBGColors:true,printBGImages:true,paperSizeUnit:Ci.nsIPrintSettings.kPaperSizeMillimeters,paperWidth:210,paperHeight:297,headerStrLeft:'',headerStrCenter:'',headerStrRight:'',footerStrLeft:'',footerStrCenter:'',footerStrRight:''});
    await browser.browsingContext.print(settings);
    try { await IOUtils.move(pdfPath,path,{noOverwrite:false}); }
    catch (error) {
      if ((error as Error).name!=='NotAllowedError'&&!String(error).includes('NS_ERROR_FILE_ACCESS_DENIED')) throw error;
      throw new Error(`无法保存 PDF：目标文件可能正被其他程序占用，或保存位置不允许写入。请关闭正在查看该 PDF 的程序后重试，或换一个文件名 / 保存位置。\n${path}`);
    }
  } finally {
    browser.destroy();await IOUtils.remove(htmlPath,{ignoreAbsent:true});await IOUtils.remove(pdfPath,{ignoreAbsent:true});
  }
}
export async function exportHistory(win:any,sessions:Session[],format:ExportFormat):Promise<boolean> {
  const {FilePicker}=ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs'),picker=new FilePicker();
  picker.init(win,'导出对话',picker.modeSave);picker.defaultString=exportName(sessions.length===1?sessions[0].title:'Inthes 已归档对话')+'.'+format;picker.defaultExtension=format;picker.appendFilter(exportFormats.find(f=>f[0]===format)![1],'*.'+format);
  const result=await picker.show();if(result!==picker.returnOK&&result!==picker.returnReplace)return false;
  await writeHistoryExport(win,structuredClone(sessions),format,picker.file);return true;
}
