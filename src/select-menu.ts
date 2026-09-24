import deepseek from './assets/deepseek.svg';
import openrouter from './assets/openrouter.svg';
import openai from './assets/openai.svg';
import gemini from './assets/gemini.svg';
import anthropic from './assets/anthropic.svg';
import antigravity from './assets/antigravity.svg';
import qwen from './assets/qwen.svg';
import kimi from './assets/kimi.svg';
import glm from './assets/glm.svg';
import minimax from './assets/minimax.svg';

const escape=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]!);
const descriptions:Record<string,string>={qwen:'阿里云百炼 · API / Token Plan',kimi:'月之暗面开放平台 API',glm:'智谱开放平台 API',minimax:'MiniMax · API / Token Plan',deepseek:'使用 DeepSeek API',openrouter:'一个 Key，连接多家模型',openai:'使用 OpenAI API',gemini:'使用 Gemini API',anthropic:'使用 Anthropic API','codex-account':'通过 ChatGPT 账户登录','antigravity-account':'使用官方 Antigravity CLI 账户',custom:'连接自己的模型服务'};
const marks:Record<string,string>={deepseek,openrouter,openai,gemini,anthropic,qwen,kimi,glm,minimax,'codex-account':openai,'antigravity-account':antigravity};
export const serviceMark=(preset:string,label='C')=>`<span class="service-mark${marks[preset]?' service-logo':''}" aria-hidden="true">${marks[preset]?`<img src="${escape(marks[preset])}" alt="">`:escape(label.slice(0,1).toUpperCase())}</span>`;
const protocolDescriptions:Record<string,string>={chat:'经典对话接口 · /chat/completions',responses:'Responses 接口 · /responses',anthropic:'Claude 消息接口 · /messages',gemini:'Google 原生接口 · generateContent'};
const effortDescriptions:Record<string,string>={'':'跟随模型',none:'不启用推理',minimal:'尽快作答',low:'更快作答',medium:'平衡速度与推理',high:'更充分地思考',xhigh:'深入分析复杂问题',max:'使用最高推理强度'};
export const effortLabels:Record<string,string>={none:'关闭',minimal:'极低',low:'低',medium:'中',high:'高',xhigh:'很高',max:'最高'};
export function modelBrand(id:string,preset:string){const name=id.toLowerCase();if(/(^|[/:-])(?:gpt|o[134])(?:[-./]|$)|^openai\//.test(name))return 'openai';if(name.includes('claude'))return 'anthropic';if(name.includes('gemini'))return 'gemini';if(name.includes('deepseek'))return 'deepseek';return preset;}

// Keep native select values and change events as the form contract; only replace their presentation.
export class SelectMenu {
  private select?:HTMLSelectElement;
  private popup?:HTMLElement;
  private trigger?:HTMLButtonElement;
  private outside=(event:Event)=>{if(!event.composedPath().includes(this.host))this.close();};
  private resize=()=>this.close();
  constructor(private win:any,private root:ShadowRoot,private host:HTMLElement) {
    root.addEventListener('click',event=>{
      const target=event.target as Element;
      const trigger=target.closest<HTMLButtonElement>('[data-select-trigger]');
      if(trigger){event.preventDefault();this.open(trigger);return;}
      const option=target.closest<HTMLButtonElement>('[data-select-option]');
      if(option&&this.select){event.preventDefault();const select=this.select;select.value=option.dataset.selectOption!;this.close(true);this.refresh();select.dispatchEvent(new win.Event('change',{bubbles:true}));return;}
      if(!target.closest('.select-popover'))this.close();
    });
    root.addEventListener('input',event=>{if((event.target as Element).id==='select-search')this.results();});
    root.addEventListener('keydown',event=>this.keydown(event as KeyboardEvent));
    root.addEventListener('focusout',()=>{win.setTimeout(()=>{const active=root.activeElement;if(this.popup&&!this.popup.contains(active)&&active!==this.trigger)this.close();},0);});
    root.addEventListener('scroll',event=>{if(this.popup&&!(event.target as Element).closest?.('.select-popover'))this.close();},true);
    win.document.addEventListener('pointerdown',this.outside);win.addEventListener('resize',this.resize);
  }
  refresh() {
    for(const select of this.root.querySelectorAll<HTMLSelectElement>('#profile-form select, #quick-reasoning, .mineru-advanced select, #library-collection, #library-job')) {
      let wrap=select.parentElement!;
      if(!wrap.classList.contains('select-box')) {
        const label=select.getAttribute('aria-label')||select.closest('.field')!.querySelector('span')!.textContent!;
        wrap=this.win.document.createElementNS('http://www.w3.org/1999/xhtml','div');wrap.className='select-box';select.before(wrap);wrap.append(select);select.hidden=true;select.tabIndex=-1;
        const button=this.win.document.createElementNS('http://www.w3.org/1999/xhtml','button');button.type='button';button.className='select-trigger';button.dataset.selectTrigger=select.name;button.setAttribute('role','combobox');button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-label',label);button.setAttribute('aria-expanded','false');wrap.append(button);
      }
      const button=wrap.querySelector<HTMLButtonElement>('button')!;button.disabled=select.disabled;
      button.textContent=select.selectedOptions[0]?.dataset.label||select.selectedOptions[0]?.textContent||'请选择';
    }
    if(this.select?.disabled)this.close();else if(this.popup)this.results();
  }
  open(trigger:HTMLButtonElement,focusLast=false) {
    if(this.trigger===trigger&&this.popup){this.close(true);return;}
    this.close();this.trigger=trigger;this.select=trigger.parentElement!.querySelector('select')!;
    const popup=this.win.document.createElementNS('http://www.w3.org/1999/xhtml','div') as HTMLElement;this.popup=popup;popup.className='select-popover';
    popup.dataset.kind=this.select.name;
    const heading=this.win.document.createElementNS('http://www.w3.org/1999/xhtml','div');heading.className='select-heading';heading.textContent=trigger.getAttribute('aria-label')!;popup.append(heading);
    if(this.select.name==='model'||this.select.options.length>10){const search=this.win.document.createElementNS('http://www.w3.org/1999/xhtml','input');const label=this.select.name==='library-collection'?'搜索分类':this.select.name==='library-job'?'搜索分析任务':'搜索模型';search.id='select-search';search.placeholder=label+'名称…';search.setAttribute('aria-label',label);search.type='search';popup.append(search);}
    const list=this.win.document.createElementNS('http://www.w3.org/1999/xhtml','div');list.id='select-options';list.className='select-options';list.setAttribute('role','listbox');list.setAttribute('aria-label',trigger.getAttribute('aria-label')!);popup.append(list);
    this.root.querySelector('.shell')!.append(popup);trigger.setAttribute('aria-expanded','true');trigger.setAttribute('aria-controls','select-options');this.results();
    const rect=trigger.getBoundingClientRect(),bounds=this.host.getBoundingClientRect();const width=Math.min(Math.max(rect.width,this.select.name==='quick-reasoning'?238:300),bounds.width-24);
    popup.style.width=`${width}px`;popup.style.left=`${Math.max(bounds.left+12,Math.min(rect.left,bounds.right-width-12))}px`;
    const below=bounds.bottom-rect.bottom-18,above=rect.top-bounds.top-18;const up=this.select.name==='quick-reasoning'||(below<200&&above>below);
    popup.style.maxHeight=`${Math.min(360,Math.max(100,up?above:below))}px`;
    popup.style.top=`${up?Math.max(bounds.top+8,rect.top-popup.getBoundingClientRect().height-6):rect.bottom+6}px`;
    const options=popup.querySelectorAll<HTMLButtonElement>('[data-select-option]');
    const selected=popup.querySelector<HTMLButtonElement>('[aria-selected=true]');
    (popup.querySelector<HTMLInputElement>('input')||(focusLast?options[options.length-1]:selected||options[0]))?.focus();selected?.scrollIntoView({block:'nearest'});
  }
  private results() {
    if(!this.popup||!this.select)return;
    const query=this.popup.querySelector<HTMLInputElement>('input')?.value.toLowerCase().trim()||'';
    const options=Array.from(this.select.options).filter(o=>!o.disabled&&(this.select!.name!=='model'||o.value)&&(o.textContent||'').toLowerCase().includes(query));
    const service=this.select.name==='preset';
    const reasoning=['reasoning','quick-reasoning'].includes(this.select.name);
    const markup=options.map(o=>{
      const detail=service?descriptions[o.value]:reasoning?effortDescriptions[o.value]:this.select!.name==='protocol'?protocolDescriptions[o.value]:o.dataset.detail;
      const label=reasoning?(effortLabels[o.value]||'默认'):o.dataset.label||o.textContent||'';
      return `<button type="button" role="option" class="select-option" data-select-option="${escape(o.value)}" aria-selected="${o.selected}">${service?serviceMark(o.value,label):o.dataset.brand?serviceMark(o.dataset.brand,o.dataset.brand):''}<span class="select-copy"><span>${escape(label)}</span>${detail?`<small>${escape(detail)}</small>`:''}</span><span class="select-check" aria-hidden="true">${o.selected?'✓':''}</span></button>`;
    }).join('')||'<div class="select-empty">没有匹配的选项</div>';
    const parsed=new this.win.DOMParser().parseFromString(`<body>${markup}</body>`,'text/html');this.popup.querySelector('.select-options')!.replaceChildren(...Array.from(parsed.body.childNodes).map((n:any)=>this.win.document.importNode(n,true)));
  }
  private keydown(event:KeyboardEvent) {
    const target=event.target as HTMLElement;
    if(target.matches('[data-select-trigger]')&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();this.open(target as HTMLButtonElement,event.key==='ArrowUp');return;}
    if(!this.popup)return;
    if(event.key==='Escape'){event.preventDefault();this.close(true);return;}
    if(!target.closest('.select-popover')||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return;
    if(target.tagName.toLowerCase()==='input'&&['Home','End'].includes(event.key))return;
    event.preventDefault();const options=Array.from(this.popup.querySelectorAll<HTMLButtonElement>('[data-select-option]'));const index=options.indexOf(target as HTMLButtonElement);
    const next=event.key==='Home'?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,index+(event.key==='ArrowDown'?1:-1)));options[next]?.focus();
  }
  close(focus=false) {this.popup?.remove();this.popup=undefined;this.select=undefined;this.trigger?.setAttribute('aria-expanded','false');this.trigger?.removeAttribute('aria-controls');if(focus)this.trigger?.focus();this.trigger=undefined;}
  destroy(){this.close();this.win.document.removeEventListener('pointerdown',this.outside);this.win.removeEventListener('resize',this.resize);}
}
