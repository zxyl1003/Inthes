import test from 'node:test';
import assert from 'node:assert/strict';
import { extractionProfile, LibraryWorkers } from '../src/library-workers.ts';
import { newProfile } from '../src/types.ts';
import type { ChatInput } from '../src/types.ts';
import { buildRequest } from '../src/api.ts';

test('extraction keeps the selected model, uses low, and leaves the final answer profile untouched',()=>{
  const profile={...newProfile('openrouter'),model:'model',reasoning:'high',thinkingBudget:12000,extra:'{"reasoning":{"effort":"high"},"provider":{"sort":"latency"}}'};
  const snapshot=structuredClone(profile),worker=extractionProfile(profile,[{id:'model',name:'model',reasoningEfforts:['low','high']}]);
  assert.equal(worker.model,profile.model);assert.equal(worker.reasoning,'low');assert.equal(worker.thinkingBudget,undefined);assert.deepEqual(profile,snapshot);
  const body=buildRequest(worker,'key',{system:'',messages:[{role:'user',content:'test'}]}).body;
  assert.equal(body.reasoning.effort,'low');assert.equal(body.provider.sort,'latency');
  const silicon={...newProfile('custom'),model:'deepseek-ai/DeepSeek-V4-Flash',baseURL:'https://api.siliconflow.cn/v1'};
  assert.equal(extractionProfile(silicon).reasoning,'none');assert.equal(extractionProfile(newProfile('custom')).reasoning,'');
});

for(const preset of ['codex-account','antigravity-account'])test(`${preset} workers continue a paper thread, isolate papers and release their histories`,async()=>{
  const p={...newProfile(preset),model:'test',reasoning:'low'},calls:any[]=[],released:string[]=[];
  const workers=new LibraryWorkers(p,async(profile,input,onText,conversation)=>{calls.push({profile,input,conversation});onText('evidence');},id=>released.push(id));
  const input:ChatInput={system:'rules',messages:[{role:'user',content:'paper chunk'}]};
  await workers.run(input,()=>{},'a');await workers.run(input,()=>{},'a');await workers.run(input,()=>{},'b');
  assert.equal(calls[1].input.messages.length,3);assert.equal(calls[0].conversation.id,calls[1].conversation.id);
  assert.equal(calls[2].input.messages.length,1);assert.notEqual(calls[1].conversation.id,calls[2].conversation.id);
  workers.release('a');workers.close();assert.deepEqual(released,['library-worker-a','library-worker-b']);
});

test('worker resets before overflowing context and never reuses a failed turn',async()=>{
  const p={...newProfile('codex-account'),contextTokens:5000,contextAuto:false,maxTokens:1000},lengths:number[]=[],released:string[]=[];
  let fail=false;
  const workers=new LibraryWorkers(p,async(_p,input,onText)=>{lengths.push(input.messages.length);if(fail)throw Error('interrupted');onText('a'.repeat(5000));},id=>released.push(id));
  const input:ChatInput={system:'rules',messages:[{role:'user',content:'chunk'}]};
  await workers.run(input,()=>{},'a');await workers.run(input,()=>{},'a');assert.deepEqual(lengths,[1,1]);
  fail=true;await assert.rejects(workers.run(input,()=>{},'a'));fail=false;
  await workers.run(input,()=>{},'a');assert.equal(lengths.at(-1),1);workers.close();assert.ok(released.length>=3);
});
