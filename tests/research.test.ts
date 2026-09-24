import test from 'node:test';
import assert from 'node:assert/strict';
import {ResearchRun, paperIdentifier, researchPrompt} from '../src/research.ts';
import type {ResearchPaper, ResearchServices, ResearchCollection} from '../src/research.ts';
import {resolvedPaper, duplicatePaper, importResearchPapers} from '../src/research-zotero.ts';
import {validateSessions} from '../src/validation.ts';

const doi='10.1234/paper',identifier='doi:'+doi;
const paper:ResearchPaper={identifier,title:'Visual Geo-Localization',date:'2025-01-02',authors:['Ada Smith'],doi,url:'https://doi.org/'+doi,metadata:{itemType:'journalArticle',title:'Visual Geo-Localization',DOI:doi,date:'2025-01-02',creators:[{firstName:'Ada',lastName:'Smith',creatorType:'author'}]}};
const target:ResearchCollection={id:3,libraryID:1,name:'定位',path:'我的文库 / 定位'};
const call=(name:string,arguments_:unknown)=>({id:'call',name,arguments:arguments_});
function fixture(extra:Partial<ResearchServices>={},nativeSearch=false) {
  const controller=new AbortController(),imports:ResearchPaper[][]=[],services:ResearchServices={collections:()=>[target],resolve:async()=>structuredClone(paper),import:async(papers,_target,_signal,done)=>{imports.push(papers);papers.forEach(p=>done({identifier:p.identifier,title:p.title,status:'created',itemID:1}));},progress:()=>{},error:e=>String(e),...extra};
  const run=new ResearchRun(controller.signal,services,3,nativeSearch);
  const execute=async(name:string,args:unknown)=>JSON.parse((await run.execute(call(name,args))).text);
  return {run,controller,imports,execute};
}
test('API research requires actual search results and keeps failures visible',async()=>{
  const h=fixture({search:async()=>({sources:[],summary:''})});
  assert.equal(h.run.webSearch,false);assert.equal(h.run.definitions[0].name,'search_research_papers');
  assert.doesNotThrow(()=>h.run.checkSearch());
  await h.execute('search_research_papers',{query:'geolocation papers'});h.run.checkSearch();
  const bad=fixture({search:async()=>{throw Error('provider does not support search');}});
  await assert.rejects(bad.execute('search_research_papers',{query:'papers'}),/does not support/);
  assert.throws(()=>bad.run.checkSearch(),/未确认成功完成/);assert.equal(bad.imports.length,0);
});

test('native search validation follows actual tool events rather than user wording',()=>{
  const h=fixture({},true);assert.equal(h.run.webSearch,true);h.run.checkSearch();
  h.run.searchStarted();assert.throws(()=>h.run.checkSearch(),/未确认成功完成/);
  h.run.searchCompleted();h.run.checkSearch();
});

test('one model turn can use local and research tools without intent classification',async()=>{
  const h=fixture({search:async()=>({sources:[],summary:'Web evidence'})});let reads=0;
  const tools=h.run.withTools({definitions:[{name:'read_current_papers',description:'Read',parameters:{type:'object'}}],execute:async()=>{reads++;return {text:'Local evidence'};}});
  assert.ok(tools.definitions.some(t=>t.name==='read_current_papers'));assert.ok(tools.definitions.some(t=>t.name==='search_research_papers'));
  assert.equal((await tools.execute(call('read_current_papers',{}))).text,'Local evidence');assert.equal(reads,1);
  assert.equal(JSON.parse((await tools.execute(call('search_research_papers',{query:'recent papers'}))).text).summary,'Web evidence');
  assert.match(researchPrompt('native'),/自主选择工具/);assert.match(researchPrompt('disabled'),/未开启联网/);
});

test('conversations without selected papers save without a sticky research mode',()=>{
  const sessions=[{id:'research',title:'Papers',updated:1,papers:[],sources:[],messages:[{role:'user',text:'Recent developments?'},{role:'assistant',text:'Results'}]}];
  assert.equal(validateSessions(sessions)[0].messages.at(-1)?.text,'Results');
});

test('DOI and arXiv identifiers normalize versions and reject arbitrary URLs',()=>{
  assert.equal(paperIdentifier('https://doi.org/10.1234/PAPER').key,identifier);
  assert.equal(paperIdentifier('https://arxiv.org/pdf/2304.07193v2.pdf').key,'arxiv:2304.07193');
  assert.equal(paperIdentifier('10.48550/arXiv.2304.07193').key,'arxiv:2304.07193');
  for(const value of ['http://localhost:23119/connector/saveItems','https://publisher.example/paper','../auth.json','invalid'])assert.throws(()=>paperIdentifier(value));
});
test('collection lookup returns full paths and selection for the model to choose a target',async()=>{
  const other={...target,id:4,path:'小组 / 定位'},h=fixture({collections:()=>[target,other]});
  const found=await h.execute('find_import_collections',{query:'定位'});
  assert.equal(found.collections.length,2);assert.equal(found.collections[0].path,target.path);assert.equal(found.collections[0].selected,true);assert.equal(found.collections[1].selected,false);assert.equal(h.imports.length,0);
});

test('metadata verification requires matching identities and strips writable side effects',()=>{
  const verified=resolvedPaper(paperIdentifier(doi),{...paper.metadata,collections:[99],key:'evil',relations:{},notes:[{note:'bad'}],attachments:[{path:'private.pdf'}],tags:['unrequested']});
  assert.equal(verified.title,paper.title);assert.deepEqual(Object.keys(verified.metadata).sort(),['DOI','creators','date','itemType','title','url']);
  assert.throws(()=>resolvedPaper(paperIdentifier(doi),{...paper.metadata,DOI:'10.1234/wrong'}),/不符/);
  const arxiv=resolvedPaper(paperIdentifier('2304.07193'),{itemType:'preprint',title:'DINOv2',url:'http://arxiv.org/abs/2304.07193v2',creators:[]});
  assert.equal(arxiv.arxiv,'2304.07193');assert.equal(arxiv.url,'https://arxiv.org/abs/2304.07193');
});
test('deduplication prefers identifiers and conservatively flags publication versions',()=>{
  const existing={id:8,title:paper.title,doi,year:'2025',author:'Ada Smith'};
  assert.equal(duplicatePaper(paper,[{...existing,title:'Changed title'}]).kind,'exact');
  assert.equal(duplicatePaper(paper,[{...existing,doi:undefined,title:'Visual geo localization'}]).kind,'exact');
  assert.equal(duplicatePaper(paper,[{...existing,doi:'10.9999/version'}]).kind,'possible');
  assert.equal(duplicatePaper(paper,[existing,{...existing,id:9}]).kind,'possible');
  assert.equal(duplicatePaper(paper,[]).kind,'new');
});
test('tools reject unverified papers and unauthorized targets without any writes',async()=>{
  const h=fixture();await h.execute('find_import_collections',{query:'定位'});assert.match((await h.execute('import_research_papers',{identifiers:[doi],collection_id:3})).error,/核验/);
  await h.execute('resolve_research_papers',{identifiers:[doi]});
  assert.match((await h.execute('import_research_papers',{identifiers:[doi],collection_id:4})).error,/目标分类/);
  assert.equal(h.imports.length,0);
  const search=fixture();await search.execute('resolve_research_papers',{identifiers:[doi]});
  assert.match((await search.execute('import_research_papers',{identifiers:[doi],collection_id:3})).error,/目标分类/);assert.equal(search.imports.length,0);
});
test('lookup failures are visible while verified papers can be imported and reported',async()=>{
  const h=fixture();
  await h.execute('find_import_collections',{query:'定位'});
  const result=await h.execute('resolve_research_papers',{identifiers:[doi,'bad']});assert.deepEqual(result.papers.map((p:any)=>p.status),['verified','failed']);
  assert.equal(result.papers[0].metadata,undefined);
  await h.execute('import_research_papers',{identifiers:[doi,doi],collection_id:3});
  assert.equal(h.imports[0].length,1);assert.match(h.run.report(),/实际导入结果/);assert.match(h.run.report(),/新增/);
});
test('cancellation during lookup cannot create a verified candidate or import later',async()=>{
  let done!:(p:ResearchPaper)=>void;const h=fixture({resolve:()=>new Promise(resolve=>done=resolve)});
  const work=h.execute('resolve_research_papers',{identifiers:[doi]});await Promise.resolve();h.controller.abort();done(paper);
  await assert.rejects(work);await h.run.settle();assert.equal(h.imports.length,0);
});
test('completed receipts survive a stop after an import',async()=>{
  const h=fixture({import:async(_papers,_target,_signal,done)=>{done({identifier,title:paper.title,status:'created'});h.controller.abort();throw new Error('stopped');}});
  await h.execute('find_import_collections',{query:'定位'});
  await h.execute('resolve_research_papers',{identifiers:[doi]});await assert.rejects(h.execute('import_research_papers',{identifiers:[doi],collection_id:3}));
  assert.match(h.run.report(),/新增/);
});
test('native adapter reuses existing items across concurrent imports and preserves their metadata',async()=>{
  const items:any[]=[];let nextID=1;
  class Item {
    id=nextID++;libraryID=1;deleted=false;data:any={};collections:number[]=[];
    itemType:string;constructor(itemType:string){this.itemType=itemType;}
    fromJSON(data:any){this.data=structuredClone(data);}
    getField(name:string){return this.data[name]||'';}
    getCreators(){return (this.data.creators||[]).map((c:any)=>({...c,creatorTypeID:1}));}
    isRegularItem(){return true;}async loadAllData(){}
    inCollection(id:number){return this.collections.includes(id);}
    addToCollection(id:number){if(!this.inCollection(id))this.collections.push(id);}
    async save(){if(!items.includes(this))items.push(this);}
  }
  const previous=(globalThis as any).Zotero;
  (globalThis as any).Zotero={Item,Collections:{get:()=>({...target,deleted:false})},Libraries:{get:()=>({editable:true})},Items:{getAll:async()=>items,get:(id:number)=>items.find(i=>i.id===id)},CreatorTypes:{getName:()=> 'author'},DB:{executeTransaction:async(fn:()=>Promise<any>)=>fn()}};
  try {
    const results:string[]=[];
    await Promise.all([1,2].map(()=>importResearchPapers([paper],target,new AbortController().signal,r=>results.push(r.status))));
    assert.deepEqual(results,['created','exists']);assert.equal(items.length,1);
    items[0].data.abstractNote='Keep existing notes';items[0].collections=[];
    await importResearchPapers([paper],target,new AbortController().signal,r=>results.push(r.status));
    assert.equal(results.at(-1),'added');assert.equal(items[0].data.abstractNote,'Keep existing notes');
    assert.deepEqual(items[0].collections,[3]);
  }finally{(globalThis as any).Zotero=previous;}
});
