import test from 'node:test';
import assert from 'node:assert/strict';
import { newProfile } from '../src/types.ts';
import type { Session } from '../src/types.ts';
import { compactHistory, conversationBudget, historyMessages, inputTokens, recordUsage, contextWindow, restoreGeneratedImages } from '../src/conversation.ts';
import { sourcePassages } from '../src/context.ts';

function session(turns=8):Session {
  return {id:'s',title:'test',updated:0,papers:[],sources:[],messages:Array.from({length:turns},(_,i)=>[
    {role:'user' as const,text:`问题 ${i}：`+'中文内容'.repeat(300)},
    {role:'assistant' as const,text:`结论 ${i}：[S1P2C3] `+'相关证据'.repeat(300)}
  ]).flat()};
}

test('rebuilding visual context restores only the latest generated result, including after compaction',async()=>{
  const s=session(2),image={asset:'a'.repeat(64)+'.png',directory:'history-images',mimeType:'image/png' as const,width:32,height:32};
  s.messages[1].generatedImages=[{...image,asset:'b'.repeat(64)+'.png'}];s.messages[3].generatedImages=[image];
  s.compaction={count:1,through:4,summary:'Earlier conversation'};
  const input={system:'Read',messages:[...historyMessages(s),{role:'user' as const,content:'Change its colour'}]},original=structuredClone(s);
  const loaded:string[]=[];
  const restored=await restoreGeneratedImages(input,s,async figure=>{loaded.push(figure.asset);return {data:'YWJj',mimeType:figure.mimeType,width:figure.width,height:figure.height};});
  assert.deepEqual(loaded,[image.asset]);assert.ok(inputTokens(restored)>inputTokens(input));assert.match(restored.messages.at(-2)!.content,/不是论文原图/);assert.equal(restored.messages.at(-1)!.content,'Change its colour');assert.deepEqual(s,original);
  await assert.rejects(restoreGeneratedImages(input,s,async()=>{throw Error('Missing file');}),/Missing file/);
});
test('default window is 200k and the complete history participates in budgeting',()=>{
  const p=newProfile(),s=session(30);assert.equal(p.contextTokens,200000);assert.equal(p.autoCompactPercent,85);
  assert.equal(historyMessages(s).length,60);assert.equal(conversationBudget(p,s,'follow up').history.length,60);
  const empty=session(0);assert.equal(conversationBudget(p,empty,'').limit,200000);
  const budget=conversationBudget({...p,contextTokens:100000},s,'问题');assert.equal(budget.limit,100000);assert.equal(budget.threshold,85000);
});
test('source passages preserve exact evidence with distinct citation IDs and page targets',()=>{
  const original={id:'S2P9',itemID:2,attachmentID:3,title:'Paper',page:9,text:'第一段。\n\n第二段有方法描述。\n\n'+'Long sentence. '.repeat(300)};
  const passages=sourcePassages(original);assert.ok(passages.length>3);assert.equal(passages[0].text,'第一段。');
  assert.equal(passages[1].id,'S2P9C2');assert.ok(passages.every(s=>s.page===9&&s.attachmentID===3&&s.text.length<=1200));
  assert.equal(passages.map(s=>s.text).join('').replace(/\s/g,''),original.text.replace(/\s/g,''));
});
test('compaction retains recent turns, citations and the full original transcript',async()=>{
  const p=newProfile(),s=session(),original=structuredClone(s.messages);let calls=0;
  await compactHistory(p,s,s.messages.length,async(input,onText)=>{calls++;assert.ok(input.messages[0].content.includes('问题 0'));onText('目标与结论，依据 [S1P2C3]；仍需核查局限。');},new AbortController().signal);
  assert.equal(calls,1);assert.equal(s.compaction?.through,12);assert.equal(s.compaction?.count,1);assert.deepEqual(s.messages,original);
  const active=historyMessages(s);assert.equal(active.length,5);assert.ok(active[0].content.includes('[S1P2C3]'));assert.equal(active[1].content,original[12].text);
  const restored=JSON.parse(JSON.stringify(s));assert.deepEqual(historyMessages(restored),active);
});
test('switching to a smaller context batches oversized history within the new window',async()=>{
  const p={...newProfile(),contextTokens:8000,maxTokens:1000},s=session(5);s.messages[0].text='巨型消息'.repeat(7000);let calls=0;
  await compactHistory(p,s,s.messages.length,async(input,onText)=>{calls++;assert.ok(inputTokens(input)+p.maxTokens+512<=p.contextTokens);onText('合并摘要，保留用户约束与 [S1P2C3]。');},new AbortController().signal);
  assert.ok(calls>2);assert.equal(s.messages[0].text.length,28000);assert.ok(s.compaction);
});
test('subsequent compaction carries the existing summary forward',async()=>{
  const p=newProfile(),s=session();s.compaction={summary:'旧结论 [S1P1C1]',through:4,count:1};
  await compactHistory(p,s,s.messages.length,async(input,onText)=>{assert.ok(input.messages[0].content.includes('旧结论 [S1P1C1]'));assert.ok(!input.messages[0].content.includes('问题 0'));onText('合并旧结论与新结论 [S1P1C1] [S1P2C3]。');},new AbortController().signal);
  assert.equal(s.compaction?.count,2);assert.equal(s.compaction?.through,12);
});
test('failed or cancelled compaction leaves prior summary and messages intact',async()=>{
  for(const mode of ['failure','abort','too-long']){
    const s=session(),p=newProfile(),control=new AbortController();s.compaction={summary:'已保存摘要',through:2,count:1};const before=structuredClone(s);
    await assert.rejects(compactHistory(p,s,s.messages.length,async(_input,onText)=>{
      onText(mode==='too-long'?'超长摘要'.repeat(5000):'部分摘要');if(mode==='failure')throw new Error('network failed');if(mode==='abort')control.abort();
    },control.signal));assert.deepEqual(s,before);
  }
});
test('usage includes previous evidence, output reserve and the new question at the threshold',()=>{
  const s=session(1),p={...newProfile(),contextTokens:10000,maxTokens:1000};
  s.sources=[{id:'S1P1',itemID:1,title:'Paper',text:'文献证据'.repeat(3000)}];s.evidenceTokens=3000;
  const before=conversationBudget(p,s,''),after=conversationBudget(p,s,'后续问题'.repeat(800));
  assert.ok(before.used<before.threshold);assert.ok(after.used>=after.threshold);assert.ok(after.evidenceBudget<before.evidenceBudget);
});
test('usage grows with each turn even when sources exceed the available evidence budget',()=>{
  const s=session(0),p={...newProfile(),contextTokens:10000,maxTokens:1000};
  s.sources=[{id:'S1P1',itemID:1,title:'Paper',text:'文献证据'.repeat(5000)}];
  for(const evidenceTokens of [undefined,3000]) {
    s.evidenceTokens=evidenceTokens;const before=conversationBudget(p,s,'');
    s.messages.push({role:'user',text:'追问细节'},{role:'assistant',text:'新增回答及依据。'});
    const after=conversationBudget(p,s,'');
    assert.ok(after.used>before.used);assert.equal(after.used-before.used,after.fixed-before.fixed);
  }
});
test('reported context updates on each turn, estimates drafts, and does not count output reserve as occupied',()=>{
  const s=session(1),p={...newProfile('codex-account'),model:'test'};
  recordUsage(p,s,{inputTokens:2000,outputTokens:500,contextTokens:2500,modelContextWindow:272000},s.messages.at(-1)!.text);
  const first=conversationBudget(p,s,'');assert.equal(first.context,2500);assert.equal(first.exact,true);assert.equal(first.limit,272000);assert.equal(first.used,2500+p.maxTokens+512);
  assert.ok(conversationBudget(p,s,'新增问题'.repeat(100)).context>first.context);
  s.messages.push({role:'user',text:'追问'},{role:'assistant',text:'新的回答'});
  assert.ok(conversationBudget(p,s,'').context>first.context);
  recordUsage(p,s,{inputTokens:2900,outputTokens:100,contextTokens:3000},'新的回答');assert.equal(conversationBudget(p,s,'').context,3000);
  assert.equal(conversationBudget({...p,model:'other'},s,'').calibrated,false);
  s.compaction={count:1,through:2,summary:'历史摘要'};assert.equal(conversationBudget(p,s,'').calibrated,false);
});
test('API input usage calibrates context without retaining hidden reasoning or cumulative billing',()=>{
  const s=session(1),p=newProfile('openrouter');
  recordUsage(p,s,{inputTokens:5000,outputTokens:300,reasoningTokens:200,totalTokens:5300},s.messages.at(-1)!.text);
  const budget=conversationBudget(p,s,'');assert.equal(budget.context,5100);assert.equal(budget.exact,false);assert.equal(budget.calibrated,true);
  assert.ok(budget.used>=budget.context+p.maxTokens);
  s.messages.splice(0);assert.equal(conversationBudget(p,s,'').calibrated,false);
});
test('explicit context cap is respected and automatic mode uses reported model window',()=>{
  const p={...newProfile(),model:'test',models:[{id:'test',name:'Test',contextWindow:64000}]};
  assert.equal(contextWindow(p),64000);assert.equal(contextWindow({...p,contextTokens:16000,contextAuto:false}),16000);
  assert.equal(contextWindow({...p,contextTokens:200000,contextAuto:false}),64000);
});
