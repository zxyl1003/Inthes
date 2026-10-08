import test from 'node:test';
import assert from 'node:assert/strict';
import { marked, renderFormula } from '../src/markdown.ts';

const parse=(text:string)=>marked.parse(text,{async:false});
test('bold punctuation in Chinese answers renders without changing code examples',()=>{
  const html=parse('DJIST 的关键是**“共享利用图像数据”**：\n\n**一句话概括：**DJIST 保留序列线索。');
  assert.match(html,/关键是<strong>“共享利用图像数据”<\/strong>：/);
  assert.match(html,/<strong>一句话概括：<\/strong>DJIST/);
  assert.match(parse('`**“原样”**`'),/<code>\*\*“原样”\*\*<\/code>/);
  assert.match(parse('```md\n**“原样”**\n```'),/<code class="language-md">\*\*“原样”\*\*\n<\/code>/);
});
test('inline and display delimiters preserve TeX before Markdown parses it',()=>{
  for(const [left,right,display] of [['$','$',false],['\\(','\\)',false],['$$','$$',true],['\\[','\\]',true]] as const){
    const tex=String.raw`\frac{x_i^2}{\sum_{j=1}^n y_j}`;
    const html=parse(`${left}${tex}${right}`);
    assert.ok(html.includes(`data-folio-math="${display?'display':'inline'}"`));assert.ok(html.includes(tex));assert.ok(!html.includes('<em>'));
  }
});
test('math works in lists and table cells, without rendering examples or currency as math',()=>{
  const html=parse('- $x_1$\n\n| A | B |\n|---|---|\n| \\(y^2\\) | $z$ |');
  assert.equal((html.match(/data-folio-math/g)||[]).length,3);
  for(const example of ['`$x^2$`','```latex\n$$x^2$$\n```',String.raw`\$5 and \$10`,'$5 and $10','Only $5 today'])assert.ok(!parse(example).includes('data-folio-math'));
});
test('space-padded inline formulas retain subscripts, powers and commands without treating currency as math',()=>{
  for(const tex of [String.raw`x_i^2`,String.raw`\hat v_{t+1}`,String.raw`\alpha+\beta`,'x']){
    const html=parse(`$ ${tex} $`);assert.ok(html.includes('data-folio-math="inline"'));assert.ok(html.includes(tex));
  }
  assert.ok(!parse('$ 5 and $ 10').includes('data-folio-math'));
});
test('unlabelled standalone mathematical equations render while source examples and programs remain code',()=>{
  const tex='Z_t = [ q , ṽ_0 , e(a_0) , ṽ_1 , e(a_1) , … , ṽ_t ]';
  const html=parse('```\n'+tex+'\n```');assert.ok(html.includes('data-folio-math="display"'));assert.ok(!html.includes('<code>'));
  const math=renderFormula(tex,true);assert.equal((math.match(/<msub>/g)||[]).length,6);assert.equal((math.match(/<mover /g)||[]).length,3);
  assert.ok(parse('```\ny_i = \\alpha x_i^2\n```').includes('data-folio-math'));
  for(const example of ['```python\n'+tex+'\n```','```latex\n'+tex+'\n```','```\nx_1 = y_2\n```','```\nx_1 = "α"\n```','```\nx_i = \\unknown{a}\n```'])assert.ok(parse(example).includes('<code'));
});
test('multiline matrices and aligned equations retain row breaks and nested braces',()=>{
  const tex=String.raw`\begin{aligned}
A &= \begin{pmatrix}1 & 2 \\ 3 & 4\end{pmatrix} \\
y &= \frac{a_{i}}{b}
\end{aligned}`;
  const tokens=marked.lexer(`\\[\n${tex}\n\\]`);assert.equal(tokens[0].type,'mathBlock');assert.equal(tokens[0].text.trim(),tex);
  const math=renderFormula(tex,true);assert.ok(math.includes('<mtable'));assert.ok(math.includes('display="block"'));assert.ok(!math.includes('katex-error'));
});
test('a streamed formula is only rendered after its closing delimiter arrives',()=>{
  for(const pair of [['$','$'],['\\(','\\)'],['$$','$$'],['\\[','\\]']]){
    const start=pair[0]+String.raw`\frac{a_i}{b}`;
    assert.ok(!parse(start).includes('data-folio-math'));assert.ok(parse(start+pair[1]).includes('data-folio-math'));
  }
});
test('formula rendering emits native MathML and disables unsafe commands',()=>{
  assert.ok(renderFormula(String.raw`\int_0^1 x^2 dx`,false).includes('<msubsup>'));
  for(const tex of [String.raw`\href{javascript:alert(1)}{x}`,String.raw`\includegraphics{https://example.com/image.png}`,String.raw`\htmlStyle{position:fixed}{x}`]){
    const html=renderFormula(tex,false);assert.ok(!/<(?:a|img|script)\b/i.test(html));assert.ok(!/style="position:/i.test(html));
  }
  assert.doesNotThrow(()=>renderFormula(String.raw`\frac{a}`,false));
});
