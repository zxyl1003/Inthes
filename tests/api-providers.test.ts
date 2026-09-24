import test from 'node:test';
import assert from 'node:assert/strict';
import { newProfile } from '../src/types.ts';
import { apiProviders, billingOptions, setBillingMode } from '../src/api-providers.ts';
import { buildRequest, fetchModels } from '../src/api.ts';

test('four API presets use official endpoints and existing message protocols',async()=>{
  const endpoints={qwen:'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',kimi:'https://api.moonshot.cn/v1/chat/completions',glm:'https://open.bigmodel.cn/api/paas/v4/chat/completions',minimax:'https://api.minimax.cn/anthropic/v1/messages'};
  for(const preset of apiProviders){
    const p={...newProfile(preset),model:'test-model'},request=buildRequest(p,'test-key',{system:'Read papers',messages:[{role:'user',content:'Question'}]});
    assert.equal(request.url,endpoints[preset as keyof typeof endpoints]);assert.equal(p.webSearch,true);
    assert.equal(request.headers[preset==='minimax'?'x-api-key':'Authorization'],preset==='minimax'?'test-key':'Bearer test-key');
    const models=await fetchModels(p,'test-key',new AbortController().signal,async(url)=>{assert.equal(url,p.baseURL+'/models');return Response.json({data:[{id:'test-model'}]});});
    assert.equal(models[0].id,'test-model');
  }
});

test('billing changes isolate Qwen plan routes and reset incompatible model and request settings',()=>{
  const p={...newProfile('qwen'),model:'old',extra:'{"enable_search":true}',headers:'{"custom":"old"}',balanceQuery:{path:'/balance',field:'amount',currency:'CNY'},models:[{id:'old',name:'old'}]};
  const personal=setBillingMode(p,'token-plan'),team=setBillingMode(personal,'token-plan-team');
  assert.equal(personal.protocol,'chat');assert.equal(personal.webSearch,false);
  assert.equal(team.protocol,'responses');assert.equal(team.webSearch,true);
  assert.equal(team.baseURL,'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1');
  assert.equal(team.model,'');assert.deepEqual(team.models,[]);assert.equal(team.extra,'{}');assert.equal(team.balanceQuery,undefined);
  assert.equal(setBillingMode(team,'payg').baseURL,newProfile('qwen').baseURL);
  const international={...newProfile('minimax'),baseURL:'https://api.minimax.io/anthropic/v1'};
  assert.equal(setBillingMode(international,'token-plan').baseURL,international.baseURL);
  for(const preset of ['glm','kimi']){assert.deepEqual(billingOptions(preset),[]);assert.throws(()=>setBillingMode(newProfile(preset),'token-plan'));}
});
