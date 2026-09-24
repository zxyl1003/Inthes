import test from 'node:test';
import assert from 'node:assert/strict';
import { readUsage, modelDetails, reasoningChoices } from '../src/usage.ts';
import { newProfile } from '../src/types.ts';
import { buildRequest, streamAPI } from '../src/api.ts';

test('missing usage stays unknown and zero is a reported value',()=>{
  assert.equal(readUsage('chat',{}),undefined);
  assert.equal(readUsage('chat',{usage:{prompt_tokens:null,completion_tokens:-1}}),undefined);
  assert.deepEqual(readUsage('chat',{usage:{prompt_tokens:10,completion_tokens:0}}),{inputTokens:10,outputTokens:0});
});
test('usage normalization counts cached inputs once and reasoning within outputs',()=>{
  assert.deepEqual(readUsage('chat',{usage:{prompt_tokens:100,completion_tokens:20,total_tokens:120,prompt_tokens_details:{cached_tokens:80},completion_tokens_details:{reasoning_tokens:12}}}),{inputTokens:100,outputTokens:20,totalTokens:120,cachedInputTokens:80,reasoningTokens:12});
  assert.deepEqual(readUsage('anthropic',{message:{usage:{input_tokens:10,cache_read_input_tokens:50,cache_creation_input_tokens:20,output_tokens:1}}}),{inputTokens:80,outputTokens:1,cachedInputTokens:50});
  assert.deepEqual(readUsage('anthropic',{usage:{output_tokens:30}}),{outputTokens:30});
  assert.deepEqual(readUsage('gemini',{usageMetadata:{promptTokenCount:30,candidatesTokenCount:8,thoughtsTokenCount:10,totalTokenCount:48}}),{inputTokens:30,outputTokens:18,totalTokens:48,reasoningTokens:10});
  assert.equal(readUsage('responses',{response:{usage:{input_tokens:42}}})?.inputTokens,42);
});
test('Codex uses last context, not cumulative billed thread usage',()=>{
  const data={tokenUsage:{total:{totalTokens:99999},last:{inputTokens:200,outputTokens:40,totalTokens:240,reasoningOutputTokens:30},modelContextWindow:258400}};
  const usage=readUsage('codex-account',data)!;assert.equal(usage.contextTokens,240);assert.equal(usage.totalTokens,240);assert.equal(usage.modelContextWindow,258400);
});
test('streams keep reading final usage-only chunks and separate reasoning from answer',async()=>{
  const events=[{choices:[{delta:{reasoning:'提供的摘要'}}]},{choices:[{delta:{content:'答案'},finish_reason:'stop'}]},{choices:[],usage:{prompt_tokens:125,completion_tokens:18,completion_tokens_details:{reasoning_tokens:10}}}];
  let text='';const usages:any[]=[];const phases:string[]=[];
  await streamAPI(newProfile('openrouter'),'key',{system:'',messages:[]},new AbortController().signal,t=>text+=t,(async()=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})) as typeof fetch,undefined,{onUsage:u=>usages.push(u),onPhase:p=>phases.push(p)});
  assert.equal(text,'答案');assert.equal(usages.length,1);assert.equal(usages[0].inputTokens,125);assert.deepEqual(phases,['connecting','thinking','thinking','answering']);
});
test('Anthropic cumulative output updates merge with initial input instead of summing',async()=>{
  const events=[{type:'message_start',message:{usage:{input_tokens:30,cache_read_input_tokens:20,output_tokens:1}}},{type:'content_block_delta',delta:{type:'text_delta',text:'OK'}},{type:'message_delta',usage:{output_tokens:8}},{type:'message_delta',usage:{output_tokens:10}},{type:'message_stop'}];
  const usages:any[]=[];
  await streamAPI({...newProfile('anthropic'),model:'test'},'key',{system:'',messages:[]},new AbortController().signal,()=>{},(async()=>new Response(events.map(e=>`data: ${JSON.stringify(e)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}})) as typeof fetch,undefined,{onUsage:u=>usages.push(u)});
  assert.deepEqual(usages.at(-1),{inputTokens:50,outputTokens:10,cachedInputTokens:20});
});
test('custom endpoint without usage still completes; JSON responses also report usage',async()=>{
  for(const usage of [undefined,{prompt_tokens:11,completion_tokens:4}]) {
    let text='';const reported:any[]=[];
    await streamAPI({...newProfile('custom'),baseURL:'https://example.test/v1',model:'test'},'key',{system:'',messages:[]},new AbortController().signal,t=>text+=t,(async()=>Response.json({choices:[{message:{content:'OK'}}],usage})) as typeof fetch,undefined,{onUsage:u=>reported.push(u)});
    assert.equal(text,'OK');assert.equal(reported.length,usage?1:0);
  }
});
test('model metadata exposes context and only supported account effort levels',()=>{
  assert.equal(modelDetails({context_length:131072}).contextWindow,131072);
  const details=modelDetails({supportedReasoningEfforts:[{reasoningEffort:'low'},{reasoningEffort:'medium'}],defaultReasoningEffort:'medium'});
  assert.deepEqual(reasoningChoices({...newProfile('codex-account'),model:'test',models:[{id:'test',name:'Test',...details}]}),['low','medium']);
});
test('custom services rejecting optional stream usage retry without it, only before generation',async()=>{
  const bodies:any[]=[];let text='';
  await streamAPI({...newProfile('custom'),baseURL:'https://example.test/v1',model:'test'},'key',{system:'',messages:[]},new AbortController().signal,t=>text+=t,(async(_url,options)=>{
    bodies.push(JSON.parse(options!.body as string));
    return bodies.length===1?Response.json({error:{message:'Unknown parameter: stream_options'}},{status:400}):Response.json({choices:[{message:{content:'OK'}}]});
  }) as typeof fetch);
  assert.equal(text,'OK');assert.equal(bodies.length,2);assert.deepEqual(bodies[0].stream_options,{include_usage:true});assert.equal(bodies[1].stream_options,undefined);
});
test('SiliconFlow exposes documented effort levels and sends its thinking switch and budget',()=>{
  const p={...newProfile('custom'),baseURL:'https://api.siliconflow.cn/v1',model:'deepseek-ai/DeepSeek-V4-Flash'};
  assert.deepEqual(reasoningChoices(p),['none','high','max']);
  const input={system:'',messages:[]};
  for(const effort of ['high','max']){const {body}=buildRequest({...p,reasoning:effort},'key',input);assert.equal(body.reasoning_effort,effort);assert.equal(body.enable_thinking,true);}
  const off=buildRequest({...p,reasoning:'none',thinkingBudget:1024},'key',input).body;assert.equal(off.enable_thinking,false);assert.equal(off.reasoning_effort,undefined);assert.equal(off.thinking_budget,undefined);
  assert.equal(buildRequest({...p,thinkingBudget:4096},'key',input).body.thinking_budget,4096);
  assert.throws(()=>buildRequest({...p,thinkingBudget:50},'key',input),/128/);
  assert.deepEqual(reasoningChoices({...p,model:'unknown'}),[]);assert.deepEqual(reasoningChoices({...p,baseURL:'https://api.siliconflow.cn.example.com/v1'}),[]);
});
