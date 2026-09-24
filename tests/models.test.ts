import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchModels } from '../src/api.ts';
import { newProfile } from '../src/types.ts';
const signal=()=>new AbortController().signal;
test('model discovery uses configured authentication and headers without requiring a chosen model',async()=>{
  for(const protocol of ['chat','responses'] as const){
    const p={...newProfile('custom'),protocol,baseURL:'https://models.example/v1',headers:'{"X-Project":"research"}'};
    const fetcher=(async(url,init)=>{assert.equal(String(url),'https://models.example/v1/models');assert.equal((init!.headers as any).Authorization,'Bearer key');assert.equal((init!.headers as any)['X-Project'],'research');assert.equal(init!.redirect,'error');assert.equal(init!.credentials,'omit');return Response.json({data:[{id:'one',name:'Model One'},{id:'two'}]});}) as typeof fetch;
    assert.deepEqual(await fetchModels(p,'key',signal(),fetcher),[{id:'one',name:'Model One'},{id:'two',name:'two'}]);
  }
});
test('Anthropic model discovery reads all pages and display names',async()=>{
  const urls:string[]=[];const fetcher=(async(url,init)=>{urls.push(String(url));assert.equal((init!.headers as any)['x-api-key'],'key');return Response.json(urls.length===1?{data:[{id:'a',display_name:'A'}],has_more:true,last_id:'a'}:{data:[{id:'b',display_name:'B'}],has_more:false});}) as typeof fetch;
  assert.deepEqual(await fetchModels(newProfile('anthropic'),'key',signal(),fetcher),[{id:'a',name:'A'},{id:'b',name:'B'}]);assert.match(urls[1],/after_id=a$/);
});
test('Gemini discovery follows pagination and excludes models without text generation',async()=>{
  let calls=0;const fetcher=(async(url,init)=>{calls++;assert.equal((init!.headers as any)['x-goog-api-key'],'key');if(calls===2)assert.match(String(url),/pageToken=next$/);return Response.json(calls===1?{models:[{name:'models/a',displayName:'A',supportedGenerationMethods:['generateContent']},{name:'models/embed',supportedGenerationMethods:['embedContent']}],nextPageToken:'next'}:{models:[{name:'models/b',displayName:'B',supportedGenerationMethods:['generateContent']}]});}) as typeof fetch;
  assert.deepEqual(await fetchModels(newProfile('gemini'),'key',signal(),fetcher),[{id:'a',name:'A'},{id:'b',name:'B'}]);
});
test('discovery errors and malformed pages do not produce invented models or infinite pagination',async()=>{
  const p=newProfile('openrouter');
  await assert.rejects(fetchModels(p,'key',signal(),async()=>new Response('',{status:401})),/HTTP 401/);
  await assert.rejects(fetchModels(p,'key',signal(),async()=>Response.json({unexpected:[]})),/模型列表/);
  await assert.rejects(fetchModels(newProfile('anthropic'),'key',signal(),async()=>Response.json({data:[{id:'a'}],has_more:true,last_id:'a'})),/分页标识/);
  assert.deepEqual(await fetchModels(p,'key',signal(),async()=>Response.json({data:[]})),[]);
  await assert.rejects(fetchModels({...p,baseURL:'http://external.example'},'secret',signal(),async()=>{throw new Error('must not send credentials');}),/HTTPS/);
});
