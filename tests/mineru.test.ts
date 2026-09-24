import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { parseMinerUArchive, mineruDefaults } from '../src/mineru.ts';
import { evidenceText, sourceTokens, selectContext, chunks } from '../src/context.ts';
import { validateSessions, validateState } from '../src/validation.ts';
import type { FigureImage, Source } from '../src/types.ts';

const image:FigureImage={asset:'a'.repeat(64)+'.jpg',mimeType:'image/jpeg',width:800,height:600};
const blocks=[{type:'text',text:'Methods',text_level:1,page_idx:0},{type:'equation',text:'x^2 + y^2',page_idx:0},{type:'table',table_body:'<table><tr><td>12</td></tr></table>',table_caption:['Table 1'],page_idx:1},{type:'image',img_path:'images/figure.jpg',image_caption:['Figure 2: Architecture'],page_idx:1}];
const archive=(list:unknown=blocks,extra:Record<string,Uint8Array>={})=>zipSync({'paper/paper_content_list.json':strToU8(JSON.stringify(list)),'paper/images/figure.jpg':strToU8('image'),...extra});
const signal=()=>new AbortController().signal;

test('cloud result preserves headings, formula, table, image captions and original page indices',async()=>{
  const parsed=await parseMinerUArchive(archive(),signal(),async(bytes,name)=>{assert.equal(name,'paper/images/figure.jpg');assert.equal(bytes.length,5);return image;});
  assert.match(parsed.pages[0],/^# Methods/);assert.match(parsed.pages[0],/\$\$\nx\^2/);assert.match(parsed.pages[1],/<td>12<\/td>/);
  assert.equal(parsed.figures?.length,1);assert.equal(parsed.figures![0].page,2);assert.match(parsed.figures![0].text,/Architecture/);
});
test('the complete returned archive retains Markdown and unused API result files unchanged',async()=>{
  const extra={'paper/full.md':strToU8('# Complete Markdown'),'paper/layout.json':strToU8('{"layout":true}'),'paper/origin.pdf':strToU8('%PDF-fixture'),'paper/images/unused.png':new Uint8Array([1,2,3])};
  const bytes=archive(blocks,extra),parsed=await parseMinerUArchive(bytes,signal(),async()=>image);
  assert.deepEqual(parsed.archive!.zip,bytes);
  for(const [name,data] of Object.entries(extra))assert.deepEqual(parsed.archive!.files[name],data);
});
test('missing images, missing page metadata and unsafe ZIP entries fail instead of losing evidence',async()=>{
  for(const bytes of [archive([{type:'image',page_idx:0,img_path:'images/missing.jpg'}]),archive([{type:'text',text:'no page'}]),archive(blocks,{'../outside.json':strToU8('{}')}),zipSync({'full.md':strToU8('No page mapping')})]) {
    await assert.rejects(parseMinerUArchive(bytes,signal(),async()=>image));
  }
});

test('archive file counts are bounded and prototype names never resolve as images',async()=>{
  const empty=Object.fromEntries(Array.from({length:10001},(_,i)=>['empty/'+i,new Uint8Array()]));
  await assert.rejects(parseMinerUArchive(archive(blocks,empty),signal(),async()=>image),/过多文件/);
  for(const name of ['constructor','__proto__','toString']){
    await assert.rejects(parseMinerUArchive(archive([{type:'image',img_path:name,page_idx:0}]),signal(),async()=>{throw Error('Must not decode a prototype');}),/图片缺失/);
  }
});
test('image-only pages are readable and cancellations do not finish archive processing',async()=>{
  const list=[{type:'image',img_path:'images/figure.jpg',page_idx:2}];
  const result=await parseMinerUArchive(archive(list),signal(),async()=>image);assert.equal(result.pages.length,3);assert.equal(result.figures![0].page,3);
  const abort=new AbortController();abort.abort();await assert.rejects(parseMinerUArchive(archive(),abort.signal,async()=>image),/abort/i);
});

test('figure inputs have citation mapping and consume selection and summary budgets',()=>{
  const sources:Source[]=[{id:'S1P1C1',itemID:1,page:1,title:'Paper',text:'caption',image},{id:'S1P1C2',itemID:1,page:1,title:'Paper',text:'Other text'}];
  assert.ok(sourceTokens(sources[0])>=2048);assert.match(evidenceText(sources),/依次对应来源：\[S1P1C1\]/);
  assert.equal(selectContext(sources,'Other',1000).sources.some(s=>s.image),false);
  const groups=chunks(sources,3000);assert.equal(groups.flat().filter(s=>s.image).length,1);assert.ok(groups.every(group=>group.reduce((n,s)=>n+sourceTokens(s),0)<=3000));
});
test('persisted parsing options and source images are validated before use',()=>{
  const state={version:1,historyFormat:2,profiles:[],selected:'',remember:true,sessions:[],mineru:mineruDefaults};assert.doesNotThrow(()=>validateState(state));
  assert.throws(()=>validateState({...state,mineru:{...mineruDefaults,model:'untrusted'}}));
  const session={id:'s1',title:'paper',updated:1,papers:[],messages:[],sources:[{id:'S1P1C1',itemID:1,title:'paper',text:'figure',image}]};
  assert.doesNotThrow(()=>validateSessions([session]));assert.throws(()=>validateSessions([{...session,sources:[{...session.sources[0],image:{...image,asset:'../unsafe.jpg'}}]}]));
});
