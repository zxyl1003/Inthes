import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {originalFigure} from '../src/figure-assets.ts';
const bundle=await build({stdin:{contents:"export {PdfCache} from './src/cache.ts';export {readPapers} from './src/zotero.ts';",resolveDir:process.cwd()},bundle:true,platform:'node',format:'cjs',write:false});
function harness(enabled:()=>boolean=()=>true) {
  const directories=new Set(['/cache']);const files=new Map<string,any>(),calls:number[]=[],imageReads:string[]=[],stats=new Map([[1,{size:10,lastModified:1}],[2,{size:20,lastModified:1}]]);let extraction:(id:number,pages?:number[]|null)=>Promise<any>=async id=>({text:`PDF ${id} page 1\fPDF ${id} page 2`,extractedPages:2});
  const module={exports:{} as any};runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,DOMException,crypto,atob,btoa,PathUtils:{join:path.posix.join,filename:path.posix.basename},Zotero:{Items:{get:(id:number)=>({libraryID:1,key:`KEY${id}`,getFilePathAsync:async()=>`/pdf/${id}`,getField:()=>''})},PDFWorker:{getFullText:async(id:number,pages?:number[]|null)=>{calls.push(id);return extraction(id,pages);}}},IOUtils:{exists:async(p:string)=>files.has(p)||directories.has(p),makeDirectory:async(p:string)=>{while(p!=='/'){directories.add(p);p=path.posix.dirname(p);}},stat:async(p:string)=>p.startsWith('/pdf/')?stats.get(Number(p.slice(5))):{type:directories.has(p)?'directory':'regular'},read:async(p:string)=>{imageReads.push(p);if(!files.has(p))throw Error("Missing image");return new Uint8Array(files.get(p));},write:async(p:string,b:Uint8Array)=>files.set(p,new Uint8Array(b)),readJSON:async(p:string)=>structuredClone(files.get(p)),writeUTF8:async(p:string,s:string)=>files.set(p,JSON.parse(s)),getChildren:async(dir:string)=>[...files.keys(),...directories].filter(p=>path.posix.dirname(p)===dir&&p!==dir),remove:async(p:string,options:any={})=>{files.delete(p);directories.delete(p);if(options.recursive){for(const k of files.keys())if(k.startsWith(p+'/'))files.delete(k);for(const k of directories)if(k.startsWith(p+'/'))directories.delete(k);}}}});
  return {cache:new module.exports.PdfCache(()=>'/cache',enabled),readPapers:module.exports.readPapers,files,calls,imageReads,stats,extract:(fn:typeof extraction)=>{extraction=fn;}};
}
const paper=(id:number)=>({id,title:`Paper ${id}`,attachmentID:id,libraryID:1});
test('missing, deleted and non-attachment items report the download error before file access',async()=>{
  for(const item of [undefined,{deleted:true,getFilePathAsync:()=>{throw Error('Must not read trash');}},{}]){
    const module={exports:{} as any};runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,Zotero:{Items:{get:()=>item}}});
    await assert.rejects(new module.exports.PdfCache(()=>'/cache').read(1,new AbortController().signal),/PDF 附件不在本机/);
  }
});
test('PDF text cache deduplicates simultaneous reads, survives sessions and invalidates on modification',async()=>{
  const h=harness(),signal=new AbortController().signal;
  await Promise.all([h.cache.read(1,signal),h.cache.read(1,signal)]);await h.cache.read(1,signal);assert.deepEqual(h.calls,[1]);
  h.stats.get(1)!.lastModified++;await h.cache.read(1,signal);assert.deepEqual(h.calls,[1,1]);
});

test('disabled cache bypasses existing files without saving or deleting them and can be re-enabled',async()=>{
  let enabled=true;const h=harness(()=>enabled),signal=new AbortController().signal;
  await h.cache.read(1,signal);const cached=structuredClone(h.files.get('/cache/folio-pdf-v1-1-KEY1.json'));
  enabled=false;h.cache.invalidate();h.extract(async()=>({text:'Fresh extraction',extractedPages:1}));
  assert.deepEqual(Array.from((await h.cache.read(1,signal)).pages),['Fresh extraction']);await h.cache.read(2,signal);
  assert.equal(h.files.size,1);assert.deepEqual(h.files.get('/cache/folio-pdf-v1-1-KEY1.json'),cached);
  enabled=true;h.cache.invalidate();await h.cache.read(1,signal);assert.deepEqual(h.calls,[1,1,2]);
  enabled=false;await h.cache.clear();assert.equal(h.files.size,0);
});

test('turning off cache during extraction prevents late writes',async()=>{
  let enabled=true;const h=harness(()=>enabled);let release!:(result:any)=>void;
  h.extract(()=>new Promise(r=>release=r));const work=h.cache.read(1,new AbortController().signal);
  while(!release)await new Promise(r=>setImmediate(r));enabled=false;h.cache.invalidate();release({text:'Still usable in the current conversation',extractedPages:1});
  assert.equal((await work).pages.length,1);assert.equal(h.files.size,0);
});
test('corrupt cache is re-extracted with a visible warning; clear only removes owned files',async()=>{
  const h=harness();h.files.set('/cache/folio-pdf-v1-1-KEY1.json',{pages:42});h.files.set('/cache/notes.json',{text:'keep'});
  const result=await h.cache.read(1,new AbortController().signal);assert.match(result.warning,/重新提取/);await h.cache.clear();assert.equal(h.files.size,1);assert.equal(h.files.has('/cache/notes.json'),true);
});
test('cancel during PDF extraction returns immediately and late results cannot recreate cleared cache',async()=>{
  const h=harness();let release!:(result:any)=>void;h.extract(()=>new Promise(r=>release=r));const control=new AbortController(),work=h.cache.read(1,control.signal);
  while(!release)await new Promise(r=>setImmediate(r));control.abort();await assert.rejects(work,/abort/i);await h.cache.clear();release({text:'Late PDF',extractedPages:1});await new Promise(r=>setImmediate(r));assert.equal(h.files.size,0);
});
test('partial reading lists failed papers, retains successful evidence and retries failures without re-extracting successes',async()=>{
  const h=harness();let fail=true;h.extract(async id=>{if(id===1&&fail)throw Error('Damaged PDF');return {text:'Evidence',extractedPages:1};});
  const read=()=>h.readPapers([paper(1),paper(2)],new AbortController().signal,()=>{},h.cache);
  const result=await read();assert.equal(result.failures[0].paper.id,1);assert.match(result.failures[0].reason,/Damaged/);assert.deepEqual(Array.from(result.papers,(p:any)=>p.id),[2]);assert.equal(result.sources[0].id,'S1P1C1');
  fail=false;const retried=await read();assert.equal(retried.failures.length,0);assert.deepEqual(h.calls,[1,2,1]);assert.equal(retried.sources[1].id,'S2P1C1');
});

test('MinerU and Zotero caches stay separate, include parsing options and preserve figure citation pages',async()=>{
  const h=harness(),control=new AbortController();let remoteCalls=0;
  const bytes=new Uint8Array([1,2,3]),image={...await originalFigure(bytes,'image/jpeg',100,100),file:'images/figure.jpg'};
  const reader={key:'vlm-ch',extract:async()=>{remoteCalls++;return {pages:['Body',''],figures:[{page:2,text:'Figure 1',image}],archive:{zip:bytes,files:{'images/figure.jpg':bytes}}};}};
  await h.cache.read(1,control.signal);await h.cache.read(1,control.signal,reader);await h.cache.read(1,control.signal,reader);
  assert.equal(remoteCalls,1);assert.deepEqual(h.calls,[1]);assert.equal(h.files.size,4);
  await h.cache.read(1,control.signal,{...reader,key:'vlm-en'});assert.equal(remoteCalls,2);
  const read=await h.readPapers([paper(1)],control.signal,()=>{},h.cache,{...reader,key:'vlm-en'});
  assert.equal(read.sources[1].id,'S1P2C1');assert.equal(read.sources[1].page,2);assert.equal(read.sources[1].image.data,undefined);assert.ok(read.sources[1].image.asset.endsWith('.jpg'));
  await h.cache.read(1,control.signal);assert.deepEqual(h.calls,[1]);
  await h.cache.clear();assert.equal(h.files.size,0);
});
test('remote failures never fall back locally and late cancelled results cannot be cached',async()=>{
  const h=harness(),control=new AbortController();let release!:(v:any)=>void;
  const reader={key:'remote',extract:()=>new Promise<any>(r=>release=r)};
  const work=h.cache.read(1,control.signal,reader);while(!release)await new Promise(r=>setImmediate(r));
  control.abort();await assert.rejects(work,/abort/i);release({pages:['Late result']});await new Promise(r=>setImmediate(r));assert.equal(h.files.size,0);assert.deepEqual(h.calls,[]);
  const result=await h.readPapers([paper(1)],new AbortController().signal,()=>{},h.cache,{key:'remote',extract:async()=>{throw Error('MinerU failed');}});
  assert.equal(result.failures.length,1);assert.deepEqual(h.calls,[]);
});

test('original figure files stay byte-identical, cache reads are lazy, and clear preserves open conversations',async()=>{
  const h=harness(),signal=new AbortController().signal,bytes=new Uint8Array([137,80,78,71,1,2,3]);
  const image={...await originalFigure(bytes,'image/png',3200,2000),file:'images/figure.png'};
  const reader={key:'vlm',extract:async()=>({pages:['Caption'],figures:[{page:1,text:'Figure',image}],archive:{zip:bytes,files:{'images/figure.png':bytes}}})};
  const first=await h.cache.read(1,signal,reader),ref=first.figures[0].image;
  const asset=path.posix.join(ref.directory,ref.file);
  assert.deepEqual(Array.from(h.files.get(asset)),Array.from(bytes));assert.equal(ref.width,3200);assert.equal(ref.bytes,undefined);
  const saved=h.files.get('/cache/folio-mineru-v2-1-KEY1.json');assert.equal(saved.version,2);assert.equal(saved.figures[0].image.data,undefined);assert.equal(saved.figures[0].image.directory,undefined);
  const reopened=await h.cache.read(1,signal,reader);assert.equal(reopened.figures[0].image.asset,ref.asset);assert.equal(h.imageReads.length,0);
  h.files.set('/cache/personal.png',bytes);h.files.set('/history/folio-history-images/'+ref.asset,bytes);
  await h.cache.clear([ref]);assert.deepEqual(Array.from(ref.bytes),Array.from(bytes));assert.equal(h.files.has(asset),false);
  assert.ok(h.files.has('/cache/personal.png'));assert.ok(h.files.has('/history/folio-history-images/'+ref.asset));
});
test('old cache is ignored and disabled caching keeps originals in memory',async()=>{
  const h=harness(),signal=new AbortController().signal,legacy='/cache/folio-mineru-v1-1-KEY1.json';let calls=0;
  h.files.set(legacy,{version:1,fingerprint:JSON.stringify([1,'/pdf/1',10,1,'vlm']),pages:['Body'],figures:[{page:1,text:'Caption',image:{data:'YWJj',mimeType:'image/jpeg',width:100,height:100}}]});
  const reader={key:'vlm',extract:async()=>{calls++;return {pages:['New extraction']};}};
  const result=await h.cache.read(1,signal,reader);assert.equal(calls,1);assert.equal(result.pages[0],'New extraction');assert.ok(h.files.has(legacy));
  const disabled=harness(()=>false),image=await originalFigure(new Uint8Array([1,2,3]),'image/png',1,1);
  const transient=await disabled.cache.read(1,signal,{key:'vlm',extract:async()=>({pages:[''],figures:[{page:1,text:'Image',image}]})});
  assert.equal(disabled.files.size,0);assert.deepEqual(Array.from(transient.figures[0].image.bytes),[1,2,3]);
});

test('batch download slots are released after cache consumption even when the file changes',async()=>{
  const h=harness(),signal=new AbortController().signal;let released=0,extracted=0;
  const reader={key:'batch',batched:true,extract:async()=>{extracted++;return {pages:['test']};},release:()=>{released++;}};
  await h.cache.read(1,signal,reader);assert.equal(released,1);await h.cache.read(1,signal,reader);assert.equal(extracted,1);
  reader.extract=async()=>{h.stats.set(2,{...h.stats.get(2)!,lastModified:2});return {pages:['modified']};};
  await assert.rejects(h.cache.read(2,signal,reader),/已修改/);assert.equal(released,2);
});
test('full API bundles persist Markdown and ZIP, preserve prior turns on reparse, and clear together',async()=>{
  const h=harness(),signal=new AbortController().signal;let generation=1;
  const reader={key:'vlm',extract:async()=>{
    const bytes=new Uint8Array([generation,2,3]),image={...await originalFigure(bytes,'image/png',10,10),file:'paper/images/figure.png'};
    return {pages:['Body'],figures:[{page:1,text:'Figure',image}],archive:{zip:new Uint8Array([80,75,generation]),files:{'paper/full.md':new TextEncoder().encode('# Paper'),'paper/images/figure.png':bytes,'paper/unused.json':new Uint8Array([123,125])}}};
  }};
  const first=await h.cache.read(1,signal,reader),old=first.figures[0].image,oldFile=path.posix.join(old.directory,old.file);
  assert.ok(h.files.has(path.posix.join(old.directory,'paper/full.md')));assert.deepEqual(Array.from(h.files.get(path.posix.join(old.directory,'../result.zip'))),[80,75,1]);
  const beforeReads=h.imageReads.length;await h.cache.read(1,signal,reader);assert.equal(h.imageReads.length,beforeReads);
  h.stats.get(1)!.lastModified++;generation=2;const second=await h.cache.read(1,signal,reader);
  assert.notEqual(second.figures[0].image.directory,old.directory);assert.deepEqual(Array.from(h.files.get(oldFile)),[1,2,3]);
  h.files.set('/cache/personal.md','keep');await h.cache.clear([old,second.figures[0].image]);assert.deepEqual(Array.from(old.bytes),[1,2,3]);
  assert.deepEqual([...h.files.keys()],['/cache/personal.md']);
});

test('startup pruning retains the indexed complete MinerU bundle and ignores unrelated or corrupt caches',async()=>{
  const h=harness(),signal=new AbortController().signal;
  const reader={key:'vlm',extract:async()=>({pages:['Body'],archive:{zip:new Uint8Array([80,75]),files:{'full.md':new TextEncoder().encode('# Paper'),'data.json':new Uint8Array([123,125])}}})};
  await h.cache.read(1,signal,reader);const before=[...h.files.keys()].filter(p=>p.endsWith('/full.md'));
  h.stats.get(1)!.lastModified++;await h.cache.read(1,signal,reader);
  assert.equal([...h.files.keys()].filter(p=>p.endsWith('/full.md')).length,2);
  h.files.set('/cache/personal.md','keep');h.files.set('/cache/folio-mineru-v2-1-BAD.json',{version:2,bundle:'../../personal'});
  await h.cache.pruneOldBundles();
  assert.equal(h.files.has(before[0]),false);assert.equal([...h.files.keys()].filter(p=>p.endsWith('/full.md')).length,1);
  assert.equal([...h.files.keys()].filter(p=>p.endsWith('/data.json')).length,1);assert.equal([...h.files.keys()].filter(p=>p.endsWith('/result.zip')).length,1);
  assert.equal(h.files.has('/cache/personal.md'),true);assert.equal(h.files.has('/cache/folio-mineru-v2-1-BAD.json'),true);
  await h.cache.read(1,signal,reader);assert.equal([...h.files.keys()].filter(p=>p.endsWith('/full.md')).length,1);
});


test('trimmed blank edge pages retain exact PDF citation positions',async()=>{
  for(const pages of [['First','Second','',''],['','First','Second',''],['','','First','Second']]){
    const h=harness();h.extract(async(_id,indexes)=>({text:indexes?pages[indexes[0]]:pages.join('\f').trim(),extractedPages:indexes?1:pages.length}));
    const result=await h.cache.read(1,new AbortController().signal);
    assert.deepEqual(Array.from(result.pages),pages);
    const read=await h.readPapers([paper(1)],new AbortController().signal,()=>{},h.cache);
    assert.equal(read.sources[0].page,pages.indexOf('First')+1);
  }
});

test('pagination mismatch is rejected when missing pages are nonempty or single-page lookup is unsupported',async()=>{
  for(const single of [{text:'Nonempty final page',extractedPages:1},{text:'',extractedPages:3}]){
    const h=harness();h.extract(async(_id,indexes)=>indexes?single:{text:'First\fSecond',extractedPages:3});
    await assert.rejects(h.cache.read(1,new AbortController().signal),/分页|逐页/);assert.equal(h.files.size,0);
  }
});
