import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

const bundle=await build({entryPoints:['src/history-export.ts'],bundle:true,platform:'browser',format:'cjs',write:false});
const module={exports:{} as any};
runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,TextEncoder,TextDecoder,atob,btoa,Zotero:{Items:{get:()=>({libraryID:1,key:'PUBLIC'})},Libraries:{get:()=>({libraryType:'user'})}}});
const {historyMarkdown,historyJSON,exportName}=module.exports;
const image={asset:'a'.repeat(64)+'.png',directory:'C:\\private-cache',mimeType:'image/png',width:1,height:1,bytes:new Uint8Array([1,2,3])};
const session={id:'test',title:'Test <paper>',updated:1,papers:[{id:1,title:'Paper'}],sources:[{id:'S1P1C1',itemID:1,attachmentID:2,title:'Paper',page:1,text:'Quoted source',image}],messages:[{role:'user',text:'Explain'},{role:'assistant',text:'Answer [S1P1C1]\n\n$x_i$',partial:true}],pinned:true,archived:true};

test('batch Markdown keeps distinct citation references and portable source images',async()=>{
  const markdown=await historyMarkdown([session,{...session,id:'second'}]);
  assert.match(markdown,/\[folio-1-S1P1C1\]: zotero:\/\/open-pdf\/library\/items\/PUBLIC\?page=1/);
  assert.match(markdown,/\[folio-2-S1P1C1\]:/);assert.ok(markdown.includes('[\\[1\\]][folio-1-S1P1C1]'));assert.ok(markdown.includes('[\\[2\\]][folio-2-S1P1C1]'));assert.match(markdown,/> Quoted source/);
  assert.match(markdown,/data:image\/png;base64,AQID/);assert.ok(markdown.includes('$x_i$'));assert.match(markdown,/此回答未完成/);
  assert.ok(!markdown.includes('private-cache'));
});

test('generated images are portable in Markdown and JSON instead of leaking local paths',async()=>{
  const data={...session,messages:[{role:'assistant',text:'Generated image.',generatedImages:[image]}]};
  const markdown=await historyMarkdown([data]),json=await historyJSON([data]);
  assert.match(markdown,/生成图片 1/);assert.match(markdown,/data:image\/png;base64,AQID/);
  assert.equal(JSON.parse(json).sessions[0].messages[0].generatedImages[0].data,'AQID');assert.ok(!json.includes('private-cache'));assert.ok(!json.includes('"bytes"'));
});

test('export hierarchy groups questions and keeps answer headings, formulas and code intact',async()=>{
  const text='# Overview\n\n## Method\n\n$x_i$\n\n```md\n# Not a heading\n[S1P1C1]\n```\n\nReference [S1P1C1]';
  const markdown=await historyMarkdown([{...session,messages:[session.messages[0],{role:'assistant',model:'Example model',text}]}]);
  assert.match(markdown,/## 问题 1/);assert.match(markdown,/\*\*Inthes\*\* · Example model/);
  assert.match(markdown,/### Overview\n\n#### Method/);assert.ok(markdown.includes('```md\n# Not a heading\n[S1P1C1]\n```'));
  assert.ok(markdown.includes('$x_i$'));assert.ok(markdown.indexOf('data:image/png')>markdown.indexOf('## 引用原文'));
});

test('JSON embeds original image bytes without mutating saved file references',async()=>{
  const output=await historyJSON([session]),saved=JSON.parse(output).sessions[0];
  assert.equal(saved.sources[0].image.data,'AQID');assert.equal(saved.sources[0].image.directory,undefined);
  assert.equal(saved.pinned,true);assert.equal(saved.archived,true);assert.equal(saved.messages.length,2);
  assert.equal(session.sources[0].image.directory,'C:\\private-cache');assert.ok(!output.includes('private-cache'));
});

test('cited MinerU tables and equations keep their original markup and backslashes',async()=>{
  const equation=String.raw`\mathcal{L}_{DINO} = - \sum p_{t} \log p_{s}`;
  const matrix=String.raw`\begin{matrix}a & b \\ c & d\end{matrix}`;
  const table='<table><tr><td rowspan="2">DINOv2</td><td>ViT-S/14</td></tr><tr><td>ViT-B/14</td></tr></table>';
  const text=`$$\n${equation}\n$$\n\n${table}\n\n$$\n${matrix}\n$$`;
  const markdown=await historyMarkdown([{...session,sources:[{...session.sources[0],text,image:undefined}]}]);
  assert.ok(markdown.includes(`> $$\n> ${equation}\n> $$`));
  assert.ok(markdown.includes(`> ${table}`));assert.ok(markdown.includes(`> ${matrix}`));
  assert.ok(!markdown.includes(String.raw`\\mathcal`));
});

test('export filenames cannot create paths or Windows device names',()=>{
  assert.equal(exportName('CON'),'Inthes 对话');assert.equal(exportName('LPT1.txt'),'Inthes 对话');
  assert.equal(exportName('a/b:c?'),'a_b_c_');assert.equal(exportName('Paper. '),'Paper');
});

test('export resolves non-ASCII and spaced citations while preserving code examples',async()=>{
  const markdown=await historyMarkdown([{...session,messages:[{role:'assistant',text:'Source 【S1P1C1】 and [ S1P1C1 ] and [S1P1P1] and `[S1P1C1]`. Example `const citation = "【S9P9C9】"`.'}]}]);
  assert.equal(markdown.split('[\\[1\\]][folio-1-S1P1C1]').length-1,4);
  assert.ok(markdown.includes('`const citation = "【S9P9C9】"`'));assert.match(markdown,/> Quoted source/);
});
