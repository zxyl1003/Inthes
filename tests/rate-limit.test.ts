import test from 'node:test';
import assert from 'node:assert/strict';
import { apiError, retryDelay, streamAPI } from '../src/api.ts';
import { newProfile } from '../src/types.ts';

const input={system:'Answer briefly.',messages:[{role:'user' as const,content:'OK?'}]};
const p={...newProfile('openrouter'),model:'test-model',openrouterProvider:'deepinfra/fp4'};
const upstream={error:{code:429,message:'Provider returned error',metadata:{provider_name:'DeepInfra',raw:'The model is temporarily rate-limited upstream.'}}};
const signal=()=>new AbortController().signal;
const limited=(body:any=upstream,retry='0')=>Response.json(body,{status:429,headers:{'Retry-After':retry}});
const success=()=>Response.json({choices:[{message:{content:'OK'}}]});

test('provider errors retain the upstream explanation and waiting hint',()=>{
  const e=apiError(upstream,429,'30');assert.match(e.message,/HTTP 429/);assert.match(e.message,/DeepInfra/);assert.match(e.message,/rate-limited upstream/);assert.match(e.message,/30 秒/);
  const nested=apiError({error:{message:'Provider returned error',metadata:{raw:JSON.stringify({error:{message:'No capacity, sk-private-key'}})}}},429);
  assert.match(nested.message,/No capacity/);assert.ok(!nested.message.includes('sk-private-key'));
});
test('retry delay honors seconds and HTTP dates, with bounded exponential defaults',()=>{
  assert.equal(retryDelay('30'),30000);assert.equal(retryDelay('0'),0);
  assert.equal(retryDelay('Wed, 16 Sep 2026 12:00:30 GMT',0,Date.parse('2026-09-16T12:00:00Z')),30000);
  assert.equal(retryDelay(null,0),5000);assert.equal(retryDelay('invalid',1),10000);assert.equal(retryDelay('-1'),5000);
});
test('429 retries are bounded and keep the same model, provider restriction and body',async()=>{
  let calls=0,text='';const requests:string[]=[],statuses:string[]=[];
  await streamAPI(p,'key',input,signal(),t=>text+=t,(async(_url,init)=>{calls++;requests.push(String(init!.body));return calls<3?limited():success();}) as typeof fetch,s=>statuses.push(s));
  assert.equal(calls,3);assert.equal(text,'OK');assert.equal(new Set(requests).size,1);assert.deepEqual(JSON.parse(requests[0]).provider,{only:['deepinfra/fp4']});assert.ok(statuses[0].includes('1/2'));assert.ok(statuses[1].includes('2/2'));assert.equal(statuses.at(-1),'');
  calls=0;await assert.rejects(streamAPI(p,'key',input,signal(),()=>{},async()=>{calls++;return limited();}),/DeepInfra/);assert.equal(calls,3);
});
test('long cooldowns, exhausted quota, credentials and other services are not repeatedly retried',async()=>{
  for(const [profile,response] of [[p,()=>limited(upstream,'120')],[p,()=>limited({error:{code:429,message:'Daily quota exhausted'}})],[p,()=>Response.json({error:{message:'Invalid key'}},{status:401})],[newProfile('deepseek'),()=>limited()]] as const){
    let calls=0;await assert.rejects(streamAPI(profile,'key',input,signal(),()=>{},async()=>{calls++;return response();}));assert.equal(calls,1);
  }
});
test('stopping during cooldown aborts promptly and cannot send another request',async()=>{
  let calls=0;const control=new AbortController();
  const work=streamAPI(p,'key',input,control.signal,()=>{},async()=>{calls++;return limited(upstream,'30');},()=>control.abort());
  await assert.rejects(work,/abort/i);assert.equal(calls,1);
});
test('mid-stream 429 retains the answer and details without replaying the request',async()=>{
  let calls=0,text='';
  const fetcher=async()=>{calls++;return new Response(`data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: ${JSON.stringify(upstream)}\n\n`,{headers:{'content-type':'text/event-stream'}});};
  await assert.rejects(streamAPI(p,'key',input,signal(),t=>text+=t,fetcher),/DeepInfra/);assert.equal(calls,1);assert.equal(text,'partial');
});
