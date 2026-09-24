import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';

const bundle=await build({entryPoints:['src/index.ts'],bundle:true,platform:'browser',format:'cjs',write:false,plugins:[{
  name:'window-dependencies',setup(b){b.onLoad({filter:/src[\\/](ui|storage|accounts)\.ts$/},args=>({contents:args.path.endsWith('ui.ts')?'export class Panel { host={}; synced=0; constructor(){} syncSelection(){this.synced++} destroy(){} }':args.path.endsWith('storage.ts')?'export class Storage {}':'export class Accounts {}',loader:'js'}));}
}]});

function harness(){
  const module={exports:{} as any},elements=new Map<string,any>(),timers=new Map<number,()=>void>();let timerID=0;
  const element=()=>({style:{},setAttribute(){},addEventListener(){},append(){},remove(){}});
  elements.set('browser',element());
  const win={document:{getElementById:(id:string)=>elements.get(id),createXULElement:element},ZoteroPane:{itemsView:false as any},addEventListener(){},removeEventListener(){},setTimeout(fn:()=>void){timers.set(++timerID,fn);return timerID;},clearTimeout(id:number){timers.delete(id);}};
  runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,Zotero:{Prefs:{get:()=>undefined},uiReadyPromise:Promise.resolve()}});
  return {win,timers,api:module.exports,flush:async()=>{await Promise.resolve();}};
}

test('a new window waits for its own item tree before registering selection',async()=>{
  const h=harness();h.api.attach(h.win);await h.flush();assert.equal(h.timers.size,1);
  const panel=h.api.panels.get(h.win);assert.equal(panel.synced,0);
  const listeners=new Set<()=>void>();h.win.ZoteroPane.itemsView={onSelect:{addListener:(fn:()=>void)=>listeners.add(fn),removeListener:(fn:()=>void)=>listeners.delete(fn)}};
  const callback=[...h.timers.values()][0];h.timers.clear();callback();assert.equal(listeners.size,1);assert.equal(panel.synced,1);
  [...listeners][0]();assert.equal(panel.synced,2);h.api.detach(h.win);assert.equal(listeners.size,0);
});

test('closing a window before its item tree is ready cancels registration',async()=>{
  const h=harness();h.api.attach(h.win);await h.flush();const callback=[...h.timers.values()][0];h.api.detach(h.win);
  assert.equal(h.timers.size,0);callback();assert.equal(h.timers.size,0);assert.equal(h.api.panels.size,0);
});
