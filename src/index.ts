import { Storage } from './storage.ts';
import { Panel } from './ui.ts';
import { Accounts } from './accounts.ts';
import { readingQuotes, chooseQuote } from './quotes.ts';
export const id='inthes@zxyl1003.github.io';
export const storage=new Storage();
export const panels=new Map<any,Panel>();
let accounts:Accounts;
const listeners=new Map<any,(e:KeyboardEvent)=>void>();
const selectionCleanup=new Map<any,()=>void>();
const sizeCleanup=new Map<any,()=>void>();
let tabObserver:string;
function readerToolbar({reader,doc,append}:any){
  const button=doc.createElement('button');button.id='folio-reader-button';button.textContent='Inthes';button.title='打开 AI 阅读助手';button.style.cssText='-moz-window-dragging:no-drag;border:0;background:none;color:var(--fill-primary);padding:4px 8px;cursor:pointer;font:600 12px Georgia,serif';
  button.addEventListener('click',(event:Event)=>{event.preventDefault();event.stopPropagation();const win=panels.has(reader._window)?reader._window:Zotero.getMainWindow();Zotero.Folio.show(win);win.focus();});append(button);
}
export async function start(){
  await storage.init();
  const quote=chooseQuote(Zotero.Prefs.get('extensions.folio.startupQuote',true));
  Zotero.Prefs.set('extensions.folio.startupQuote',quote,true);
  Zotero.Folio = { panels, storage, show, hide, toggle, quote:readingQuotes[quote] };
  const win=Zotero.getMainWindow();accounts=new Accounts(storage,win);
  for(const win of Zotero.getMainWindows())attach(win);
  tabObserver=Zotero.Notifier.registerObserver({notify(event:string){if(['select','load','close'].includes(event))for(const panel of panels.values())panel.syncSelection();}},['tab'],'folio-selection');
  Zotero.Reader.registerEventListener('renderToolbar',readerToolbar,id);
  // Already-open PDF toolbars survive plugin updates; replace their stale callbacks too.
  for(const reader of Zotero.Reader._readers){const doc=reader._iframeWindow?.document;const toolbar=doc?.querySelector('.toolbar .custom-sections');if(!toolbar)continue;for(const old of toolbar.querySelectorAll('button'))if(old.id==='folio-reader-button')old.remove();readerToolbar({reader,doc,append:(button:HTMLElement)=>toolbar.append(button)});}
  Zotero.Reader.registerEventListener('renderTextSelectionPopup',({reader,doc,params,append}:any)=>{const button=doc.createElement('button');button.textContent='询问 Inthes';button.addEventListener('click',()=>{const win=Zotero.getMainWindow();show(win);const panel=panels.get(win)!;if(panel.controller)return;if(panel.contextLocked&&!panel.session.papers.some(p=>p.attachmentID===reader.itemID)){panel.toast('请新建对话，再询问这篇文献。');return;}panel.syncSelection();panel.view='chat';panel.render();const prompt=panel.root.querySelector<HTMLTextAreaElement>('#prompt')!;prompt.value=`请解释这段文字：\n${params.annotation?.text||''}`;prompt.dispatchEvent(new win.Event('input',{bubbles:true}));prompt.focus();});append(button);},id);
}
export function attach(win:any){
  if(panels.has(win)||!win.document.getElementById('browser'))return;
  const doc=win.document;
  const splitter=doc.createXULElement('splitter');splitter.id='folio-splitter';splitter.setAttribute('orient','horizontal');splitter.setAttribute('resizebefore','closest');splitter.setAttribute('resizeafter','closest');splitter.setAttribute('hidden','true');splitter.setAttribute('tooltiptext','左右拖动以调整 Inthes 宽度');splitter.style.cssText='width:5px;min-width:5px;max-width:5px;border:0;cursor:ew-resize;background:linear-gradient(to right,transparent 2px,var(--material-border,#e1e5dc) 2px,var(--material-border,#e1e5dc) 3px,transparent 3px);';
  const box=doc.createXULElement('vbox');box.id='folio-pane';box.setAttribute('hidden','true');box.style.cssText='width:420px;flex:0 0 auto;min-width:340px;max-width:720px;overflow:hidden;';
  const savedWidth=Zotero.Prefs.get('extensions.folio.sidebarWidth',true);
  if(typeof savedWidth==='number'&&savedWidth>=340&&savedWidth<=720)box.style.width=`${savedWidth}px`;
  let resizing=false;splitter.addEventListener('mousedown',()=>{resizing=true;});
  const saveWidth=()=>{if(!resizing)return;resizing=false;const width=box.getBoundingClientRect().width;if(width>=340&&width<=720)Zotero.Prefs.set('extensions.folio.sidebarWidth',Math.round(width),true);};
  win.addEventListener('mouseup',saveWidth);sizeCleanup.set(win,()=>win.removeEventListener('mouseup',saveWidth));
  const panel=new Panel(win,storage,accounts,()=>hide(win));panels.set(win,panel);box.append(panel.host);doc.getElementById('browser').append(splitter,box);
  const toolbar=doc.getElementById('zotero-toolbar-item-tree');if(toolbar){const button=doc.createXULElement('toolbarbutton');button.id='folio-button';button.setAttribute('label','Inthes');button.setAttribute('tooltiptext','Inthes · 论文阅读助手 (Ctrl+Shift+F)');button.style.cssText='font-family:Georgia,serif;font-weight:600;padding-inline:9px;';button.addEventListener('command',()=>toggle(win));toolbar.append(button);}
  const menu=doc.getElementById('menu_ToolsPopup');if(menu){const item=doc.createXULElement('menuitem');item.id='folio-menu';item.setAttribute('label','Inthes · 论文阅读助手');item.addEventListener('command',()=>toggle(win));menu.append(item);}
  const key=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.shiftKey&&e.key.toLowerCase()==='f'){e.preventDefault();toggle(win);}};win.addEventListener('keydown',key);listeners.set(win,key);
  // uiReadyPromise is global and may already be resolved when a second window opens.
  let selectionTimer:any;
  const bindSelection=()=>{
    if(panels.get(win)!==panel)return;
    const tree=win.ZoteroPane.itemsView;
    if(!tree){selectionTimer=win.setTimeout(bindSelection,100);return;}
    const sync=()=>panel.syncSelection();tree.onSelect.addListener(sync);
    selectionCleanup.set(win,()=>tree.onSelect.removeListener(sync));sync();
  };
  selectionCleanup.set(win,()=>win.clearTimeout(selectionTimer));
  void Zotero.uiReadyPromise.then(bindSelection);
}
export function show(win=Zotero.getMainWindow()){attach(win);const box=win.document.getElementById('folio-pane');box?.removeAttribute('hidden');box?.removeAttribute('collapsed');const splitter=win.document.getElementById('folio-splitter');splitter?.removeAttribute('hidden');splitter?.setAttribute('state','open');panels.get(win)?.syncSelection();}
export function hide(win:any){win.document.getElementById('folio-pane')?.setAttribute('hidden','true');win.document.getElementById('folio-splitter')?.setAttribute('hidden','true');}
export function toggle(win:any){if(win.document.getElementById('folio-pane')?.hasAttribute('hidden'))show(win);else hide(win);}
export function detach(win:any){sizeCleanup.get(win)?.();sizeCleanup.delete(win);selectionCleanup.get(win)?.();selectionCleanup.delete(win);panels.get(win)?.destroy();panels.delete(win);for(const id of ['folio-pane','folio-splitter','folio-button','folio-menu'])win.document.getElementById(id)?.remove();const listener=listeners.get(win);if(listener)win.removeEventListener('keydown',listener);listeners.delete(win);}
export function stop(){if(tabObserver)Zotero.Notifier.unregisterObserver(tabObserver);Zotero.Reader.unregisterEventListener('renderToolbar',readerToolbar);for(const reader of Zotero.Reader._readers)reader._iframeWindow?.document.getElementById('folio-reader-button')?.remove();accounts?.stop();for(const win of [...panels.keys()])detach(win);delete Zotero.Folio;}
