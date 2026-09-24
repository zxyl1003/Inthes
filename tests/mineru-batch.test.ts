import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { mineruBatchReader } from '../src/mineru-batch.ts';
import { mineruDefaults } from '../src/mineru.ts';
import { validateState } from '../src/validation.ts';

// Advance simulated API windows without making the 200-paper regression wait minutes.
let epoch=Date.now(),ticker:ReturnType<typeof setInterval>;
test.beforeEach(context=>{const t=context as TestContext;epoch+=1000000;t.mock.timers.enable({apis:['Date','setTimeout'],now:epoch});ticker=setInterval(()=>t.mock.timers.tick(1000),5);});
test.afterEach(()=>clearInterval(ticker));

function service(failedID='',holdUpload?:Promise<void>) {
  const batches:any[][]=[],requests:{url:string;init:RequestInit;at:number}[]=[];
  let active=0,peak=0,parsePeak=0;
  const parsing=new Set<string>();
  (globalThis as any).IOUtils={stat:async()=>({size:4}),read:async()=>new Uint8Array([37,80,68,70])};
  const fetcher:typeof fetch=async(input,init={})=>{
    const url=String(input);requests.push({url,init,at:Date.now()});
    if(url.endsWith('/file-urls/batch')){
      const files=JSON.parse(init.body as string).files,index=batches.push(files)-1;
      for(const file of files)parsing.add(file.data_id);parsePeak=Math.max(parsePeak,parsing.size);
      return Response.json({code:0,data:{batch_id:String(index),file_urls:files.map((f:any)=>`https://mineru.net/upload/${f.data_id}`)}});
    }
    if(url.includes('/upload/')){
      active++;peak=Math.max(peak,active);
      if(url.endsWith('folio-3')&&holdUpload)await holdUpload;
      await new Promise(r=>setTimeout(r,1));active--;return new Response('');
    }
    if(url.includes('/extract-results/batch/')){
      const batch=batches[Number(url.split('/').at(-1))];
      parsing.delete(failedID);
      return Response.json({code:0,data:{extract_result:[...batch].reverse().map((f:any)=>({data_id:f.data_id,state:f.data_id===failedID?'failed':'done',err_msg:'damaged secret-key',full_zip_url:`https://mineru.net/result/${f.data_id}`}))}});
    }
    if(url.includes('/result/')){
      const id=url.split('/').at(-1);
      parsing.delete(id!);
      return new Response(zipSync({'paper_content_list.json':strToU8(JSON.stringify([{type:'text',page_idx:0,text:id}])),'full.md':strToU8(String(id))}));
    }
    throw Error('unexpected request');
  };
  return {fetcher,batches,requests,peak:()=>peak,parsePeak:()=>parsePeak};
}
const decode=async()=>{throw Error('no figures in fixture');};

test('batch parsing rejects untrusted upload URLs and cancellation stops result polling',async()=>{
  for(const unsafe of [true,false]){
    const s=service(),c=new AbortController();let polls=0;
    const fetcher:typeof fetch=async(input,init)=>{
      const response=await s.fetcher(input,init),url=String(input);
      if(unsafe&&url.endsWith('/file-urls/batch')){const body=await response.json();body.data.file_urls=['https://localhost/private'];return Response.json(body);}
      if(!unsafe&&url.includes('/extract-results/batch/')){polls++;c.abort();return Response.json({code:0,data:{extract_result:[{data_id:'folio-1',state:'running'}]}});}
      return response;
    };
    const reader=mineruBatchReader(mineruDefaults,'secret-key',fetcher,c.signal,()=>{},decode);
    await assert.rejects(reader.extract('/paper.pdf',c.signal),error=>{assert.ok(!String(error).includes('secret-key'));return true;});
    assert.ok(!s.requests.some(r=>r.url.startsWith('https://localhost')));
    assert.equal(polls,unsafe?0:1);assert.ok(!s.requests.some(r=>r.url.includes('/result/')));
  }
});

test('200 PDFs keep at most 50 parses in flight, match out-of-order results and isolate one failure',async()=>{
  const s=service('folio-17'),c=new AbortController(),preflight:string[][]=[];
  const reader=mineruBatchReader(mineruDefaults,'secret-key',s.fetcher,c.signal,()=>{},decode,async paths=>{preflight.push(paths);});
  const results=await Promise.allSettled(Array.from({length:200},(_,i)=>reader.extract(`/paper-${i}.pdf`,c.signal).then(result=>{reader.release!(result);return result;})));
  assert.equal(s.batches[0].length,50);assert.equal(s.batches.flat().length,200);assert.ok(s.batches.every(b=>b.length<=50));assert.equal(s.parsePeak(),50);assert.equal(s.peak(),3);assert.equal(preflight.flat().length,200);
  assert.equal(results.filter(r=>r.status==='fulfilled').length,199);
  for(let i=0;i<results.length;i++){
    const result=results[i];if(result.status==='fulfilled'){assert.equal(result.value.pages[0],`folio-${i+1}`);assert.ok(result.value.archive!.files['full.md']);}
    else {assert.equal(i,16);assert.ok(!String(result.reason).includes('secret-key'));}
  }
  assert.ok(s.requests.filter(r=>r.url.includes('/upload/')||r.url.includes('/result/')).every(r=>!r.init.headers));
  const submissions=s.requests.filter(r=>r.url.endsWith('/file-urls/batch'));
  for(const r of submissions)assert.ok(submissions.filter(q=>q.at>r.at-60000&&q.at<=r.at).reduce((sum,q)=>sum+JSON.parse(q.init.body as string).files.length,0)<=50);

});

test('configured MinerU concurrency bounds active documents and queued work is cancelled',async()=>{
  for(const concurrency of [1,2]){
    const s=service(),c=new AbortController();
    const reader=mineruBatchReader(mineruDefaults,'key',s.fetcher,c.signal,()=>{},decode,undefined,undefined,concurrency);
    const results=await Promise.all(Array.from({length:4},(_,i)=>reader.extract(`/paper-${i}.pdf`,c.signal).then(result=>{reader.release!(result);return result;})));
    assert.equal(results.length,4);assert.equal(s.parsePeak(),concurrency);assert.equal(s.batches[0].length,concurrency);
  }
  const s=service(),c=new AbortController();
  const reader=mineruBatchReader(mineruDefaults,'key',s.fetcher,c.signal,()=>{},decode,undefined,undefined,1);
  const work=Promise.allSettled([reader.extract('/a.pdf',c.signal),reader.extract('/b.pdf',c.signal)]);
  c.abort();assert.ok((await work).every(r=>r.status==='rejected'));assert.equal(s.requests.length,0);
});

test('the first parsed paper is available while another upload is unfinished',async()=>{
  let release!:()=>void;const held=new Promise<void>(r=>release=r),s=service('',held),c=new AbortController();
  const reader=mineruBatchReader(mineruDefaults,'key',s.fetcher,c.signal,()=>{},decode);
  const results=[1,2,3].map(i=>reader.extract(`/paper-${i}.pdf`,c.signal).then(result=>{reader.release!(result);return result;}));
  await results[0];assert.equal(s.requests.filter(r=>r.url.includes('/extract-results/')).length,1);
  release();await Promise.all(results);
});

test('cancelling before batching uploads nothing; cancellation during preparation stops submission',async()=>{
  const s=service(),a=new AbortController();
  const reader=mineruBatchReader(mineruDefaults,'key',s.fetcher,a.signal,()=>{},decode);
  const result=reader.extract('/a.pdf',a.signal);a.abort();await assert.rejects(result);assert.equal(s.requests.length,0);
  const b=new AbortController(),next=mineruBatchReader(mineruDefaults,'key',s.fetcher,b.signal,()=>{},decode,async()=>{b.abort();});
  await assert.rejects(next.extract('/b.pdf',b.signal));assert.equal(s.requests.length,0);
});

test('completed archives apply backpressure until the consumer saves them; abort releases the queue',async()=>{
  const s=service(),c=new AbortController(),reader=mineruBatchReader(mineruDefaults,'key',s.fetcher,c.signal,()=>{},decode);
  const first=reader.extract('/a.pdf',c.signal),second=reader.extract('/b.pdf',c.signal),third=reader.extract('/c.pdf',c.signal);
  // Results arrive in reverse order, but at most two may await persistence.
  await Promise.race([first,second,third]);await new Promise(r=>setTimeout(r,20));
  assert.equal(s.requests.filter(r=>r.url.includes('/result/')).length,2);
  const settled=Promise.allSettled([first,second,third]);c.abort();await settled;
  const next=service(),control=new AbortController(),again=mineruBatchReader(mineruDefaults,'key',next.fetcher,control.signal,()=>{},decode);
  const result=await again.extract('/new.pdf',control.signal);again.release!(result);assert.equal(result.pages.length,1);
});

test('saved concurrency values must be integers within their respective limits',()=>{
  const state={version:1,historyFormat:2,profiles:[],selected:'',remember:true,sessions:[]};
  for(const [key,max] of [['libraryConcurrency',8],['mineruConcurrency',50]] as const){
    validateState({...state,[key]:1});validateState({...state,[key]:max});
    for(const value of [0,-1,1.5,max+1,'4',null])assert.throws(()=>validateState({...state,[key]:value}));
  }
});
