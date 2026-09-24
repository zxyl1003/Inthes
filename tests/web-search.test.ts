import test from 'node:test';
import assert from 'node:assert/strict';
import {newProfile} from '../src/types.ts';
import {requireWebSearch,searchRequest,searchWeb} from '../src/web-search.ts';

const profile=(baseURL:string,protocol:'chat'|'responses'='chat')=>({...newProfile('custom'),model:'qwen-plus',baseURL,protocol,webSearch:true});
const signal=()=>new AbortController().signal;
const json=(data:any,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json'}});
const sse=(events:any[])=>new Response(events.map(x=>`data: ${JSON.stringify(x)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});

test('MiniMax native search stays on its API origin and requires actual search results',async()=>{
  for(const host of ['api.minimax.cn','api.minimax.io','api.minimaxi.com']){
    const p={...newProfile('minimax'),model:'MiniMax-M3',baseURL:`https://${host}/anthropic/v1`};
    const result=await searchWeb(p,'key','papers',signal(),async(url,init)=>{
      assert.equal(url,`https://${host}/v1/responses`);assert.equal((init?.headers as any).Authorization,'Bearer key');
      assert.deepEqual(JSON.parse(init!.body as string).tools,[{type:'web_search'}]);
      assert.equal(JSON.parse(init!.body as string).tool_choice,'auto');
      return json({status:'completed',output:[{type:'web_search_call',status:'completed',action:{query:'papers'}},{type:'message',content:[{type:'output_text',text:'A paper',annotations:[{type:'url_citation',url:'https://arxiv.org/abs/2304.07193',title:'DINOv2',content:'Vision research'}]}]}]});
    });
    assert.equal(result.sources[0].text,'Vision research');assert.equal(result.summary,'A paper');
    await assert.rejects(searchWeb(p,'key','papers',signal(),async()=>json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'I searched'}]}]})),/实际联网搜索记录/);
  }
});

test('plan search never falls through to paid search and Kimi international uses its own service',()=>{
  for(const baseURL of ['https://coding.dashscope.aliyuncs.com/v1','https://open.bigmodel.cn/api/coding/paas/v4','https://api.kimi.com/coding/v1','https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'])assert.throws(()=>searchRequest(profile(baseURL),'key','papers'),/套餐|个人版/);
  const p={...newProfile('qwen'),model:'auto',billingMode:'token-plan-team' as const,baseURL:'https://token-plan.cn-beijing.maas.aliyuncs.com/apps/anthropic',protocol:'anthropic' as const};
  const request=searchRequest(p,'plan-key','papers');assert.equal(request.url,'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/responses');assert.deepEqual(request.body.tools,[{type:'web_search'}]);
  assert.equal(searchRequest(profile('https://api.moonshot.ai/v1'),'key','papers').url,'https://api.moonshot.ai/v1/tools/search');
});

test('Qwen Omni gets its required agent strategy without changing ordinary model requests',()=>{
  for(const model of ['qwen3.5-omni-plus','qwen3.8-omni-flash','qwen3.8-flash','qwen3.5-plus','qwen-plus']){
    const r=searchRequest({...profile('https://dashscope.aliyuncs.com/compatible-mode/v1'),model},'key','papers');
    assert.equal(r.body.parameters.search_options.search_strategy,model.includes('omni')?'agent':undefined);
  }
});

test('Responses retains completed-item text when the terminal event contains only status and usage',async()=>{
  const result=await searchWeb(profile('https://dashscope.aliyuncs.com/api/v2/apps/protocols/compatible-mode/v1','responses'),'key','papers',signal(),async()=>sse([
    {type:'response.output_item.done',output_index:0,item:{id:'search',type:'web_search_call',status:'completed',action:{sources:[{url:'https://arxiv.org/abs/2304.07193'}]}}},
    {type:'response.output_item.done',output_index:1,item:{id:'message',type:'message',content:[{type:'output_text',text:'DINOv2 bibliographic details'}]}},
    {type:'response.completed',response:{id:'response',status:'completed',usage:{input_tokens:100}}}
  ]));
  assert.equal(result.summary,'DINOv2 bibliographic details');assert.equal(result.sources.length,1);
});

test('Responses combines text parts while completed items and final output replace their deltas',async()=>{
  const output=[{id:'search',type:'web_search_call',status:'completed'},{id:'message',type:'message',content:[{type:'output_text',text:'Paper details',annotations:[{type:'url_citation',title:'Paper',url:'https://arxiv.org'}]},{type:'output_text',text:'Second part'}]}];
  const events=[
    {type:'response.output_text.delta',item_id:'message',content_index:0,delta:'Paper '},
    {type:'response.output_text.delta',item_id:'message',content_index:0,delta:'details'},
    {type:'response.output_text.done',item_id:'message',content_index:0,text:'Paper details'},
    {type:'response.output_text.delta',item_id:'message',content_index:1,delta:'Second part'},
    {type:'response.output_item.done',item:output[1]},
    {type:'response.completed',response:{output}}
  ];
  const result=await searchWeb(profile('https://ark.cn-beijing.volces.com/api/v3'),'key','papers',signal(),async()=>sse(events));
  assert.equal(result.summary,'Paper details\n\nSecond part');assert.equal(result.sources[0].title,'Paper');
  const deltas=await searchWeb(profile('https://ark.cn-beijing.volces.com/api/v3'),'key','papers',signal(),async()=>sse([
    events[0],events[1],{type:'response.output_item.done',item:output[0]},{type:'response.completed',response:{status:'completed'}}
  ]));
  assert.equal(deltas.summary,'Paper details');
});
test('manual opt-in does not bypass missing provider support or change credential hosts',()=>{
  assert.throws(()=>requireWebSearch({...profile('https://api.moonshot.cn/v1'),webSearch:false}),/未开启/);
  assert.throws(()=>requireWebSearch(profile('https://api.deepseek.com')),/DeepSeek.*不支持/);
  assert.throws(()=>requireWebSearch(profile('https://open.bigmodel.cn.evil.test/v1')),/尚未适配/);
  assert.throws(()=>searchRequest(profile('https://user:password@api.moonshot.cn/v1'),'secret','paper'),/用户名/);
  const cases=[['https://api.moonshot.cn/v1','/v1/tools/search'],['https://open.bigmodel.cn/api/paas/v4','/api/paas/v4/web_search'],['https://dashscope.aliyuncs.com/compatible-mode/v1','/api/v1/services/aigc/text-generation/generation'],['https://ark.cn-beijing.volces.com/api/v3','/api/v3/responses']];
  for(const [base,path] of cases){const r=searchRequest(profile(base),'test-key','papers');assert.equal(r.url,new URL(base).origin+path);assert.equal(r.headers.Authorization,'Bearer test-key');}
  const q=searchRequest({...profile(cases[2][0]),model:'qwen3.5-plus'},'test-key','papers');assert.match(q.url,/multimodal-generation/);assert.deepEqual(q.body.input.messages[0].content,[{text:'papers'}]);
});
test('Kimi and GLM return verified sources and distinguish no results from ignored search',async()=>{
  for(const [base,data] of [['https://api.moonshot.cn/v1',{search_results:[{title:'Paper',url:'https://arxiv.org/abs/2304.07193',snippet:'Abstract'}]}],['https://open.bigmodel.cn/api/paas/v4',{search_result:[{title:'Paper',link:'https://arxiv.org/abs/2304.07193',content:'Abstract'}]}]] as const){
    let options:any;const found=await searchWeb(profile(base),'test-key','DINOv2',signal(),async(_url,init)=>{options=init;return json(data);});
    assert.equal(found.sources[0].text,'Abstract');assert.equal(options.redirect,'error');assert.equal(options.credentials,'omit');
    await assert.rejects(searchWeb(profile(base),'test-key','papers',signal(),async()=>json({choices:[{message:{content:'I searched the web'}}]})),/未返回实际联网/);
  }
  assert.deepEqual((await searchWeb(profile('https://api.moonshot.cn/v1'),'k','nothing',signal(),async()=>json({search_results:[]}))).sources,[]);
});
test('Qwen and Ark require real native search metadata and complete responses',async()=>{
  const q=profile('https://dashscope.aliyuncs.com/compatible-mode/v1');
  const found=await searchWeb(q,'k','papers',signal(),async()=>sse([{output:{search_info:{search_results:[{title:'Paper',url:'https://arxiv.org/abs/2304.07193'}]},choices:[{message:{content:'Found'},finish_reason:'stop'}]}}]));
  assert.equal(found.sources.length,1);assert.equal(found.summary,'Found');
  await assert.rejects(searchWeb(q,'k','papers',signal(),async()=>sse([{output:{search_info:{search_results:[]}}}])),/提前结束/);
  const a=profile('https://ark.cn-beijing.volces.com/api/v3');
  const result=await searchWeb(a,'k','papers',signal(),async()=>sse([{type:'response.completed',response:{output:[{type:'web_search_call',status:'completed'},{type:'message',content:[{type:'output_text',text:'Found',annotations:[{type:'url_citation',url:'https://arxiv.org',title:'arXiv'}]}]}]}}]));
  assert.equal(result.sources[0].title,'arXiv');assert.equal(result.summary,'Found');
  await assert.rejects(searchWeb(a,'k','papers',signal(),async()=>sse([{type:'response.incomplete',response:{output:[]}}])),/未完成/);
});
test('network rejection and malformed results surface errors without exposing keys',async()=>{
  const p=profile('https://api.moonshot.cn/v1');
  await assert.rejects(searchWeb(p,'secret-key','papers',signal(),async()=>json({error:{message:'unsupported search secret-key'}},400)),e=>/HTTP 400.*unsupported search/.test(String(e))&&!String(e).includes('secret-key'));
  await assert.rejects(searchWeb(p,'key','papers',signal(),async()=>json({search_results:[{url:'javascript:alert(1)'}]})),/来源链接无效/);
  const c=new AbortController();c.abort(Error('cancelled'));await assert.rejects(searchWeb(p,'k','papers',c.signal,async()=>{throw c.signal.reason;}),/cancelled/);
});
