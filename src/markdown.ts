import { Marked } from 'marked';
import type { TokenizerAndRendererExtension } from 'marked';
import katex from 'katex';

const escapeHTML=(text:string)=>text.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);

function mathToken(src:string,block:boolean) {
  const opening=(block?/^ {0,3}(\$\$|\\\[)/:/^(\$\$|\$|\\\(|\\\[)/).exec(src);
  if(!opening)return;
  const left=opening[1],right=left==='\\('? '\\)':left==='\\['?'\\]':left;
  const start=opening[0].length,display=left==='$$'||left==='\\[';
  let depth=0;
  for(let i=start;i<src.length;i++) {
    if(left==='$'&&src[i]==='\n')return;
    if(depth===0&&src.startsWith(right,i)) {
      if(left==='$'&&/\d/.test(src[i+1]||''))return;
      const text=src.slice(start,i);if(!text.trim())return;
      if(left==='$'&&/^\s|\s$/.test(text)&&!/[\\_^=+<>]|^\s*[a-zA-Z]\s*$/.test(text))return;
      return {type:block?'mathBlock':'mathInline',raw:src.slice(0,i+right.length),text,display};
    }
    if(src[i]==='\\'){i++;continue;}
    if(src[i]==='{')depth++;
    else if(src[i]==='}')depth=Math.max(0,depth-1);
  }
}

function mathExtension(block:boolean):TokenizerAndRendererExtension {
  return {
    name:block?'mathBlock':'mathInline',level:block?'block':'inline',
    start(src){const match=(block?/^ {0,3}(?:\$\$|\\\[)/m:/\$|\\[([]/).exec(src);return match?.index;},
    tokenizer(src){return mathToken(src,block);},
    renderer(token){return `<span data-folio-math="${token.display?'display':'inline'}">${escapeHTML(token.text)}</span>${block?'\n':''}`;}
  };
}

function looseStrong():TokenizerAndRendererExtension {
  return {
    name:'looseStrong',level:'inline',
    start(src){const index=src.indexOf('**');return index<0?undefined:index;},
    tokenizer(src){
      const match=/^\*\*([“‘「『（《][^*\n]+?)\*\*/u.exec(src)||/^\*\*([^*\n]+?[：:；;，,。.!?？])\*\*(?=[\p{L}\p{N}])/u.exec(src);
      if(!match)return;
      return {type:'looseStrong',raw:match[0],text:match[1],tokens:this.lexer.inlineTokens(match[1])};
    },
    renderer(token){return `<strong>${this.parser.parseInline(token.tokens!)}</strong>`;}
  };
}

// Recognize math before Markdown consumes backslashes, underscores and matrix row breaks.
export const marked=new Marked({extensions:[mathExtension(true),mathExtension(false),looseStrong()],renderer:{
  code({text,lang}) {
    // Models sometimes put a standalone equation in an unlabelled code fence.
    if(lang||text.includes('\n')||!text.includes('=')||!/[_^]/.test(text)||!/\\[a-zA-Z]+|[\u0370-\u03ff\u2200-\u22ff…]|\p{M}/u.test(text.normalize('NFD'))||/[;'"`]/.test(text))return false;
    try { katex.renderToString(text,{output:'mathml',throwOnError:true,trust:false,strict:'ignore',maxSize:20,maxExpand:1000}); }
    catch(error) { if(error instanceof katex.ParseError)return false;throw error; }
    return `<span data-folio-math="display">${escapeHTML(text)}</span>\n`;
  }
}});
const formulas = new Map<string, string>();
export function renderFormula(tex:string,display:boolean) {
  // Zotero's Gecko engine renders MathML natively, so no remote scripts or font downloads are needed.
  const key = `${display}:${tex}`, cached = formulas.get(key);
  if (cached !== undefined) return cached;
  const html = katex.renderToString(tex,{displayMode:display,output:'mathml',throwOnError:false,trust:false,strict:'ignore',maxSize:20,maxExpand:1000});
  if (formulas.size >= 256) formulas.delete(formulas.keys().next().value!);
  formulas.set(key, html);
  return html;
}
