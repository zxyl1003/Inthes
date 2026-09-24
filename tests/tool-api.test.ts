import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolTurn, toolHistoryBudget, trimToolImages } from '../src/tool-api.ts';
import { buildRequest, streamAPI } from '../src/api.ts';
import { newProfile } from '../src/types.ts';
import type { Profile } from '../src/types.ts';

const tools=[{name:'search_library',description:'Search selected scope',parameters:{type:'object',properties:{query:{type:'string'}},required:['query'],additionalProperties:false}}];
const input={system:'Read within the selected scope',messages:[{role:'user' as const,content:'Find papers'}]};
const profile=(protocol:Profile['protocol'])=>({...newProfile('custom'),protocol,baseURL:'https://example.test/v1',model:'model'});
const fixtures:Record<string,any>={
  chat:{choices:[{message:{role:'assistant',content:null,reasoning_content:'signed reasoning',tool_calls:[{id:'c1',type:'function',function:{name:'search_library',arguments:'{"query":"test"}'}}]},finish_reason:'tool_calls'}]},
  responses:{status:'completed',output:[{type:'reasoning',id:'r1',summary:[],encrypted_content:'opaque'},{type:'function_call',id:'f1',call_id:'c1',name:'search_library',arguments:'{"query":"test"}'}]},
  anthropic:{stop_reason:'tool_use',content:[{type:'thinking',thinking:'reasoning',signature:'signed'},{type:'tool_use',id:'c1',name:'search_library',input:{query:'test'}}]},
  gemini:{candidates:[{content:{role:'model',parts:[{functionCall:{id:'c1',name:'search_library',args:{query:'test'}},thoughtSignature:'signed'}]},finishReason:'STOP'}]}
};
test('opaque provider state contributes to tool request budgets without changing signatures',()=>{
  const history=[{signature:'s'.repeat(10000),encrypted_content:'e'.repeat(10000),thoughtSignature:'t'.repeat(10000)}];
  const original=JSON.stringify(history);assert.ok(toolHistoryBudget(history).tokens>5000);assert.equal(JSON.stringify(history),original);
});
for(const protocol of Object.keys(fixtures) as Profile['protocol'][])test(`${protocol} accepts tool-only replies and replays the provider's signed blocks`,async()=>{
  const turn=new ToolTurn(protocol,tools);let requests=0;
  await streamAPI(profile(protocol),'key',input,new AbortController().signal,()=>{},(async(_url,options)=>{requests++;const body=JSON.parse(options!.body as string);assert.ok(body.tools.length);return Response.json(fixtures[protocol]);}) as typeof fetch,undefined,{},turn);
  assert.equal(requests,1);assert.equal(turn.calls.length,1);assert.equal(turn.calls[0].name,'search_library');assert.deepEqual(turn.calls[0].arguments,{query:'test'});
  const history=turn.results([{text:'evidence'}]);const next=new ToolTurn(protocol,tools,history);const request=buildRequest(profile(protocol),'key',input);next.configure(request.body);
  const body=JSON.stringify(request.body);assert.match(body,/evidence/);assert.match(body,protocol==='responses'?/opaque/:/signed/);
});

for(const protocol of Object.keys(fixtures) as Profile['protocol'][])test(`${protocol} budgets tool images and prunes oldest images without altering signed blocks`,()=>{
  const make=(data:string,history:any[]=[])=>{const turn=new ToolTurn(protocol,tools,history);turn.accept(fixtures[protocol],false);turn.finish();return turn.results([{text:'Evidence [S1P1C1]',images:[{data,mimeType:'image/png',width:1024,height:1024}]}]);};
  const history=make('second-image',make('first-image'));
  const before=toolHistoryBudget(history);assert.equal(before.images.length,2);assert.equal(before.bytes,23);assert.ok(before.tokens>4000);
  const pruned=trimToolImages(history,protocol,Infinity,12);assert.equal(pruned.removed,1);assert.equal(pruned.bytes,12);assert.equal(pruned.images.length,1);
  const body=buildRequest(profile(protocol),'key',input).body;new ToolTurn(protocol,tools,history).configure(body);
  const serialized=JSON.stringify(body);assert.ok(!serialized.includes('first-image'));assert.match(serialized,/second-image/);assert.match(serialized,/原图因请求容量限制/);assert.match(serialized,/Evidence/);assert.match(serialized,protocol==='responses'?/opaque/:/signed/);
  const noImages=trimToolImages(history,protocol,500,Infinity);assert.equal(noImages.removed,1);assert.equal(noImages.images.length,0);assert.equal(noImages.bytes,0);
});
test('Chat streaming accumulates split tool arguments and preserves reasoning',async()=>{
  const turn=new ToolTurn('chat',tools),data=[
    {choices:[{delta:{reasoning_content:'reason'}}]},
    {choices:[{delta:{tool_calls:[{index:0,id:'c1',function:{name:'search_library',arguments:'{"que'}}]}}]},
    {choices:[{delta:{tool_calls:[{index:0,function:{arguments:'ry":"test"}'}}]},finish_reason:'tool_calls'}]},
    {choices:[],usage:{prompt_tokens:20,completion_tokens:15}}
  ];let usage:any;
  await streamAPI(profile('chat'),'key',input,new AbortController().signal,()=>{},(async()=>new Response(data.map(d=>'data: '+JSON.stringify(d)+'\n\n').join('')+'data: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})) as typeof fetch,undefined,{onUsage:u=>usage=u},turn);
  assert.deepEqual(turn.calls[0].arguments,{query:'test'});assert.equal(usage.inputTokens,20);assert.match(JSON.stringify(turn.results([{text:'found'}])),/reason/);
});
test('Anthropic stream keeps thinking signatures and assembles input_json_delta',()=>{
  const turn=new ToolTurn('anthropic',tools);
  for(const event of [
    {type:'content_block_start',index:0,content_block:{type:'thinking',thinking:'',signature:''}},
    {type:'content_block_delta',index:0,delta:{type:'thinking_delta',thinking:'reason'}},
    {type:'content_block_delta',index:0,delta:{type:'signature_delta',signature:'signed'}},
    {type:'content_block_start',index:1,content_block:{type:'tool_use',id:'c1',name:'search_library',input:{}}},
    {type:'content_block_delta',index:1,delta:{type:'input_json_delta',partial_json:'{"query":"test"}'}}
  ])turn.accept(event);
  assert.deepEqual(turn.finish()[0].arguments,{query:'test'});assert.match(JSON.stringify(turn.results([{text:'result'}])),/signed/);
});
test('truncated tool arguments never reach execution',async()=>{
  const turn=new ToolTurn('chat',tools);
  await assert.rejects(streamAPI(profile('chat'),'key',input,new AbortController().signal,()=>{},(async()=>Response.json({choices:[{message:{tool_calls:[{id:'x',function:{name:'search_library',arguments:'{"query":'}}]},finish_reason:'length'}]})) as typeof fetch,undefined,{},turn));
});
