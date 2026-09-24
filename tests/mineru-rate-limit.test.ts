import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { MinerURateLimit } from '../src/mineru-rate-limit.ts';
import { mineruRequest } from '../src/mineru.ts';

let epoch = Date.now();
test.beforeEach(context => { const t=context as TestContext; epoch += 1000000; t.mock.timers.enable({ apis: ['Date','setTimeout'], now: epoch }); });
const flush = async () => { for (let i=0;i<15;i++) await Promise.resolve(); };

test('50 files share a rolling minute across requests; cancellation sends no queued request', async t => {
  const limit=new MinerURateLimit(50),signal=new AbortController().signal;
  await limit.acquire(30,signal);t.mock.timers.tick(10000);await limit.acquire(20,signal);
  let sent=false;const queued=limit.acquire(31,signal).then(()=>{sent=true;});
  t.mock.timers.tick(50000);await flush();assert.equal(sent,false);
  t.mock.timers.tick(10000);await queued;assert.equal(sent,true);
  const controller=new AbortController();
  const cancelled=limit.acquire(50,controller.signal);controller.abort();await assert.rejects(cancelled);
});

test('result queries share 1000 requests per minute independently of submission slots', async t => {
  const signal=new AbortController().signal,results=new MinerURateLimit(1000),files=new MinerURateLimit(50);
  await Promise.all(Array.from({length:1000},()=>results.acquire(1,signal)));
  let ready=false;const next=results.acquire(1,signal).then(()=>{ready=true;});
  await files.acquire(50,signal);await flush();assert.equal(ready,false);
  t.mock.timers.tick(60000);await next;
});

test('single and batch submission use the same file budget; queries are independent', async t => {
  const signal=new AbortController().signal,calls:string[]=[];
  const fetcher:typeof fetch=async url=>{calls.push(String(url));return Response.json({code:0,data:{}});};
  await mineruRequest('key',fetcher,signal,'/file-urls/batch',{files:Array(49).fill({})});
  await mineruRequest('key',fetcher,signal,'/extract/task',{url:'https://example.com/a.pdf'});
  const next=mineruRequest('key',fetcher,signal,'/extract/task/batch',{files:[{},{}]});await flush();assert.equal(calls.length,2);
  await mineruRequest('key',fetcher,signal,'/extract-results/batch/test');assert.equal(calls.length,3);
  t.mock.timers.tick(60000);await next;assert.equal(calls.length,4);
});

test('429 respects Retry-After and pauses other submissions before retrying', async t => {
  const signal=new AbortController().signal,calls:number[]=[];
  const fetcher:typeof fetch=async()=>{calls.push(Date.now());return calls.length===1?new Response('rate limit',{status:429,headers:{'Retry-After':'90'}}):Response.json({code:0,data:{}});};
  const first=mineruRequest('key',fetcher,signal,'/file-urls/batch',{files:[{}]});await flush();
  const second=mineruRequest('key',fetcher,signal,'/extract/task',{url:'paper'});await flush();
  t.mock.timers.tick(89999);await flush();assert.equal(calls.length,1);
  t.mock.timers.tick(1);await Promise.all([first,second]);assert.equal(calls.length,3);assert.equal(calls[1]-calls[0],90000);
});

test('persistent 429 retries are bounded and daily limit errors are not retried', async t => {
  const signal=new AbortController().signal;let calls=0;
  const work=mineruRequest('key',async()=>{calls++;return new Response('rate limit',{status:429});},signal,'/extract/task',{url:'paper'});
  const rejection=assert.rejects(work,/持续限流/);
  await flush();t.mock.timers.tick(60000);await flush();t.mock.timers.tick(60000);await rejection;assert.equal(calls,3);
  t.mock.timers.tick(60000);calls=0;
  await assert.rejects(mineruRequest('key',async()=>{calls++;return new Response('daily maximum 5000 files',{status:429});},signal,'/extract/task',{url:'paper'}),/当日/);
  assert.equal(calls,1);
});

test('a numeric 5000 in rate-limit diagnostics is not mistaken for a daily quota',async t=>{
  let calls=0;
  const work=mineruRequest('key',async()=>++calls===1?new Response('code 500012: rate limit',{status:429}):Response.json({code:0,data:{done:true}}),new AbortController().signal,'/extract/task',{url:'paper'});
  await flush();t.mock.timers.tick(60000);assert.deepEqual(await work,{done:true});assert.equal(calls,2);
});
