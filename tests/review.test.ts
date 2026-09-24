import test from 'node:test';
import assert from 'node:assert/strict';
import { streamAPI } from '../src/api.ts';
import { newProfile } from '../src/types.ts';
import { modelDetails,reasoningChoices } from '../src/usage.ts';
import { selectContext,sourceText,estimateTokens } from '../src/context.ts';
import { redactError } from '../src/errors.ts';

test('proxy URL credentials are redacted without hiding the destination',()=>{
  const result=redactError('Failed https://reader:p%40ss@proxy.test:8888 and socks5://user:pass#word@localhost:7890');
  assert.doesNotMatch(result,/reader|p%40ss|user|pass#word/);assert.match(result,/proxy\.test:8888/);assert.match(result,/localhost:7890/);
});

for(const [protocol,events] of Object.entries({
  chat:[{choices:[{delta:{content:'Partial'},finish_reason:'content_filter'}]}],
  anthropic:[{type:'content_block_delta',delta:{type:'text_delta',text:'Partial'}},{type:'message_delta',delta:{stop_reason:'refusal'}},{type:'message_stop'}],
  gemini:[{candidates:[{content:{parts:[{text:'Partial'}]},finishReason:'OTHER'}]}]
}))test(`${protocol} stream reports filtered or abnormal completion while retaining text`,async()=>{
  let text='';const body=events.map(data=>'data: '+JSON.stringify(data)+'\n\n').join('')+'data: [DONE]\n\n';
  await assert.rejects(streamAPI({...newProfile('custom'),protocol:protocol as any,baseURL:'https://example.test',model:'m'},'secret',{system:'',messages:[]},new AbortController().signal,t=>text+=t,(async()=>new Response(body,{headers:{'content-type':'text/event-stream'}})) as typeof fetch),/回答未完成/);
  assert.equal(text,'Partial');
});

test('stopping cancels a stream even when the fetch adapter ignores its signal',async()=>{
  const control=new AbortController();let canceled=false,started!:()=>void;
  const ready=new Promise<void>(r=>started=r);
  const work=streamAPI({...newProfile('custom'),baseURL:'https://example.test',model:'m'},'secret',{system:'',messages:[]},control.signal,()=>{},(async()=>new Response(new ReadableStream({pull(){started();},cancel(){canceled=true;}}),{headers:{'content-type':'text/event-stream'}})) as typeof fetch);
  await ready;control.abort();await assert.rejects(work,/abort/i);assert.equal(canceled,true);
});

test('OpenRouter does not retry a nested object that reports exhausted quota',async()=>{
  let requests=0;
  await assert.rejects(streamAPI({...newProfile('openrouter'),model:'m'},'secret',{system:'',messages:[]},new AbortController().signal,()=>{},(async()=>{requests++;return Response.json({error:{message:'Provider returned error',metadata:{raw:{error:{message:'Insufficient credits'}}}}},{status:429});}) as typeof fetch),/Insufficient credits/);
  assert.equal(requests,1);
});

test('long provider errors are limited only after full credential redaction',async()=>{
  const key='private-key-'.repeat(240);
  await assert.rejects(streamAPI({...newProfile('custom'),baseURL:'https://example.test',model:'m'},key,{system:'',messages:[]},new AbortController().signal,()=>{},(async()=>Response.json({error:{message:key+' diagnostic'.repeat(500)}},{status:401})) as typeof fetch),(error:Error)=>{assert.ok(error.message.length<=2000);assert.doesNotMatch(error.message,/private-key/);return true;});
});

for(const [protocol,data] of Object.entries({
  chat:{choices:[{message:{content:'Partial'},finish_reason:'length'}]},
  responses:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[{type:'message',content:[{type:'output_text',text:'Partial'}]}]},
  anthropic:{stop_reason:'max_tokens',content:[{type:'text',text:'Partial'}]},
  gemini:{candidates:[{content:{parts:[{text:'Partial'}]},finishReason:'MAX_TOKENS'}]}
}))test(`${protocol} JSON truncation retains text and marks the answer incomplete`,async()=>{
  let text='';await assert.rejects(streamAPI({...newProfile('custom'),protocol:protocol as any,baseURL:'https://example.test',model:'model'},'secret',{system:'',messages:[]},new AbortController().signal,t=>text+=t,(async()=>Response.json(data)) as typeof fetch),/未完成/);assert.equal(text,'Partial');
});
test('errors hide the actual nonstandard key, sensitive custom headers and generic credentials',async()=>{
  const key='custom-credential-value',header='private-value';
  const profile={...newProfile('custom'),baseURL:'https://example.test',model:'model',headers:JSON.stringify({'X-Service-Token':header})};
  for(const streaming of [false,true]){
    const data={error:{message:`Rejected ${key} with ${header}; access_token=other-secret`}};
    await assert.rejects(streamAPI(profile,key,{system:'',messages:[]},new AbortController().signal,()=>{},(async()=>streaming?new Response('data: '+JSON.stringify(data)+'\n\n',{headers:{'content-type':'text/event-stream'}}):Response.json(data,{status:401})) as typeof fetch),error=>{assert.doesNotMatch((error as Error).message,/custom-credential-value|private-value|other-secret/);return true;});
  }
  assert.doesNotMatch(redactError('Authorization: Bearer private-secret'),/private-secret/);
});
test('model-reported effort and mandatory reasoning take precedence; unknown models stay on defaults',()=>{
  const details=modelDetails({reasoning:{supported_efforts:['none','high','low'],mandatory:true}});
  assert.deepEqual(details.reasoningEfforts,['high','low']);
  assert.deepEqual(reasoningChoices({...newProfile('gemini'),model:'gemini-2.5-pro'}),[]);
  assert.deepEqual(reasoningChoices({...newProfile('gemini'),model:'gemini-3.1-pro'}),['low','medium','high']);
  assert.deepEqual(reasoningChoices({...newProfile('anthropic'),model:'claude-opus-4-5'}),['low','medium','high']);
  assert.deepEqual(reasoningChoices({...newProfile('deepseek'),model:'deepseek-flash'}),['none','low','high','max']);
  assert.deepEqual(reasoningChoices({...newProfile('custom'),model:'unknown'}),[]);
  assert.deepEqual(reasoningChoices({...newProfile('openai'),model:'gpt-5.2-pro'}),['medium','high','xhigh']);
  assert.deepEqual(reasoningChoices({...newProfile('custom'),model:'known',models:[{id:'known',name:'known',reasoningEfforts:['low']}]}),['low']);
});
test('Chinese academic questions retrieve relevant English sections late in a document',()=>{
  const sources=Array.from({length:10},(_,i)=>({id:`S1P${i+1}`,itemID:1,title:'Study',page:i+1,text:i===8?'Limitations\nOur method fails in low-light conditions.':'Introduction\nGeneral background of the research.'}));
  const budget=estimateTokens(sourceText(sources[8]))+2;const selected=selectContext(sources,'本文的研究局限是什么',budget);assert.equal(selected.partial,true);assert.deepEqual(selected.sources.map(s=>s.page),[9]);
});
test('unmatched questions sample distant sections instead of only the opening pages',()=>{
  const sources=Array.from({length:10},(_,i)=>({id:`S1P${i+1}`,itemID:1,title:'Study',page:i+1,text:'General background and evidence.'}));
  const selected=selectContext(sources,'寻找特殊现象',estimateTokens(sourceText(sources[0]))*3+5);assert.ok(selected.sources.some(s=>s.page===10));assert.ok(selected.sources.some(s=>s.page===5));
});
