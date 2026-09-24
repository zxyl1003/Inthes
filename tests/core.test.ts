import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, SSEParser, readEvent, streamAPI } from '../src/api.ts';
import { newProfile } from '../src/types.ts';
import { chunks, estimateTokens, selectContext, sourcePassages, sourceTokens } from '../src/context.ts';
const input = {system:'Answer from evidence.',messages:[{role:'user' as const,content:'Question'}]};
test('maps each API protocol and keeps private Responses off storage',()=>{
  const chat=buildRequest(newProfile('deepseek'),'key',input);
  assert.equal(chat.url,'https://api.deepseek.com/chat/completions');assert.equal(chat.body.max_tokens,4096);assert.deepEqual(chat.body.thinking,{type:'enabled'});
  const response=buildRequest({...newProfile('openai'),model:'example',reasoning:'high'},'key',input);
  assert.equal(response.body.store,false);assert.equal(response.body.max_output_tokens,4096);assert.equal(response.body.reasoning.effort,'high');assert.equal(response.body.instructions,input.system);
  const anthropic=buildRequest({...newProfile('anthropic'),model:'example',thinkingBudget:1024},'key',input);
  assert.equal(anthropic.headers['x-api-key'],'key');assert.equal(anthropic.body.system,input.system);assert.equal(anthropic.body.thinking.budget_tokens,1024);
  const gemini=buildRequest({...newProfile('gemini'),model:'example'},'key',input);
  assert.match(gemini.url,/models\/example:streamGenerateContent\?alt=sse$/);assert.equal(gemini.body.generationConfig.maxOutputTokens,4096);
});
test('rejects credential-unsafe destinations and protected overrides',()=>{
  assert.throws(()=>buildRequest({...newProfile(),baseURL:'http://external.example'},'key',input),/HTTPS/);
  assert.throws(()=>buildRequest({...newProfile(),extra:'{"messages":[]}'},'key',input),/不能覆盖/);
  assert.throws(()=>buildRequest({...newProfile(),headers:'{"Authorization":"override"}'},'key',input),/覆盖/);
  assert.throws(()=>buildRequest({...newProfile('anthropic'),model:'example',thinkingBudget:5000},'key',input),/思考预算/);
});
test('OpenRouter provider is optional and does not affect other services',()=>{
  for(const value of [undefined,'','  ']) assert.equal('provider' in buildRequest({...newProfile('openrouter'),openrouterProvider:value},'key',input).body,false);
  assert.equal('provider' in buildRequest({...newProfile('deepseek'),openrouterProvider:'deepinfra'},'key',input).body,false);
});
test('OpenRouter pins the requested provider and retains endpoint variants',()=>{
  const p={...newProfile('openrouter'),openrouterProvider:'  deepinfra/turbo  '};
  assert.deepEqual(buildRequest(p,'key',input).body.provider,{only:['deepinfra/turbo']});
  assert.throws(()=>buildRequest({...p,extra:'{"provider":{"only":["other"]}}'},'key',input),/provider 已由表单配置/);
  assert.deepEqual(buildRequest({...p,openrouterProvider:'',extra:'{"provider":{"sort":"price"}}'},'key',input).body.provider,{sort:'price'});
});
test('SSE handles split CRLF, multiple data lines and trailing event',()=>{
  const p=new SSEParser();assert.deepEqual(p.push('data: {"a":1}\r'),[]);assert.deepEqual(p.push('\n\r\ndata: hi\ndata: there\n\n'),['{"a":1}','hi\nthere']);assert.deepEqual(p.push('data: [DONE]',true),['[DONE]']);
});
test('reasoning streams are not mistaken for final answer',()=>{
  assert.equal(readEvent('responses',{type:'response.reasoning_text.delta',delta:'private'}).text,undefined);
  assert.equal(readEvent('anthropic',{type:'content_block_delta',delta:{type:'thinking_delta',thinking:'private'}}).text,undefined);
  assert.equal(readEvent('gemini',{candidates:[{content:{parts:[{text:'thought',thought:true},{text:'answer'}]}}]}).text,'answer');
  assert.throws(()=>readEvent('responses',{type:'response.failed',response:{error:{message:'bad'}}}),/bad/);
});
test('network stream errors preserve partial answer but reject completion',async()=>{
  const p=newProfile();let text='';const fetcher=(async()=>new Response('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',{headers:{'content-type':'text/event-stream'}})) as typeof fetch;
  await assert.rejects(streamAPI(p,'key',input,new AbortController().signal,t=>text+=t,fetcher),/提前结束/);assert.equal(text,'partial');
});
test('successful stream emits answer and validates terminal event',async()=>{
  let text='';const fetcher=(async()=>new Response('data: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})) as typeof fetch;
  await streamAPI(newProfile(),'key',input,new AbortController().signal,t=>text+=t,fetcher);assert.equal(text,'answer');
});

test('stream errors cancel the response without replaying or losing partial text',async()=>{
  for(const event of ['{"error":{"message":"Provider failed"}}','{invalid']) {
    let cancelled=false,requests=0,text='';
    const body=new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\ndata: '+event+'\n\n'));},cancel(){cancelled=true;throw Error('Cancellation failure must not mask the cause');}});
    const fetcher=(async()=>{requests++;return new Response(body,{headers:{'content-type':'text/event-stream'}});}) as typeof fetch;
    await assert.rejects(streamAPI(newProfile(),'key',input,new AbortController().signal,t=>text+=t,fetcher),error=>!String(error).includes('Cancellation failure'));
    assert.equal(cancelled,true);assert.equal(requests,1);assert.equal(text,'partial');
  }
});
test('summary chunks retain every character and original page reference',()=>{
  const sources=[{id:'S1P1',itemID:1,title:'A',page:1,text:'中文'.repeat(5000)},{id:'S2P9',itemID:2,title:'B',page:9,text:'second paper'}];
  const grouped=chunks(sources,2000);assert.equal(grouped.flat().filter(s=>s.id==='S1P1').map(s=>s.text).join(''),sources[0].text);assert.equal(grouped.flat().at(-1)?.id,'S2P9');for(const group of grouped)assert.ok(estimateTokens(group.map(s=>s.text).join(''))<=2000);
});

test('long HTML tables split on complete rows with repeated headers and intact merged cells',()=>{
  const header='<tr><th>Method</th><th>Accuracy</th></tr>';
  const rows=Array.from({length:50},(_,i)=>`<tr><td>Method ${i}</td><td>95.25</td></tr>`);
  rows[24]='<tr><td rowspan="2">Merged</td><td>24</td></tr>';rows[25]='<tr><td>25</td></tr>';
  const source={id:'S1P3',itemID:1,title:'Table',page:3,text:`<table>${header}${rows.join('')}</table>`};
  const passages=sourcePassages(source);assert.ok(passages.length>1);
  for(const p of passages){assert.match(p.text,/^<table>/);assert.match(p.text,/<\/table>$/);assert.ok(p.text.includes(header));assert.equal(p.page,3);assert.equal((p.text.match(/<tr>/g)||[]).length,(p.text.match(/<\/tr>/g)||[]).length);}
  assert.ok(passages.some(p=>p.text.includes(rows[24]+rows[25])));
  for(const row of rows)assert.equal(passages.filter(p=>p.text.includes(row)).length,1);
  const grouped=chunks([{...source,text:source.text.repeat(3)}],1000);
  for(const group of grouped){assert.ok(group.reduce((n,s)=>n+sourceTokens(s),0)<=1000);for(const s of group)assert.equal((s.text.match(/<table>/g)||[]).length,(s.text.match(/<\/table>/g)||[]).length);}
});

test('formulas and code keep delimiters and blank lines; oversized atomic content fails explicitly',()=>{
  const formula='$$\\begin{aligned}\n'+('a &= b + c \\\\\n\n'.repeat(90))+'\\end{aligned}$$';
  const code='```python\n'+('x = 123\n\n'.repeat(160))+'```';
  const original={id:'S1P2',itemID:1,title:'Math',page:2,text:`# Heading\n\nFirst paragraph.\n\n${formula}\n\n${code}\n\nLast paragraph.`};
  const passages=sourcePassages(original);
  assert.equal(passages[0].text,'# Heading');assert.ok(passages.some(p=>p.text===formula));assert.ok(passages.some(p=>p.text===code));
  const inline='$'+('a+'.repeat(700))+'b$';assert.ok(sourcePassages({...original,text:'Before '+inline+' after.'}).some(p=>p.text.includes(inline)));
  assert.throws(()=>chunks([{...original,text:'$$'+('变量+'.repeat(1000))+'1$$'}],1000),/超过上下文预算/);
});

test('Markdown tables repeat their header across source passages',()=>{
  const header='| Method | Result |\n| --- | --- |\n';
  const rows=Array.from({length:100},(_,i)=>`| Method ${i} | 99 |`);
  const passages=sourcePassages({id:'S1P1',itemID:1,title:'Table',text:header+rows.join('\n')});
  assert.ok(passages.length>1);for(const p of passages)assert.ok(p.text.startsWith(header));
  for(const row of rows)assert.equal(passages.filter(p=>p.text.includes(row)).length,1);
});
test('retrieval includes multiple papers and labels partial coverage',()=>{
  const sources=Array.from({length:10},(_,i)=>({id:`S${i%2+1}P${i+1}`,itemID:i%2+1,title:'Paper',page:i+1,text:('retrieval evidence ').repeat(100)}));
  const selected=selectContext(sources,'retrieval',2000);assert.equal(selected.partial,true);assert.equal(new Set(selected.sources.map(s=>s.itemID)).size,2);
});
