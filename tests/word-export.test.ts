import test from 'node:test';
import assert from 'node:assert/strict';
import { unzipSync, strFromU8 } from 'fflate';
import { wordDocument } from '../src/word-export.ts';

test('Word text strips XML noncharacters and nested emphasis produces one property per run',async()=>{
  const text=(value:string)=>({nodeType:3,textContent:value});
  const element=(localName:string,...childNodes:any[]):any=>({nodeType:1,localName,childNodes,classList:{contains:()=>false},getAttribute:()=>null,querySelector:()=>null});
  const body=element('body',element('p',text('Text \ufffe\uffff\u0001 & readable 中文')),element('p',element('strong',element('strong',text('bold'))),element('em',element('em',text('italic')))));
  const doc={body,querySelectorAll:()=>[]} as unknown as Document;
  const parts=unzipSync(await wordDocument({},doc)),xml=strFromU8(parts['word/document.xml']);
  assert.doesNotMatch(xml,/[\ufffe\uffff\u0001]/);assert.match(xml,/&amp; readable 中文/);
  assert.doesNotMatch(xml,/<w:b\/><w:b\/>|<w:i\/><w:i\/>/);assert.match(xml,/<w:b\/>/);assert.match(xml,/<w:i\/>/);
});
