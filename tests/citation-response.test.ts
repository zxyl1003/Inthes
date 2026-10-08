import test from 'node:test';
import assert from 'node:assert/strict';
import { citationResponsePrompt, generateCitationResponse, suppliedSources } from '../src/citation-response.ts';
import { citedSources } from '../src/citations.ts';
import type { ChatInput, Source } from '../src/types.ts';

const sources:Source[]=[{id:'S1P4C23',itemID:1,attachmentID:101,title:'Paper',page:4,text:'Evidence on page four.'},{id:'S1P8C4',itemID:1,attachmentID:101,title:'Paper',page:8,text:'Evidence on page eight.'}];
const input:ChatInput={system:'Read',messages:[{role:'user',content:'[S1P4C23] Evidence'}]};
const signal=()=>new AbortController().signal;

test('normal Markdown streams immediately and valid citations require no extra model call',async()=>{
  const body='**结果**\n\n| 指标 | 来源 |\n| --- | --- |\n| $x^2$ | [S1P4C23] |\n\n$$y=x^2$$\n[网页](https://example.com)';
  const updates:string[]=[];let calls=0;
  const text=await generateCitationResponse(input,()=>sources,async(request,onText)=>{
    calls++;assert.ok(request.system.includes(citationResponsePrompt));assert.doesNotMatch(request.system,/parts|JSON/);
    onText('**结果**');assert.equal(updates[0],'**结果**');onText(body.slice(6));
  },{signal:signal(),progress:t=>updates.push(t)});
  assert.equal(text,body);assert.equal(calls,1);assert.deepEqual(citedSources(text,sources),[sources[0]]);
});

test('only an invalid citation paragraph is repaired, leaving other text and formulas unchanged',async()=>{
  const good='可靠结论 [S1P4C23]。\n\n$$y=x^2$$\n\n',bad='需重新核对的结论 [S4C23]。',tail='\n\n后续正常正文。';
  const requests:ChatInput[]=[],updates:string[]=[];
  const text=await generateCitationResponse(input,()=>sources,async(request,onText,attempt)=>{
    requests.push(request);onText(attempt?'重新核对的结论 [S1P4C23]。':good+bad+tail);
    if(!attempt){assert.match(updates.at(-1)!,/可靠结论/);assert.doesNotMatch(updates.at(-1)!,/S4C23/);}
  },{signal:signal(),progress:t=>updates.push(t)});
  assert.equal(text,good+'重新核对的结论 [S1P4C23]。'+tail);assert.equal(requests.length,2);
  const correction=requests[1].messages.at(-1)!.content;assert.match(correction,/只修正|关联论断|不能只删引用/);assert.match(correction,/S4C23/);
  assert.doesNotMatch(correction,/可靠结论|y=x|后续正常/);
});

test('table repairs replace only the affected row without changing the table header and valid rows',async()=>{
  const body='| 指标 | 来源 |\n| --- | --- |\n| 正常 | [S1P4C23] |\n| 错误 | [S1S1P8C4] |\n\n正常尾段。';
  const text=await generateCitationResponse(input,()=>sources,async(_request,onText,attempt)=>onText(attempt?'| 更正 | [S1P4C23] |':body),{signal:signal()});
  assert.equal(text,body.replace('| 错误 | [S1S1P8C4] |','| 更正 | [S1P4C23] |'));
});

test('multiple invalid paragraphs are patched at their original offsets',async()=>{
  const body='前言。\n\n第一条 [S4C23]。\n\n正常 [S1P4C23]。\n\n第二条 [S1P9C99]。';
  let calls=0;
  const text=await generateCitationResponse(input,()=>sources,async(request,onText,attempt)=>{
    calls++;onText(!attempt?body:request.messages.at(-1)!.content.includes('第二条')?'第二条核对后 [S1P4C23]。':'第一条核对后 [S1P4C23]。');
  },{signal:signal()});
  assert.equal(text,'前言。\n\n第一条核对后 [S1P4C23]。\n\n正常 [S1P4C23]。\n\n第二条核对后 [S1P4C23]。');assert.equal(calls,3);
});

test('failed local corrections preserve the answer and mark only the affected claim',async()=>{
  for(const invalid of ['[S4C23]','[S1S1P8C4]','[S1P4C99]','[S999P4C23]','[S1P4C23-L27]','S1P8C4','[S4C23']){
    let calls=0;
    const text=await generateCitationResponse(input,()=>sources,async(_request,onText,attempt)=>{calls++;onText(attempt?'依然错误 [S4C23]':'正常 [S1P4C23]。\n\n关联论断 '+invalid);},{signal:signal()});
    assert.equal(calls,3);assert.equal(text,'正常 [S1P4C23]。\n\n关联论断 （此处论断的原文依据未核实）');assert.deepEqual(citedSources(text,sources),[sources[0]]);
  }
});

test('removing a bad citation cannot silently turn the associated claim into a confirmed conclusion',async()=>{
  const text=await generateCitationResponse(input,()=>sources,async(_request,onText,attempt)=>onText(attempt?'证据不足，不能确认。':'结论 [S4C23]'),{signal:signal()});
  assert.match(text,/证据不足.*原文依据未核实/);
});

test('corrections can use only evidence actually supplied in the correction request',async()=>{
  const text=await generateCitationResponse(input,()=>sources,async(_request,onText,attempt)=>onText(attempt?'Not supplied [S1P8C4]':'Claim [S4C23]'),{signal:signal()});
  assert.equal(text,'Claim （此处论断的原文依据未核实）');assert.doesNotMatch(text,/S1P8C4/);
});

test('code examples remain literal, while inline citations are checked',async()=>{
  const body='`Example [S4C23]`\n\n\`\`\`json\n{"sources":["S1P4C23"]}\n\`\`\`';
  let calls=0;
  assert.equal(await generateCitationResponse(input,()=>[],async(_request,onText)=>{calls++;onText(body);},{signal:signal()}),body);assert.equal(calls,1);
  assert.deepEqual(suppliedSources('[S1P4C23] Actual evidence [S9P9C9]',sources),[sources[0]]);
});

test('a repair service error keeps completed text, and original generation errors and cancellation propagate',async()=>{
  let calls=0;
  const text=await generateCitationResponse(input,()=>sources,async(_request,onText,attempt)=>{calls++;if(attempt)throw Error('HTTP 429');onText('正常 [S1P4C23]。\n\n错误 [S4C23]');},{signal:signal()});
  assert.equal(calls,2);assert.equal(text,'正常 [S1P4C23]。\n\n错误 （此处论断的原文依据未核实）');
  await assert.rejects(generateCitationResponse(input,()=>sources,async()=>{throw Error('HTTP 429');},{signal:signal()}),/429/);
  const controller=new AbortController(),updates:string[]=[];
  await assert.rejects(generateCitationResponse(input,()=>sources,async(_request,onText)=>{onText('已有正文');controller.abort();},{signal:controller.signal,progress:t=>updates.push(t)}));
  assert.equal(updates[0],'已有正文');
});

test('early account completion leaves pending tools to the existing outer settlement',async()=>{
  let calls=0;
  const text=await generateCitationResponse(input,()=>[],async(_request,onText)=>{calls++;onText('Waiting for paper analysis');},{signal:signal(),pending:()=>true});
  assert.equal(text,'');assert.equal(calls,1);
});
