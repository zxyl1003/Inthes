import test from 'node:test';
import assert from 'node:assert/strict';
import { LibraryRun, libraryState, citedSources } from '../src/library.ts';
import type { LibraryServices } from '../src/library.ts';
import type { Paper, Session, Source } from '../src/types.ts';
import { WorkQueue } from '../src/work-queue.ts';
import { validateSessions } from '../src/validation.ts';
import { collectionPapers } from '../src/zotero.ts';

function fixture(count=3, override:Partial<LibraryServices>={}) {
  const papers:Paper[]=Array.from({length:count},(_,i)=>({id:i+1,title:`Paper ${i+1}`,libraryID:1,attachmentID:i+101,abstract:'Contrastive learning',year:'2024'}));
  const session:Session={id:'session',title:'Library',updated:1,papers,sources:[],messages:[],library:libraryState(papers,'Collection')};
  const read:number[]=[],analyzed:string[]=[],saved:string[]=[],controller=new AbortController();
  const services:LibraryServices={
    async read(p,i){read.push(p.id);return {sources:[{id:`S${i}P1C1`,itemID:p.id,title:p.title,page:1,text:'Contrastive learning improves retrieval.'}]};},
    fingerprint:async p=>`unchanged-${p.id}`,index:async()=>'',image:async()=>{throw new Error('No image');},vision:false,model:'model-1',budget:2000,
    async generate(input,onText){const text=input.messages[0].content;analyzed.push(text);const id=text.match(/\[(S\d+P1C1)\]/)?.[1];onText(`Evidence [${id}]`);},
    save:async()=>{saved.push(JSON.stringify(session));},changed:()=>{},error:e=>String((e as Error).message),...override
  };
  const run=new LibraryRun(session,controller.signal,services);
  return {session,run,controller,services,read,analyzed,saved};
}
const call=(name:string,args:unknown)=>({id:'call',name,arguments:args});

test('indexed history validation still rejects source IDs belonging to another paper',async()=>{
  const h=fixture(2);await h.run.analyze(h.session.papers,'methods');validateSessions([h.session]);
  h.session.library!.jobs[0].items[0].sourceIDs=['S2P1C1'];assert.throws(()=>validateSessions([h.session]),/无效/);
  h.session.library!.jobs[0].items[0].sourceIDs=['S999P1C1'];assert.throws(()=>validateSessions([h.session]),/无效/);
});

test('completed analysis restores omitted citation variants without repeating model work',async()=>{
  const h=fixture(2);
  await h.run.analyze(h.session.papers,'methods');
  const job=h.session.library!.jobs[0];
  job.items[0].notes=['Evidence 【S1P1C1】'];job.items[0].result='Evidence [ S1P1C1 ]';job.items[0].sourceIDs=[];
  h.session.sources=h.session.sources.filter(s=>s.itemID!==1);
  delete job.synthesis;job.synthesisError='Missing reference';
  const previous=h.analyzed.length;h.read.length=0;
  const result=JSON.parse((await new LibraryRun(h.session,h.controller.signal,h.services).resumeAnalysis(job.id)).text);
  assert.equal(result.complete,2);assert.equal(result.synthesis_error,undefined);assert.match(result.synthesis,/Evidence \[S1P1C1\]/);
  assert.deepEqual(h.read,[1]);assert.equal(h.analyzed.length,previous);
  assert.deepEqual(job.items[0].sourceIDs,['S1P1C1']);assert.deepEqual(job.items[0].notes,['Evidence [S1P1C1]']);
  assert.equal(citedSources('[S1P1C1]',h.session.sources).length,1);validateSessions([h.session]);
});

test('missing saved citations fail visibly without deleting completed analysis text',async()=>{
  const h=fixture(1);await h.run.analyze(h.session.papers,'methods');
  const job=h.session.library!.jobs[0];job.items[0].notes=['Evidence 【S1P1C9】'];job.items[0].result='Evidence 【S1P1C9】';
  const result=JSON.parse((await new LibraryRun(h.session,h.controller.signal,h.services).resumeAnalysis(job.id)).text);
  assert.equal(result.complete,0);assert.equal(result.failed,1);assert.equal(result.synthesis,undefined);
  assert.match(result.items[0].error,/未提供的引用/);assert.equal(result.items[0].text,undefined);assert.equal(job.items[0].result,'Evidence 【S1P1C9】');
  assert.equal(h.analyzed.length,1);assert.equal(h.session.sources.some(s=>s.id==='S1P1C9'),false);
});

test('new analyses register and normalize non-ASCII and range references',async()=>{
  const h=fixture(1,{read:async p=>({sources:[1,2,3].map(i=>({id:`S1P1C${i}`,itemID:p.id,title:p.title,page:1,text:'Evidence'}))}),generate:async(_input,onText)=>onText('Evidence 【S1P1C1】 [ S1P1C2 ] [S1P1C2-S1P1C3]')});
  const result=JSON.parse((await h.run.analyze(h.session.papers,'methods')).text);
  assert.equal(result.complete,1);assert.equal(h.session.sources.length,3);
  assert.equal(result.items[0].text,'Evidence [S1P1C1] [S1P1C2] [S1P1C2][S1P1C3]');
  assert.deepEqual(h.session.library!.jobs[0].items[0].sourceIDs,['S1P1C1','S1P1C2','S1P1C3']);
});

test('model marker typos preserve the correct paper and passage in saved analysis',async()=>{
  const h=fixture(30,{read:async(p,ordinal)=>({sources:[{id:`S${ordinal}P7C17`,itemID:p.id,title:p.title,page:7,text:'Failed geolocation evidence.'}]}),generate:async(_input,onText)=>onText('Limitations [S30P7P17]')});
  const result=JSON.parse((await h.run.analyze([h.session.papers[29]],'limitations')).text);
  assert.equal(result.complete,1);assert.equal(result.failed,0);
  assert.equal(result.items[0].text,'Limitations [S30P7C17]');assert.equal(h.session.sources[0].id,'S30P7C17');
  assert.equal(h.session.sources[0].itemID,30);validateSessions([h.session]);
});

test('resuming partial notes restores their references before analyzing the remaining chunks',async()=>{
  let fail=true,calls=0;
  const h=fixture(1,{extractionBudget:1000,read:async p=>({sources:[1,2].map(page=>({id:`S1P${page}C1`,itemID:p.id,title:p.title,page,text:'文'.repeat(600)}))}),generate:async(input,onText)=>{calls++;if(input.messages[0].content.includes('这是第 2/2 段')){if(fail)throw Error('Interrupted');onText('Second [S1P1C1] [S1P2C1]');}else onText('First [S1P1C1]');}});
  await h.run.analyze(h.session.papers,'methods');
  const job=h.session.library!.jobs[0],before=calls;assert.equal(job.items[0].notes.length,1);
  job.items[0].notes=['First 【S1P1C1】'];job.items[0].sourceIDs=[];h.session.sources=[];fail=false;
  const result=JSON.parse((await new LibraryRun(h.session,h.controller.signal,h.services).resumeAnalysis(job.id)).text);
  assert.equal(result.complete,1);assert.equal(calls,before+1);assert.equal(h.session.sources.length,2);
  assert.equal(job.items[0].notes[0],'First [S1P1C1]');validateSessions([h.session]);
});

test('resuming after parser changes retains completed evidence and does not retry outdated papers',async()=>{
  let fail=true,fingerprintCalls=0;
  const h=fixture(2,{generate:async(input,onText)=>{if(fail&&input.messages[0].content.includes('Paper 2'))throw Error('Unavailable');onText('Evidence [S1P1C1]');}});
  await h.run.execute(call('analyze_papers',{paper_ids:[],question:'Methods'}));
  const job=h.session.library!.jobs[0],completed=structuredClone(job.items[0]);
  fail=false;h.services.fingerprint=async()=>{fingerprintCalls++;return 'changed';};
  const next=new LibraryRun(h.session,h.controller.signal,h.services);
  await next.resumeAnalysis(job.id);
  assert.deepEqual(job.items[0],completed);assert.equal(fingerprintCalls,1);
  assert.equal(h.session.library!.documents[1].state,'outdated');assert.match(next.results(job,0).text,/Evidence/);
  await next.execute(call('read_papers',{paper_ids:[2],query:''}));assert.equal(fingerprintCalls,1);
});

test('fully completed jobs retain synthesis when attachments are unavailable',async()=>{
  const h=fixture(1);await h.run.execute(call('analyze_papers',{paper_ids:[],question:'Methods'}));
  const job=h.session.library!.jobs[0],result=job.items[0].result,synthesis=job.synthesis;
  h.services.fingerprint=async()=>{throw Error('Attachment deleted');};
  await new LibraryRun(h.session,h.controller.signal,h.services).resumeAnalysis(job.id);
  assert.equal(job.items[0].result,result);assert.equal(job.synthesis,synthesis);
});

test('read retry budget is shared across tools within a turn and renewed next turn',async()=>{
  let reads=0;
  const h=fixture(1,{read:async()=>{reads++;throw Error('PDF unavailable');}}),request=call('read_papers',{paper_ids:[1],query:''});
  await h.run.execute(request);assert.equal(reads,4);
  const repeated=await h.run.execute(request);assert.match(repeated.text,/PDF unavailable/);assert.equal(reads,4);
  await h.run.execute(call('analyze_papers',{paper_ids:[1],question:'Methods'}));assert.equal(reads,4);
  const next=new LibraryRun(h.session,h.controller.signal,h.services);
  await next.execute(request);assert.equal(reads,8);
});

test('200 unique papers are allowed; empty, duplicated and oversized scopes are rejected',()=>{
  fixture(200);assert.throws(()=>fixture(201),/200/);assert.throws(()=>fixture(0),/没有/);
  const p={id:1,title:'x',libraryID:1};assert.throws(()=>libraryState([p,p],'test'),/重复/);
});
test('Zotero collection scope loads childItems through loadDataType and deduplicates regular items',async()=>{
  const original=(globalThis as any).Zotero,loads:number[]=[];
  const item=(id:number,regular=true)=>({id,libraryID:1,isRegularItem:()=>regular,getAttachments:()=>[],getField:(field:string)=>field==='title'?`Paper ${id}`:''});
  const a=item(1),b=item(2),attachment=item(3,false);
  const collections=[{id:10,loadDataType:async(type:string)=>{assert.equal(type,'childItems');loads.push(10);},getChildItems:()=>[a,attachment]},{id:11,loadDataType:async()=>{loads.push(11);},getChildItems:()=>[a,b]}];
  (globalThis as any).Zotero={Collections:{get:(id:number)=>collections.find(c=>c.id===id),getByParent:()=>[collections[1]]}};
  try {assert.deepEqual((await collectionPapers(10,true)).map(p=>p.id),[1,2]);assert.deepEqual(loads,[10,11]);assert.deepEqual((await collectionPapers(10,false)).map(p=>p.id),[1]);}
  finally{(globalThis as any).Zotero=original;}
});
test('opening a workspace and searching metadata never uploads or parses PDFs',async()=>{
  const h=fixture();assert.match(h.run.catalog(),/Collection/);
  const result=JSON.parse((await h.run.execute(call('search_library',{query:'contrastive'}))).text);
  assert.equal(result.matched,3);assert.equal(result.indexed,0);assert.deepEqual(h.read,[]);assert.equal(h.analyzed.length,0);
  assert.equal(h.session.library!.checked.length,0);
});
test('tools enforce scope and parameters before any document access',async()=>{
  const h=fixture();
  for(const c of [call('read_papers',{paper_ids:[999],query:''}),call('read_papers',{paper_ids:['1'],query:''}),call('analyze_papers',{paper_ids:[1,999],question:'methods'}),call('read_file',{path:'private'}),call('search_library',{query:'x',path:'private'})])assert.match((await h.run.execute(c)).text,/error/);
  assert.equal(h.read.length,0);assert.equal(h.analyzed.length,0);
});
test('on-demand reading preserves ordinal citations and reports partial coverage',async()=>{
  const h=fixture();const result=await h.run.execute(call('read_papers',{paper_ids:[3],query:''}));
  assert.match(result.text,/S3P1C1/);assert.deepEqual(h.read,[3]);assert.equal(h.session.sources[0].itemID,3);assert.match(h.session.coverage!,/1 \/ 3/);
  await h.run.execute(call('read_papers',{paper_ids:[3],query:''}));assert.deepEqual(h.read,[3]);
  assert.equal(h.session.library!.documents.filter(d=>d.state==='ready').length,1);validateSessions([h.session]);
});

test('retrieval counts belong to one answer, deduplicate passages and preserve unknown library coverage',async()=>{
  const h=fixture(3,{read:async(p,i)=>({sources:Array.from({length:12},(_,j)=>({id:`S${i}P1C${j+1}`,itemID:p.id,title:p.title,page:1,text:'Research evidence.'}))})});
  await h.run.execute(call('read_papers',{paper_ids:[1],query:''}));
  await h.run.execute(call('read_papers',{paper_ids:[1],query:''}));
  assert.deepEqual(h.run.retrieval(),{retrieved:8,total:12,unreadPapers:2});
  h.session.messages.push({role:'assistant',text:'Answer',retrieval:h.run.retrieval()});
  const next=new LibraryRun(h.session,h.controller.signal,h.services);
  await next.execute(call('read_papers',{paper_ids:[1],query:'',offset:8}));
  assert.deepEqual(next.retrieval(),{retrieved:4,total:12,unreadPapers:2});
  assert.equal(h.session.messages[0].retrieval!.retrieved,8);
  validateSessions(JSON.parse(JSON.stringify([h.session])));
  h.session.messages[0].retrieval!.retrieved=13;assert.throws(()=>validateSessions([h.session]));
});
test('analysis explicitly reports failed papers and reuses completed work on retry',async()=>{
  const h=fixture();const read=h.services.read;let fail=true,attempts=0;
  h.services.read=async(p,i)=>{if(p.id===2){attempts++;if(fail)throw new Error('Damaged PDF');}return read(p,i);};
  let result=JSON.parse((await h.run.execute(call('analyze_papers',{paper_ids:[],question:'methods'}))).text);
  assert.equal(result.complete,2);assert.equal(result.failed,1);assert.equal(result.total,3);assert.match(result.items[1].error,/Damaged/);
  assert.equal(result.status,'done');assert.equal(attempts,4);assert.deepEqual(result.failed_papers,[{id:2,error:'Damaged PDF'}]);
  const firstCalls=h.analyzed.length;fail=false;
  result=JSON.parse((await h.run.execute(call('analyze_papers',{paper_ids:[],question:'methods'}))).text);
  assert.equal(result.complete,2);assert.equal(attempts,4,'Repeated tool calls must not reset automatic retries');
  const next=new LibraryRun(h.session,h.controller.signal,h.services);
  result=JSON.parse((await next.resumeAnalysis(result.job_id)).text);
  assert.equal(result.complete,3);assert.equal(result.failed,0);assert.equal(h.analyzed.length,firstCalls+1);
  assert.match(result.synthesis,/S2P1C1/);assert.equal(h.session.library!.jobs.length,1);validateSessions([h.session]);
});
test('different questions or models do not reuse unrelated per-paper analyses',async()=>{
  const h=fixture(1);await h.run.analyze(h.session.papers,'methods');await h.run.analyze(h.session.papers,'limitations');
  h.services.model='model-2';await h.run.analyze(h.session.papers,'limitations');
  assert.equal(h.session.library!.jobs.length,3);assert.equal(h.analyzed.length,3);
});



test('resuming by ID preserves the full scope and finished results even when a smaller task has the same question',async()=>{
  const h=fixture(),read=h.services.read;let fail=true;
  h.services.read=async(p,i)=>{if(fail&&p.id>1)throw Error('interrupted PDF');return read(p,i);};
  await h.run.analyze(h.session.papers,'methods');const original=h.session.library!.jobs[0],saved=structuredClone(original.items[0]);
  await h.run.analyze([h.session.papers[0]],'methods');assert.equal(h.session.library!.jobs.length,2);
  h.session.library!.currentJob=original.id;
  const id=h.session.library!.currentJob!;
  const run=new LibraryRun(h.session,new AbortController().signal,h.services),before=h.analyzed.length;fail=false;
  const catalog=JSON.parse(run.catalog());assert.equal(catalog.current_job_id,original.id);assert.equal(catalog.previousAnalyses[0].status,'done');
  const result=JSON.parse((await run.execute(call('resume_analysis',{job_id:id}))).text);
  assert.equal(result.job_id,original.id);assert.equal(result.total,3);assert.equal(result.complete,3);assert.equal(h.analyzed.length,before+2);
  assert.deepEqual(original.items[0],saved);assert.equal(h.session.library!.jobs.length,2);validateSessions([h.session]);
  const duplicate=await run.execute(call('analyze_papers',{paper_ids:[2],question:'rewritten instructions'}));
  assert.match(duplicate.text,/本轮已绑定原任务/);assert.equal(h.session.library!.jobs.length,2);
  await run.execute(call('resume_analysis',{job_id:id}));assert.equal(h.analyzed.length,before+2);
});

test('resume rejects foreign IDs or changed model settings without creating a replacement task',async()=>{
  const h=fixture(1);await h.run.analyze(h.session.papers,'methods');const id=h.session.library!.jobs[0].id;
  await assert.rejects(h.run.resumeAnalysis('foreign'),/不属于/);
  h.services.model='other-model';
  const run=new LibraryRun(h.session,new AbortController().signal,h.services);
  const result=await run.execute(call('resume_analysis',{job_id:id}));assert.match(result.text,/模型配置已变更/);
  assert.equal(h.session.library!.jobs.length,1);assert.equal(h.analyzed.length,1);
});
test('all 200 papers are processed with bounded concurrency and paged evidence',async()=>{
  const h=fixture(200);let active=0,peak=0;const generate=h.services.generate;
  h.services.generate=async(input,onText)=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,0));await generate(input,onText);active--;};
  const first=JSON.parse((await h.run.analyze(h.session.papers,'methods')).text);
  assert.equal(first.complete,200);assert.equal(first.failed,0);assert.equal(first.total,200);assert.equal(h.read.length,200);assert.equal(peak,4);
  assert.ok(first.synthesis);assert.ok(h.analyzed.length>200,'Large result sets must be reduced before the final answer');
  const rows=[...first.items];let offset=first.next_offset;
  while(offset!==null){const page=JSON.parse(h.run.results(h.session.library!.jobs[0],offset).text);rows.push(...page.items);offset=page.next_offset;}
  assert.equal(new Set(rows.map(r=>r.id)).size,200);assert.equal(h.session.sources.length,200);validateSessions([h.session]);
});
test('parallel client tool calls cannot upload or analyze the same paper twice',async()=>{
  const h=fixture(1);
  const [a,b]=await Promise.all([h.run.execute(call('analyze_papers',{paper_ids:[],question:'methods'})),h.run.execute(call('analyze_papers',{paper_ids:[],question:'methods'}))]);
  assert.equal(h.read.length,1);assert.equal(h.analyzed.length,1);assert.equal(JSON.parse(a.text).job_id,JSON.parse(b.text).job_id);
});

test('pending tools remain observable until queued analysis and result reads have settled',async()=>{
  let release!:()=>void;const blocked=new Promise<void>(resolve=>release=resolve);
  const h=fixture(1),generate=h.services.generate;
  h.services.generate=async(...args)=>{await blocked;return generate(...args);};
  const work=h.run.execute(call('analyze_papers',{paper_ids:[],question:'methods'}));
  const results=h.run.execute(call('analysis_results',{job_id:''}));
  assert.equal(h.run.pendingTools,2);let settled=false;const waiting=h.run.settle().then(()=>settled=true);
  await new Promise(r=>setImmediate(r));assert.equal(settled,false);assert.equal(h.run.pendingTools,2);
  release();await Promise.all([work,results,waiting]);assert.equal(h.run.pendingTools,0);
  assert.equal(h.session.library!.jobs[0].items[0].state,'done');assert.equal(h.controller.signal.aborted,false);
});

test('later paper chunks may cite evidence already supplied to the same worker',async()=>{
  let calls=0;
  const h=fixture(1,{extractionBudget:1000,read:async p=>({sources:[1,2].map(page=>({id:`S1P${page}C1`,itemID:p.id,title:p.title,page,text:'文'.repeat(600)}))}),generate:async(_input,onText)=>{calls++;onText(calls===1?'First [S1P1C1]':'Both [S1P1C1] [S1P2C1]');}});
  const result=JSON.parse((await h.run.analyze(h.session.papers,'methods')).text);
  assert.equal(calls,2);assert.equal(result.complete,1);assert.equal(result.failed,0);
  assert.deepEqual(h.session.library!.jobs[0].items[0].sourceIDs,['S1P1C1','S1P2C1']);
});

test('chunk citations still reject unread, foreign and nonexistent evidence',async()=>{
  for(const reference of ['S1P2C1','S2P1C1','S1P9C1']){
    const h=fixture(1,{extractionBudget:1000,read:async p=>({sources:[1,2].map(page=>({id:`S1P${page}C1`,itemID:p.id,title:p.title,page,text:'文'.repeat(600)}))}),generate:async(_input,onText)=>onText(`Unsupported [${reference}]`)});
    const result=JSON.parse((await h.run.analyze(h.session.papers,'methods')).text);
    assert.equal(result.complete,0);assert.equal(result.failed,1);assert.match(result.items[0].error,/未提供的引用/);
  }
});

test('citation examples inside inline code or fenced code are not treated as evidence',()=>{
  const source:Source={id:'S1P1C1',itemID:1,title:'Paper',page:1,text:'Evidence'};
  assert.deepEqual(citedSources('`Example [S9P9C9]`.\n```text\n[S8P8C8]\n```\nActual evidence [S1P1C1].',[source]),[source]);
  assert.throws(()=>citedSources('Unsupported evidence [S9P9C9].',[source]),/未提供/);
});
test('changed documents cannot silently replace evidence in an existing conversation',async()=>{
  const h=fixture(1);await h.run.execute(call('read_papers',{paper_ids:[1],query:''}));h.services.fingerprint=async()=> 'changed';
  const result=await h.run.execute(call('read_papers',{paper_ids:[1],query:''}));assert.match(result.text,/已更改/);assert.equal(h.read.length,1);assert.equal(h.session.library!.documents[0].state,'outdated');
});
test('paused concurrent workers all resume and cancellation persists completed work',async()=>{
  const h=fixture(3);h.run.pause();
  let started=0;const a=h.run.checkpoint().then(()=>started++),b=h.run.checkpoint().then(()=>started++);
  await new Promise(r=>setTimeout(r,5));assert.equal(started,0);h.run.resume();await Promise.all([a,b]);assert.equal(started,2);
  const generate=h.services.generate;h.services.generate=async(input,onText)=>{await generate(input,onText);h.controller.abort();};
  await assert.rejects(h.run.analyze(h.session.papers,'methods'));const job=h.session.library!.jobs[0];assert.equal(job.status,'paused');
  assert.ok(job.items.every(i=>i.state!=='running'));assert.ok(h.saved.length);
  const again=new LibraryRun(h.session,new AbortController().signal,{...h.services,generate});await again.analyze(h.session.papers,'methods');assert.equal(job.status,'done');
});
test('history validation rejects out-of-scope jobs and references',()=>{
  const h=fixture();h.session.library!.documents[0].paperID=999;assert.throws(()=>validateSessions([h.session]),/无效/);
  assert.throws(()=>citedSources('False citation [S9P9C9]',[]),/未提供/);
});
test('queue limits active jobs, prioritizes direct reading, and cancels waiting work',async()=>{
  const queue=new WorkQueue(1),controller=new AbortController(),cancel=new AbortController(),order:string[]=[];
  let release!:()=>void;const first=queue.run(controller.signal,async()=>{order.push('active');await new Promise<void>(r=>release=r);});
  await Promise.resolve();
  const library=queue.run(controller.signal,async()=>{order.push('library');});
  const reader=queue.run(controller.signal,async()=>{order.push('reader');},10);
  const cancelled=queue.run(cancel.signal,async()=>{order.push('cancelled');});cancel.abort();await assert.rejects(cancelled);
  release();await Promise.all([first,library,reader]);assert.deepEqual(order,['active','reader','library']);
});

test('parsing does not occupy model slots; eight ready papers can be checked while one PDF is pending',async()=>{
  let unblock!:()=>void,releaseModels!:()=>void;
  const blocked=new Promise<void>(r=>unblock=r),models=new Promise<void>(r=>releaseModels=r);
  const h=fixture(10,{concurrency:8}),read=h.services.read,generate=h.services.generate;
  let running=0,peak=0,parsed=0;
  h.services.read=async(p,i)=>{parsed++;if(p.id===1)await blocked;return read(p,i);};
  h.services.generate=async(input,onText)=>{running++;peak=Math.max(peak,running);await models;await generate(input,onText);running--;};
  const work=h.run.analyze(h.session.papers,'methods');
  while(peak<8)await new Promise(r=>setTimeout(r,1));
  assert.equal(parsed,10);assert.equal(peak,8);assert.equal(h.session.library!.documents[0].state,'reading');
  releaseModels();await new Promise(r=>setTimeout(r,5));
  assert.equal(h.session.library!.jobs[0].items.filter(i=>i.state==='done').length,9);
  unblock();await work;assert.equal(peak,8);
});

test('wider extraction budget reduces ordinary papers to one request and resumed jobs keep chunk boundaries',async()=>{
  const h=fixture(1,{budget:2000,extractionBudget:12000}),read=h.services.read;
  h.services.read=async(p,i)=>{const result=await read(p,i);result.sources[0].text='ordinary paper '.repeat(1500);return result;};
  await h.run.analyze(h.session.papers,'methods');assert.equal(h.analyzed.length,1);assert.equal(h.session.library!.jobs[0].inputBudget,12000);
  const old=fixture(1,{budget:2000,extractionBudget:12000}),oldRead=old.services.read;
  old.services.read=async(p,i)=>{const result=await oldRead(p,i);result.sources[0].text='long paper '.repeat(1800);return result;};
  old.session.library!.jobs.push({id:'old',question:'methods',inputBudget:2000,model:'model-1',status:'paused',items:[{paperID:1,state:'pending',notes:[],sourceIDs:[]}]});
  await old.run.analyze(old.session.papers,'methods');assert.ok(old.session.library!.jobs[0].items[0].parts!>1);
});

test('rate limits reduce subsequent model concurrency and retry after the other papers complete',async()=>{
  const h=fixture(12,{concurrency:8});let active=0,peakAfterFailure=0,failed=false;
  const generate=h.services.generate;
  h.services.generate=async(input,onText)=>{
    active++;try {if(!failed){failed=true;throw Error('HTTP 429');}await new Promise(r=>setTimeout(r,1));await generate(input,onText);}finally{active--;if(h.session.library!.jobs[0].items.some(i=>i.state==='failed'))peakAfterFailure=Math.max(peakAfterFailure,active);}
  };
  const result=JSON.parse((await h.run.analyze(h.session.papers,'methods')).text);assert.equal(result.failed,0);assert.equal(result.complete,12);assert.ok(peakAfterFailure<=7);
});

test('retries wait for every paper in each pass and retain completed chunks',async()=>{
  const h=fixture(3,{concurrency:2,extractionBudget:1000});
  const attempts=[0,0,0],chunksSeen:number[][]=[[],[],[]],released:string[]=[];
  let releaseFirst!:()=>void,releaseRetry!:()=>void;
  const first=new Promise<void>(r=>releaseFirst=r),retry=new Promise<void>(r=>releaseRetry=r);
  h.services.read=async p=>({sources:[1,2].map(page=>({id:`S${p.id}P${page}C1`,itemID:p.id,title:p.title,page,text:'文'.repeat(600)}))});
  h.services.release=worker=>released.push(worker);
  h.services.generate=async(input,onText)=>{
    const [,paper,page]=input.messages[0].content.match(/\[S(\d+)P(\d+)C1\]/)!;const id=Number(paper),part=Number(page);
    chunksSeen[id-1].push(part);
    if(part===2) {
      const attempt=++attempts[id-1];
      if(id===3&&attempt===1)await first;
      if(id===2&&attempt===2)await retry;
      if(id===1&&attempt<3||id===2&&attempt<2)throw Error('Temporary model failure');
    }
    onText(`Evidence [S${id}P${part}C1]`);
  };
  const work=h.run.analyze(h.session.papers,'methods');
  while(attempts[2]<1)await new Promise(r=>setImmediate(r));
  assert.deepEqual(attempts,[1,1,1]);assert.equal(h.session.library!.jobs[0].items[0].state,'failed');
  releaseFirst();
  while(attempts[1]<2)await new Promise(r=>setImmediate(r));
  assert.deepEqual(attempts,[2,2,1],'The next retry round must wait for the slow paper');
  releaseRetry();const result=JSON.parse((await work).text);
  assert.equal(result.complete,3);assert.deepEqual(attempts,[3,2,1]);assert.deepEqual(chunksSeen,[[1,2,2,2],[1,2,2],[1,2]]);
  assert.equal(released.length,6);assert.ok(h.session.library!.jobs[0].items.every(i=>i.notes.length===2));validateSessions([h.session]);
});

test('on-demand reading retries failed PDFs only after the entire first pass',async()=>{
  const h=fixture(),read=h.services.read,attempts=[0,0,0];let release!:()=>void;
  const blocked=new Promise<void>(r=>release=r);
  h.services.read=async(p,i)=>{const attempt=++attempts[p.id-1];if(p.id===3)await blocked;if(p.id===1&&attempt===1||p.id===2)throw Error('PDF unavailable');return read(p,i);};
  const work=h.run.execute(call('read_papers',{paper_ids:[1,2,3],query:''}));
  while(!attempts[2])await new Promise(r=>setImmediate(r));
  assert.deepEqual(attempts,[1,1,1]);release();const result=JSON.parse((await work).text);
  assert.deepEqual(attempts,[2,4,1]);assert.equal(result.papers.filter((p:any)=>!p.error).length,2);
  assert.equal(h.session.library!.documents[1].state,'failed');assert.match(result.papers[1].error,/PDF unavailable/);
});

test('all failed documents return explicit failure without a fabricated synthesis',async()=>{
  let attempts=0;
  const h=fixture(3,{read:async()=>{attempts++;throw Error('Damaged PDF');}});
  const result=JSON.parse((await h.run.analyze(h.session.papers,'methods')).text);
  assert.equal(attempts,12);assert.equal(result.status,'failed');assert.equal(result.complete,0);assert.equal(result.failed,3);assert.equal(result.synthesis,undefined);assert.equal(h.analyzed.length,0);
});

test('failed synthesis groups retry in batches without losing completed paper results',async()=>{
  const h=fixture(30),generate=h.services.generate,attempts=new Map<string,number>();let fail=true;
  h.services.generate=async(input,onText,worker)=>{
    if(worker){await generate(input,t=>onText(t+' detail'.repeat(50)));return;}
    const text=input.messages[0].content,attempt=(attempts.get(text)??0)+1;attempts.set(text,attempt);
    if(text.includes('文献「Paper 1」')&&fail)throw Error('Summary service unavailable');
    await generate(input,onText);
  };
  const result=JSON.parse((await h.run.analyze(h.session.papers,'methods')).text),job=h.session.library!.jobs[0];
  assert.equal(result.complete,30);assert.equal(result.failed,0);assert.equal(result.synthesis,undefined);assert.match(result.synthesis_error,/Summary service unavailable/);
  assert.equal(result.error,undefined);assert.ok(result.items.length);assert.ok(result.next_offset);assert.match(result.note,/汇总失败/);
  assert.ok([...attempts].some(([text,count])=>text.includes('文献「Paper 1」')&&count===4));
  assert.ok([...attempts].filter(([text])=>!text.includes('文献「Paper 1」')).every(([,count])=>count===1));
  assert.ok(job.items.every(i=>i.state==='done'&&i.result));validateSessions([h.session]);
  const before=h.read.length;fail=false;
  const next=new LibraryRun(h.session,h.controller.signal,h.services),recovered=JSON.parse((await next.resumeAnalysis(job.id)).text);
  assert.ok(recovered.synthesis);assert.equal(recovered.synthesis_error,undefined);assert.equal(h.read.length,before);validateSessions([h.session]);
});
