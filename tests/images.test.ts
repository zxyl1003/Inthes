import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, fetchModels } from '../src/api.ts';
import { accountPrompt, imageModelError, supportsImages, imageTokens } from '../src/images.ts';
import { compactHistory, conversationBudget, historyMessages, inputTokens } from '../src/conversation.ts';
import { newProfile } from '../src/types.ts';
import type { ChatInput, ImageInput, Session } from '../src/types.ts';

const image:ImageInput={data:'aGVsbG8=',mimeType:'image/png',width:800,height:600};
const input:ChatInput={system:'Read supplied evidence.',messages:[{role:'user',content:'First figure',images:[image]},{role:'assistant',content:'First answer'},{role:'user',content:'Compare',images:[{...image,mimeType:'image/jpeg'}]}]};
test('image blocks and roles are serialized for all four API formats without leaking internal fields',()=>{
  for(const protocol of ['chat','responses','anthropic','gemini'] as const){
    const p={...newProfile('custom'),protocol,model:'vision',baseURL:'https://example.com/v1'};
    const body=buildRequest(p,'key',input).body;
    assert.ok(!JSON.stringify(body).includes('"images"'));
    if(protocol==='chat'){
      assert.equal(body.messages[1].content[1].image_url.url,'data:image/png;base64,aGVsbG8=');
      assert.equal(body.messages[2].content,'First answer');assert.equal(body.messages[3].content[1].image_url.url,'data:image/jpeg;base64,aGVsbG8=');
    }else if(protocol==='responses'){
      assert.equal(body.input[0].content[1].type,'input_image');assert.equal(body.input[0].content[1].image_url,'data:image/png;base64,aGVsbG8=');assert.equal(body.input[1].content,'First answer');
    }else if(protocol==='anthropic'){
      assert.deepEqual(body.messages[0].content[0],{type:'image',source:{type:'base64',media_type:'image/png',data:image.data}});assert.equal(body.messages[1].content,'First answer');
    }else {assert.deepEqual(body.contents[0].parts[1],{inlineData:{mimeType:'image/png',data:image.data}});assert.equal(body.contents[1].role,'model');}
  }
});
test('account prompts retain the association of images with each historical question',()=>{
  const codex=accountPrompt(input);
  assert.equal(codex[0].text,'用户：First figure');assert.deepEqual(codex[1],{type:'image',url:'data:image/png;base64,aGVsbG8='});assert.equal(codex[2].text,'助手：First answer');assert.equal(codex[4].type,'image');
});
test('discovery distinguishes known vision, text-only and unknown models; manual confirmation is scoped to the model',async()=>{
  const models=await fetchModels(newProfile('openrouter'),'key',new AbortController().signal,async()=>Response.json({data:[
    {id:'vl',architecture:{input_modalities:['text','image']}},{id:'llm',architecture:{input_modalities:['text']}},{id:'unknown'}
  ]}));
  const p={...newProfile('custom'),models,model:'vl'};
  assert.equal(supportsImages(p),true);assert.equal(imageModelError(p),'');
  p.model='llm';assert.equal(supportsImages(p),false);assert.match(imageModelError(p),/切换/);
  p.model='unknown';assert.equal(supportsImages(p),undefined);assert.match(imageModelError(p),/尚未确认/);
  p.visionOverrides={unknown:true,llm:true};assert.equal(supportsImages(p),true);
  p.model='llm';assert.equal(supportsImages(p),false);p.model='different';assert.equal(supportsImages(p),undefined);
});
test('history preserves images and counts visual input rather than base64 characters',()=>{
  const s:Session={id:'s',title:'test',updated:0,papers:[],sources:[],messages:[{role:'user',text:'图',images:[image]},{role:'assistant',text:'文字解读'}]};
  assert.deepEqual(historyMessages(JSON.parse(JSON.stringify(s)))[0].images,[image]);
  const before=inputTokens({system:'',messages:[{role:'user',content:'图'}]});
  assert.equal(inputTokens({system:'',messages:[{role:'user',content:'图',images:[{...image,data:'a'.repeat(1000000)}]}]})-before,imageTokens([image]));
  const p=newProfile();assert.equal(conversationBudget(p,s,'',2,[image]).fixed-conversationBudget(p,s,'').fixed,imageTokens([image]));
});
test('compacting visual history preserves originals and explicitly limits the summary to prior text interpretations',async()=>{
  const s:Session={id:'s',title:'test',updated:0,papers:[],sources:[],messages:Array.from({length:5},()=>[{role:'user' as const,text:'观察图片'.repeat(300),images:[image]},{role:'assistant' as const,text:'已有文字解读'.repeat(300)}]).flat()};
  const original=structuredClone(s.messages);
  await compactHistory(newProfile(),s,s.messages.length,async(i,onText)=>{assert.match(i.messages[0].content,/不推测原图/);onText('先前图片的文字结论。');},new AbortController().signal);
  assert.deepEqual(s.messages,original);assert.match(historyMessages(s)[0].content,/原始图片已退出/);assert.deepEqual(historyMessages(s)[1].images,[image]);
});
