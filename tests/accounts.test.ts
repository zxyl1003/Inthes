import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { newProfile } from '../src/types.ts';

const bundle=await build({entryPoints:['src/accounts.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const npmDir=String.raw`C:\Users\reader\AppData\Roaming\npm`;
const node=String.raw`D:\nodejs\node.exe`;
function detector(files:Record<string,unknown>, commands:Record<string,string>, isWin=true,env:Record<string,string>={},now=Date.now) {
  const paths=isWin?path.win32:path.posix;
  const module={exports:{} as any},launches:any[]=[];
  let childProcess:any;
  runInNewContext(bundle.outputFiles[0].text,{
    module,exports:module.exports,Date:class extends Date { static now(){return now();} },
    URL,crypto,TextEncoder,ChromeUtils:{importESModule:()=>({setTimeout,clearTimeout,Subprocess:{ERROR_BAD_EXECUTABLE:1,call:async(options:any)=>{launches.push(options);if(childProcess)return childProcess;throw Error('spawn captured');},pathSearch:async(command:string)=>{
      if(commands[command])return commands[command];
      throw Object.assign(new Error('Executable not found'),{errorCode:1});
    }}})},
    PathUtils:{isAbsolute:paths.isAbsolute,join:paths.join,parent:paths.dirname,filename:paths.basename},
    IOUtils:{exists:async(p:string)=>Object.hasOwn(files,p),readJSON:async(p:string)=>files[p],readUTF8:async(p:string)=>files[p],makeDirectory:async()=>{}},
    Services:{env:{get:(name:string)=>env[name]??(isWin&&name==='APPDATA'?paths.dirname(npmDir):'')},dirsvc:{get:()=>({path:isWin?String.raw`C:\Users\reader`:'/home/reader'})}},Ci:{nsIFile:{}},
    Zotero:{isWin,isMac:false,debug:()=>{}}
  });
  return Object.assign(new module.exports.Accounts({},{}),{launches,setProcess:(process:any)=>{childProcess=process;}});
}
function npmFiles() {
  const cli='codex',entry='bin/codex.js';
  const dir=path.win32.join(npmDir,'node_modules','@openai','codex');
  const script=path.win32.join(dir,entry);
  return {script,files:{
    [path.win32.join(npmDir,cli)]:true,
    [path.win32.join(npmDir,`${cli}.cmd`)]:true,
    [path.win32.join(npmDir,`${cli}.ps1`)]:true,
    [path.win32.join(dir,'package.json')]:{bin:{[cli]:entry}},
    [script]:true,[node]:true
  }};
}

test('Windows npm Codex shims resolve to Node and the package entry, retaining arguments',async()=>{
  const {script,files}=npmFiles();
  for(const suffix of ['', '.cmd', '.ps1']) {
    const shim=path.win32.join(npmDir,`codex${suffix}`);
    const p={...newProfile('codex-account'),executable:shim,args:'["--debug"]'};
    const runtime=await detector(files,{'node.exe':node}).detectRuntime(p);
    assert.equal(runtime.executable,node);
    assert.deepEqual(JSON.parse(runtime.args),[script,'--debug']);
  }
});
test('Codex npm installation is found without npm on the application PATH',async()=>{
  const {script,files}=npmFiles();
  const runtime=await detector(files,{'node.exe':node}).detectRuntime(newProfile('codex-account'));
  assert.equal(runtime.executable,node);
  assert.deepEqual(JSON.parse(runtime.args),[script]);
});
test('manual Node configuration is preserved; redetection finds the npm installation',async()=>{
  const {script,files}=npmFiles();
  const p={...newProfile('codex-account'),executable:node,args:'["D:\\\\tools\\\\codex.js"]'};
  const accounts=detector(files,{'node.exe':node});
  const manual=await accounts.detectRuntime(p);
  assert.equal(manual.executable,node);assert.equal(manual.args,p.args);
  const detected=await accounts.detectRuntime(p,true);
  assert.deepEqual(JSON.parse(detected.args),[script]);
});
test('Unix Codex launchers are kept executable directly',async()=>{
  const launcher='/usr/local/bin/codex';
  const runtime=await detector({[launcher]:true},{codex:launcher},false).detectRuntime(newProfile('codex-account'));
  assert.equal(runtime.executable,launcher);assert.equal(runtime.args,'[]');
});
test('Codex launch imports only dotenv proxies and keeps Folio account isolation',async()=>{
  const file=String.raw`C:\Users\reader\.codex\.env`,executable=String.raw`C:\codex.exe`;
  const accounts=detector({[file]:`\uFEFF# network\r\nexport HTTP_PROXY="http://127.0.0.1:7890" # local\r\nhttps_proxy='http://user:pass#word@127.0.0.1:7890'\r\nALL_PROXY=socks5://127.0.0.1:7891 # fallback\r\nNO_PROXY=\r\nOPENAI_API_KEY=do-not-import\r\nCODEX_HOME=other\r\nPATH=other`,[executable]:true},{});
  accounts.storage.dir=String.raw`C:\folio`;
  const profile={...newProfile('codex-account'),executable,args:'[]'};
  await assert.rejects(accounts.client(profile),/spawn captured/);
  const options=accounts.launches[0],e=options.environment;
  assert.equal(e.HTTP_PROXY,'http://127.0.0.1:7890');assert.equal(e.HTTPS_PROXY,'http://user:pass#word@127.0.0.1:7890');
  assert.equal(e.ALL_PROXY,'socks5://127.0.0.1:7891');assert.equal(e.NO_PROXY,'');
  for(const key of ['HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY'])assert.equal(e[key.toLowerCase()],e[key]);
  assert.equal(e.OPENAI_API_KEY,null);assert.equal(e.CODEX_HOME,path.win32.join(accounts.storage.dir,'accounts',profile.id));
  assert.equal(e.PATH,undefined);assert.equal(options.environmentAppend,true);
});
test('proxy dotenv uses the parent CODEX_HOME, and a missing file leaves inherited networking intact',async()=>{
  const accounts=detector({'/custom/codex/.env':'HTTPS_PROXY=http://localhost:8080\nNO_PROXY=localhost,127.0.0.1'}, {},false,{CODEX_HOME:'/custom/codex'});
  assert.equal((await accounts.proxyEnvironment()).HTTPS_PROXY,'http://localhost:8080');
  assert.equal((await accounts.proxyEnvironment()).NO_PROXY,'localhost,127.0.0.1');
  assert.equal(Object.keys(await detector({}, {},false).proxyEnvironment()).length,0);
});
test('malformed proxy quotes fail without exposing credentials',async()=>{
  const accounts=detector({'/home/reader/.codex/.env':'HTTPS_PROXY="http://private:secret@localhost:7890'}, {},false);
  await assert.rejects(accounts.proxyEnvironment(),(error:Error)=>/HTTPS_PROXY/.test(error.message)&&!error.message.includes('secret'));
});
function accountHarness() {
  const accounts=detector({},{}),requests:any[]=[];let threadCount=0,turnCount=0;
  const rpc={closed:false,listeners:new Set<(method:string,params:any)=>void>(),toolHandlers:new Map<string,(params:any)=>Promise<any>>(),finish:true,
    async request(method:string,params:any):Promise<any>{
      requests.push({method,params});
      if(method==='account/read')return {account:{type:'chatgpt'}};
      if(method==='thread/resume')return {thread:{id:params.threadId},reasoningEffort:'medium',approvalPolicy:'never',sandbox:{type:'readOnly'}};
      if(method==='thread/start')return {thread:{id:`thread${++threadCount}`},reasoningEffort:'medium',approvalPolicy:'never',sandbox:{type:'readOnly'}};
      if(method==='turn/start'){
        const id=`turn${++turnCount}`;
        queueMicrotask(()=>{
          const emit=(method:string,params:any)=>{for(const fn of rpc.listeners)fn(method,params);};
          emit('turn/started',{threadId:params.threadId,turn:{id}});
          assert.notEqual(phases.at(-1),'thinking');
          emit('item/started',{threadId:params.threadId,turnId:id,item:{type:'reasoning'}});
          if(!rpc.finish)return;
          emit('item/reasoning/summaryTextDelta',{threadId:params.threadId,turnId:id,delta:'summary'});
          emit('item/agentMessage/delta',{threadId:params.threadId,turnId:id,delta:`answer ${turnCount}`});
          emit('thread/tokenUsage/updated',{threadId:params.threadId,turnId:id,tokenUsage:{last:{inputTokens:turnCount*100,outputTokens:20,totalTokens:turnCount*100+20},total:{totalTokens:99999},modelContextWindow:272000}});
          emit('turn/completed',{threadId:params.threadId,turn:{id,status:'completed'}});
        });
        return {turn:{id}};
      }
      return {};
    }
  };
  accounts.client=async()=>({rpc,cwd:'workspace'});
  const profile={...newProfile('codex-account'),model:'test'};
  const run=async(history:any[],query:string,evidence='original paper',compaction=0,p=profile,continuation:any={})=>{
    let answer='';const usage:any[]=[];
    await accounts.ask(p,{system:'read carefully',messages:[...history,{role:'user',content:`${query}\n${evidence}`}]},new AbortController().signal,(t:string)=>answer+=t,{onUsage:(u:any)=>usage.push(u),onPhase:(phase:string)=>phases.push(phase)},{id:'folio-session',query,evidence,compaction,...continuation});
    return {history:[...history,{role:'user',content:query},{role:'assistant',content:answer}],usage};
  };
  accounts.storage.state={profiles:[profile]};
  const phases:string[]=[];
  return {accounts,requests,rpc,profile,run,phases};
}

test('Codex reuses the synchronized displayed history but still rebuilds after actual edits',async()=>{
  const h=accountHarness(),first=await h.run([],'first');
  first.history.at(-1)!.content='Normalized answer [S1P1C1]';h.accounts.updateHistory('folio-session',first.history);
  const second=await h.run(first.history,'second');assert.equal(h.requests.filter(r=>r.method==='thread/start').length,1);
  second.history[0].content='Edited question';await h.run(second.history,'third');assert.equal(h.requests.filter(r=>r.method==='thread/start').length,2);
});

test('account quota refresh coalesces requests, retains real values on failure and drops late results after release',async()=>{
  const h=accountHarness();let resolve!:(value:any)=>void,started!:()=>void,count=0;
  let ready=new Promise<void>(r=>started=r);
  h.rpc.request=async()=>{count++;return new Promise(r=>{resolve=r;started();});};
  const first=h.accounts.refreshQuota(h.profile,true),same=h.accounts.refreshQuota(h.profile,true);
  assert.equal(first,same);await ready;resolve({rateLimits:{primary:{usedPercent:25,windowDurationMins:300}}});await first;
  assert.equal(h.accounts.quotas.get(h.profile.id).groups[0].windows[0].remaining,75);
  h.rpc.request=async()=>{count++;throw Error('offline');};await h.accounts.refreshQuota(h.profile,true);
  assert.equal(h.accounts.quotas.get(h.profile.id).groups[0].windows[0].remaining,75);assert.match(h.accounts.quotas.get(h.profile.id).error,/offline/);
  await h.accounts.refreshQuota(h.profile);assert.equal(count,2);
  ready=new Promise<void>(r=>started=r);h.rpc.request=async()=>new Promise(r=>{resolve=r;started();});const late=h.accounts.refreshQuota(h.profile,true);await ready;h.accounts.releaseProfile(h.profile.id);
  resolve({rateLimits:{primary:{usedPercent:0}}});await late;assert.equal(h.accounts.quotas.has(h.profile.id),false);
});
test('same conversation reuses Codex thread and sends only the new question',async()=>{
  const h=accountHarness();const first=await h.run([],'first');const second=await h.run(first.history,'second');
  assert.equal(h.requests.filter(r=>r.method==='thread/start').length,1);
  const turns=h.requests.filter(r=>r.method==='turn/start');assert.match(turns[0].params.input[0].text,/original paper/);assert.equal(turns[1].params.input.length,1);assert.equal(turns[1].params.input[0].text,'用户：second');
  assert.equal(second.usage[0].contextTokens,220);assert.equal(h.rpc.listeners.size,0);
  assert.deepEqual(h.phases,['connecting','thinking','thinking','answering','connecting','thinking','thinking','answering']);
  assert.ok(turns.every(r=>r.params.summary==='none'));
});

test('API balances refresh after one minute, retain failed readings, and discard replies from changed credentials',async()=>{
  let now=100000,key='first-key',count=0,fail=false,resolve!:(value:Response)=>void;
  const accounts=detector({}, {},true,{},()=>now),p=newProfile('deepseek');
  accounts.storage.getKey=()=>key;accounts.win.AbortController=AbortController;
  const reply=(value:string)=>Response.json({balance_infos:[{currency:'CNY',total_balance:value,topped_up_balance:value,granted_balance:'0'}]});
  accounts.win.fetch=async()=>{count++;if(fail)throw Error('offline');return reply('12');};
  await accounts.refreshQuota(p);await accounts.refreshQuota(p);assert.equal(count,1);
  now+=60001;await accounts.refreshQuota(p);assert.equal(count,2);
  fail=true;now+=60001;await accounts.refreshQuota(p);
  assert.equal(accounts.quotas.get(p.id).balance.values[0].remaining,12);assert.match(accounts.quotas.get(p.id).error,/offline/);
  let oldSignal:AbortSignal;
  accounts.win.fetch=async(_url:string,init:RequestInit)=>{oldSignal=init.signal!;return new Promise(r=>resolve=r);};
  const old=accounts.refreshQuota(p,true);
  key='new-key';accounts.win.fetch=async()=>reply('25');await accounts.refreshQuota(p);
  assert.equal(oldSignal!.aborted,true);assert.equal(accounts.quotas.get(p.id).balance.values[0].remaining,25);
  resolve(reply('999'));await old;assert.equal(accounts.quotas.get(p.id).balance.values[0].remaining,25);
});

test('unsupported balance queries publish a notice and do not keep requesting a forbidden endpoint',async()=>{
  let now=100000,count=0;const accounts=detector({}, {},true,{},()=>now);
  accounts.storage.getKey=()=> 'key';accounts.win.AbortController=AbortController;
  accounts.win.fetch=async()=>{count++;return Response.json({}, {status:403});};
  const p=newProfile('openrouter');await accounts.refreshQuota(p);
  assert.match(accounts.quotas.get(p.id).notice,/无余额查询权限/);
  now+=60001;await accounts.refreshQuota(p);assert.equal(count,1);
  const unsupported={...newProfile('custom'),baseURL:'https://example.com/v1'};await accounts.refreshQuota(unsupported);
  assert.match(accounts.quotas.get(unsupported.id).notice,/未配置/);assert.equal(count,1);
});

test('paper discovery tracks native search completion separately from progress and other actions',async()=>{
  const h=accountHarness(),searches:string[]=[];let completed=0;
  const original=h.rpc.request.bind(h.rpc);
  h.rpc.request=async(method:string,params:any)=>{
    if(method==='turn/start')queueMicrotask(()=>{
      const emit=(method:string,item:any,threadId=params.threadId)=>{for(const listener of h.rpc.listeners)listener(method,{threadId,item});};
      emit('item/started',{type:'webSearch',query:'visual geolocation papers'});assert.equal(completed,0);
      emit('item/completed',{type:'webSearch',action:{type:'search'}},'foreign-thread');
      emit('item/completed',{type:'webSearch',action:{type:'openPage'}});assert.equal(completed,0);
      emit('item/completed',{type:'webSearch',action:{type:'search'}});
    });
    return original(method,params);
  };
  await h.accounts.ask(h.profile,{system:'Find papers',messages:[{role:'user',content:'Search'}]},new AbortController().signal,()=>{},{onSearch:(q:string)=>searches.push(q),onSearchCompleted:()=>completed++},undefined,{webSearch:true,definitions:[],execute:async()=>({text:''})});
  assert.equal(h.requests.find(r=>r.method==='thread/start').params.config.web_search,'live');
  assert.deepEqual(searches,['visual geolocation papers']);assert.equal(completed,1);
  h.rpc.request=original;h.requests.length=0;await h.run([],'read a local paper');
  assert.equal(h.requests.find(r=>r.method==='thread/start').params.config.web_search,'disabled');
});

test('document figures enter a Codex conversation once and are reintroduced after compaction',async()=>{
  const h=accountHarness(),figure={data:'YWJj',mimeType:'image/jpeg',width:100,height:100};let history:any[]=[];
  for(const compaction of [0,0,1]){
    const query=`question ${history.length}`;let answer='';
    await h.accounts.ask(h.profile,{system:'read carefully',messages:[...history,{role:'user',content:query+' paper',images:[figure]}]},new AbortController().signal,(t:string)=>answer+=t,{onPhase:(phase:string)=>h.phases.push(phase)},{id:'figures',query,evidence:'paper',compaction,figureCount:1});
    history.push({role:'user',content:query},{role:'assistant',content:answer});
  }
  assert.equal(h.requests.filter(r=>r.method==='thread/start').length,2);
  const turns=h.requests.filter(r=>r.method==='turn/start');assert.deepEqual(turns.map(r=>r.params.input.filter((i:any)=>i.type==='image').length),[1,0,1]);
});

test('generated image recovery runs only for a new account thread, not reused turns',async()=>{
  const h=accountHarness();let history:any[]=[],restores=0;
  for(const [compaction,model] of [[0,'test'],[0,'test'],[1,'test'],[1,'other']] as const){
    const query=`question ${history.length}`,input={system:'read carefully',messages:[...history,{role:'user',content:query+' paper'}]};let answer='';
    await h.accounts.ask({...h.profile,model},input,new AbortController().signal,(t:string)=>answer+=t,{onPhase:(phase:string)=>h.phases.push(phase)},{id:'restored',query,evidence:'paper',compaction,restoreInput:async()=>{restores++;return {...input,messages:[{role:'user',content:'Previous generated image',images:[{data:'YWJj',mimeType:'image/png',width:1,height:1}]},...input.messages]};}});
    history.push({role:'user',content:query},{role:'assistant',content:answer});
  }
  assert.equal(restores,3);assert.deepEqual(h.requests.filter(r=>r.method==='turn/start').map(r=>r.params.input.filter((i:any)=>i.type==='image').length),[1,0,1,1]);
});
test('evidence, model, compacted history and runtime changes rebuild a clean account context',async()=>{
  const h=accountHarness();let result=await h.run([],'first');
  result=await h.run(result.history,'second','changed paper');
  result=await h.run(result.history,'third','changed paper',0,{...h.profile,model:'other'});
  result=await h.run([{role:'user',content:'compact summary'}],'fourth','changed paper',1,{...h.profile,model:'other'});
  assert.equal(h.requests.filter(r=>r.method==='thread/start').length,4);
  assert.equal(h.requests.filter(r=>r.method==='thread/unsubscribe').length,3);
  const last=h.requests.filter(r=>r.method==='turn/start').at(-1).params.input;assert.equal(last.length,2);assert.match(last[0].text,/compact summary/);assert.ok(!JSON.stringify(last).includes('first'));
});
test('effort changes reuse thread and switching back to default restores model default',async()=>{
  const h=accountHarness();let result=await h.run([],'first');
  result=await h.run(result.history,'second','original paper',0,{...h.profile,reasoning:'high'});
  await h.run(result.history,'third');
  assert.equal(h.requests.filter(r=>r.method==='thread/start').length,1);
  assert.deepEqual(h.requests.filter(r=>r.method==='turn/start').map(r=>r.params.effort),['medium','high','medium']);
});
test('cancellation interrupts only the active turn and discards its context before retry',async()=>{
  const h=accountHarness();const first=await h.run([],'first');h.rpc.finish=false;const control=new AbortController();
  await assert.rejects(h.accounts.ask(h.profile,{system:'read carefully',messages:[...first.history,{role:'user',content:'cancel\noriginal paper'}]},control.signal,()=>{},{onPhase:(phase:string)=>{if(phase==='thinking')control.abort();}},{id:'folio-session',query:'cancel',evidence:'original paper',compaction:0}),/生成已停止/);
  assert.equal(h.accounts.threads.size,0);assert.equal(h.rpc.closed,false);assert.equal(h.rpc.listeners.size,0);assert.ok(h.requests.some(r=>r.method==='turn/interrupt'));
  h.rpc.finish=true;await h.run(first.history,'retry');assert.equal(h.requests.filter(r=>r.method==='thread/start').length,2);
});

test('stopping during account initialization returns before startup finishes and sends no question',async()=>{
  const h=accountHarness();let release!:(value:any)=>void;h.accounts.client=()=>new Promise(r=>release=r);const control=new AbortController();
  const work=h.accounts.ask(h.profile,{system:'read',messages:[{role:'user',content:'question'}]},control.signal,()=>{throw Error('Late output');});
  control.abort();await assert.rejects(work,/abort/i);release({rpc:h.rpc,cwd:'workspace'});await new Promise(r=>setImmediate(r));assert.equal(h.requests.length,0);assert.equal(h.accounts.threads.size,0);
});
test('stopping during thread creation releases a late thread without beginning a turn',async()=>{
  const h=accountHarness();let release!:(value:any)=>void;const request=h.rpc.request.bind(h.rpc);
  h.rpc.request=async(method,params)=>method==='thread/start'?new Promise(r=>release=r):request(method,params);
  const control=new AbortController();const work=h.accounts.ask(h.profile,{system:'read',messages:[{role:'user',content:'question'}]},control.signal,()=>{});
  while(!release)await new Promise(r=>setImmediate(r));control.abort();await assert.rejects(work,/abort/i);release({thread:{id:'late'}});await new Promise(r=>setImmediate(r));
  assert.ok(h.requests.some(r=>r.method==='thread/unsubscribe'&&r.params.threadId==='late'));assert.ok(!h.requests.some(r=>r.method==='turn/start'));assert.equal(h.accounts.threads.size,0);
});
test('logout invokes the official account operation and releases only its own process and cached context',async()=>{
  const h=accountHarness();await h.run([],'first');let closed=0;(h.rpc as any).close=()=>{closed++;h.rpc.closed=true;};
  h.accounts.clients.set(h.profile.id,{rpc:h.rpc});h.accounts.models.set(h.profile.id,[{id:'test',name:'Test'}]);h.accounts.models.set('other',[{id:'other',name:'Other'}]);
  await h.accounts.logout(h.profile);assert.ok(h.requests.some(r=>r.method==='account/logout'));assert.equal(closed,1);assert.equal(h.accounts.threads.size,0);assert.equal(h.accounts.clients.size,0);assert.equal(h.accounts.models.has(h.profile.id),false);assert.equal(h.accounts.models.has('other'),true);assert.equal(h.accounts.statuses.get(h.profile.id).phase,'signed-out');
});

test('account library tools are bound to their active thread and retain reuse without granting built-in tools',async()=>{
  const h=accountHarness();const request=h.rpc.request.bind(h.rpc);let executed=0;
  h.rpc.request=async(method,params)=>{
    if(method!=='turn/start')return request(method,params);
    const id='library-turn';
    queueMicrotask(async()=>{
      const emit=(method:string,value:any)=>{for(const listener of h.rpc.listeners)listener(method,value);};
      emit('turn/started',{threadId:params.threadId,turn:{id}});
      const handler=h.rpc.toolHandlers.get(params.threadId)!;
      await assert.rejects(handler({threadId:params.threadId,turnId:'another',tool:'search_library',arguments:{},namespace:null}),/不允许/);
      const result=await handler({threadId:params.threadId,turnId:id,callId:'call1',tool:'search_library',arguments:{query:'test'},namespace:null});
      assert.equal(result.text,'evidence');
      emit('item/agentMessage/delta',{threadId:params.threadId,turnId:id,delta:'answer'});
      emit('turn/completed',{threadId:params.threadId,turn:{id,status:'completed'}});
    });
    return {turn:{id}};
  };
  const tools={definitions:[{name:'search_library',description:'Search selected scope',parameters:{type:'object'}}],execute:async()=>{executed++;return {text:'evidence'};}};
  await h.accounts.ask(h.profile,{system:'library',messages:[{role:'user',content:'question'}]},new AbortController().signal,()=>{},{},{id:'scope',query:'question',evidence:'fixed',compaction:0},tools);
  assert.equal(executed,1);assert.equal(h.rpc.toolHandlers.size,0);
  const start=h.requests.find(r=>r.method==='thread/start').params;assert.equal(start.dynamicTools[0].name,'search_library');assert.equal(start.dynamicTools[0].type,'function');assert.equal(start.sandbox,'read-only');assert.equal(start.config['features.shell_tool'],false);
});

test('Antigravity logout retains account caches until official exit is confirmed',async()=>{
  const h=accountHarness(),p=newProfile('antigravity-account');let confirmed=false;
  h.accounts.antigravity.logout=async()=>confirmed;
  h.accounts.models.set(p.id,[{id:'test'}]);h.accounts.quotas.set(p.id,{groups:[]});
  assert.equal(await h.accounts.logout(p),false);assert.equal(h.accounts.models.has(p.id),true);assert.equal(h.accounts.quotas.has(p.id),true);
  confirmed=true;assert.equal(await h.accounts.logout(p),true);assert.equal(h.accounts.models.has(p.id),false);assert.equal(h.accounts.quotas.has(p.id),false);
});

test('image-only turns await image handling, ignore duplicate and foreign images, and reuse the conversation',async()=>{
  const h=accountHarness(),request=h.rpc.request.bind(h.rpc),received:string[]=[];let deliver!:(method:string,params:any)=>void,release!:()=>void;
  const decoding=new Promise<void>(r=>release=r);
  h.rpc.request=async(method,params)=>{
    if(method!=='turn/start')return request(method,params);
    deliver=(method,value)=>{for(const listener of h.rpc.listeners)listener(method,{threadId:params.threadId,turnId:'image-turn',...value});};
    queueMicrotask(()=>{deliver('turn/started',{turn:{id:'image-turn'}});deliver('item/started',{item:{type:'imageGeneration',id:'image'}});deliver('item/completed',{threadId:'foreign',item:{type:'imageGeneration',id:'other',status:'completed',result:'foreign'}});for(let i=0;i<2;i++)deliver('item/completed',{item:{type:'imageGeneration',id:'image',status:'completed',result:'png-data'}});deliver('turn/completed',{turn:{id:'image-turn',status:'completed'}});});
    return {turn:{id:'image-turn'}};
  };
  let text='',finished=false;
  const work=h.accounts.ask(h.profile,{system:'read',messages:[{role:'user',content:'Draw a figure'}]},new AbortController().signal,(t:string)=>text+=t,{onImage:async(data:string)=>{received.push(data);await decoding;},onPhase:(p:string)=>h.phases.push(p)},{id:'image-session',query:'Draw a figure',evidence:'paper',compaction:0}).then(()=>finished=true);
  await new Promise(r=>setImmediate(r));assert.deepEqual(received,['png-data']);assert.equal(finished,false);assert.ok(h.phases.includes('imaging'));
  release();await work;assert.equal(text,'已生成图片。');assert.equal(h.accounts.threads.size,1);assert.equal(h.rpc.listeners.size,0);
  assert.deepEqual(JSON.parse(h.accounts.threads.get('image-session').history),[{role:'user',content:'Draw a figure'},{role:'assistant',content:'已生成图片。'}]);
});

test('completed agent messages fill missing text without duplicating streamed text',async()=>{
  const h=accountHarness(),request=h.rpc.request.bind(h.rpc);let text='';
  h.rpc.request=async(method,params)=>{
    if(method!=='turn/start')return request(method,params);
    queueMicrotask(()=>{const emit=(method:string,value:any)=>{for(const listener of h.rpc.listeners)listener(method,{threadId:params.threadId,turnId:'turn',...value});};emit('turn/started',{turn:{id:'turn'}});emit('item/agentMessage/delta',{itemId:'text',delta:'Image '});emit('item/completed',{item:{type:'agentMessage',id:'text',text:'Image ready.'}});emit('item/completed',{item:{type:'agentMessage',id:'text',text:'Image ready.'}});emit('turn/completed',{turn:{id:'turn',status:'completed'}});});
    return {turn:{id:'turn'}};
  };
  await h.accounts.ask(h.profile,{system:'read',messages:[{role:'user',content:'Draw'}]},new AbortController().signal,(t:string)=>text+=t);assert.equal(text,'Image ready.');
});

test('image errors remain visible and cancellation does not wait for image decoding',async()=>{
  for(const kind of ['failed','decode','cancel']){
    const h=accountHarness(),request=h.rpc.request.bind(h.rpc),control=new AbortController();let release!:()=>void,decoding=false;
    h.rpc.request=async(method,params)=>{
      if(method!=='turn/start')return request(method,params);
      queueMicrotask(()=>{const emit=(method:string,value:any)=>{for(const listener of h.rpc.listeners)listener(method,{threadId:params.threadId,turnId:'turn',...value});};emit('turn/started',{turn:{id:'turn'}});emit('item/completed',{item:{type:'imageGeneration',id:'image',status:kind==='failed'?'failed':'completed',result:kind==='failed'?'':'png-data'}});emit('turn/completed',{turn:{id:'turn',status:'completed'}});});
      return {turn:{id:'turn'}};
    };
    const work=h.accounts.ask(h.profile,{system:'read',messages:[{role:'user',content:'Draw'}]},control.signal,()=>{}, {onImage:async()=>{if(kind==='decode')throw Error('Invalid PNG');decoding=true;await new Promise<void>(r=>release=r);}});
    if(kind==='cancel'){while(!decoding)await new Promise(r=>setImmediate(r));control.abort();}
    await assert.rejects(work,kind==='failed'?/图片生成未完成/:kind==='decode'?/Invalid PNG/:/停止/);release?.();await new Promise(r=>setImmediate(r));assert.equal(h.rpc.listeners.size,0);assert.equal(h.accounts.threads.size,0);
  }
});

test('RPC protocol and stdin failures close the subprocess once without persisting raw stdout',async()=>{
  for(const mode of ['malformed','stdin','timeout']){
    const accounts=detector({[node]:true},{});accounts.storage.dir=String.raw`C:\profile\folio`;
    accounts.win={setTimeout:()=>{throw Error('Destroyed window timer');},clearTimeout:()=>{throw Error('Destroyed window timer');}};
    let read!: (text:string)=>void,kills=0;
    const child={stdout:{readString:()=>new Promise<string>(r=>read=r)},stderr:{readString:async()=>''},stdin:{write:async(line:string)=>{
      const message=JSON.parse(line);
      if(message.method==='initialize')read(JSON.stringify({id:message.id,result:{}})+'\n');
      if(message.method==='pending'&&mode==='stdin')throw Error('Broken pipe');
    }},kill:()=>{kills++;read('');}};
    accounts.setProcess(child);
    const {rpc}=await accounts.client({...newProfile('codex-account'),executable:node,args:'[]'});
    const work=rpc.request('pending',{},mode==='timeout'?5:1000);
    if(mode==='malformed')read('private-output secret-token not JSON\n');
    await assert.rejects(work,(error:Error)=>{assert.doesNotMatch(error.message,/private-output|secret-token|Destroyed/);return true;});
    if(mode!=='timeout')assert.equal(kills,1);
    rpc.close();rpc.close();assert.equal(kills,1);assert.equal(rpc.pending.size,0);
  }
});

test('terminal account error and closed thread settle immediately, but retryable and foreign errors do not',async()=>{
  for(const terminal of ['error','thread/closed']){
    const h=accountHarness();h.rpc.finish=false;let done=false;
    const work=h.run([],'question').finally(()=>done=true);
    while(!h.requests.some(r=>r.method==='turn/start'))await new Promise(r=>setImmediate(r));
    const emit=(method:string,params:any)=>{for(const listener of h.rpc.listeners)listener(method,params);};
    emit('error',{threadId:'foreign',turnId:'turn1',willRetry:false,error:{message:'Foreign error'}});
    emit('error',{threadId:'thread1',turnId:'turn1',willRetry:true,error:{message:'Retrying'}});
    await Promise.resolve();assert.equal(done,false);
    emit(terminal,{threadId:'thread1',turnId:'turn1',willRetry:false,error:{message:'Terminal failure'}});
    await assert.rejects(work,terminal==='error'?/Terminal failure/:/会话已关闭/);assert.equal(h.rpc.listeners.size,0);
  }
});

test('forgetting a busy conversation defers unsubscribe until its active turn settles',async()=>{
  const h=accountHarness();h.rpc.finish=false;const control=new AbortController();
  const work=h.accounts.ask(h.profile,{system:'read',messages:[{role:'user',content:'q'}]},control.signal,()=>{},{},{id:'busy',query:'q',evidence:'paper',compaction:0});
  while(!h.requests.some(r=>r.method==='turn/start'))await new Promise(r=>setImmediate(r));
  h.accounts.forgetSession('busy');assert.equal(h.requests.filter(r=>r.method==='thread/unsubscribe').length,0);
  control.abort();await assert.rejects(work);assert.equal(h.requests.filter(r=>r.method==='thread/unsubscribe').length,1);
});

test('model list rejects repeated cursors and malformed pages without caching partial results',async()=>{
  for(const malformed of [false,true]){
    const h=accountHarness(),request=h.rpc.request.bind(h.rpc);let pages=0;
    h.rpc.request=async(method,params)=>method==='model/list'?(pages++,{data:malformed?{}:[{model:'m'}],nextCursor:'same'}):request(method,params);
    await assert.rejects(h.accounts.listModels(h.profile),/模型列表|分页异常/);assert.equal(pages,malformed?1:2);assert.equal(h.accounts.models.size,0);
  }
});

test('unsafe login URLs and ineffective account sandbox settings never receive user input',async()=>{
  for(const authUrl of ['file:///private','custom:run','https://auth.openai.com.evil.test/login','https://user:pass@auth.openai.com/login']){
    const h=accountHarness();h.rpc.request=async(method)=>method==='account/read'?{account:null}:{authUrl};
    await assert.rejects(h.accounts.connect(h.profile,true),/非官方登录地址/);
  }
  const h=accountHarness(),request=h.rpc.request.bind(h.rpc);
  h.rpc.request=async(method,params)=>method==='thread/start'?{thread:{id:'unsafe'},sandbox:{type:'dangerFullAccess'},approvalPolicy:'never'}:request(method,params);
  await assert.rejects(h.run([],'private paper'),/只读权限/);assert.ok(!h.requests.some(r=>r.method==='turn/start'));assert.ok(h.requests.some(r=>r.method==='thread/unsubscribe'));
});


test('saved Codex threads resume after runtime release without replaying papers or history',async()=>{
  const h=accountHarness(),checkpoints:any[]=[];
  const settings={persistent:true,beforeTurn:async(c:any)=>checkpoints.push(c)};
  const first=await h.run([],'first',undefined,undefined,undefined,settings);
  const saved=await h.accounts.continuation('folio-session');
  assert.equal(saved.protocol,'codex-account');assert.match(saved.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(checkpoints[0].pending,true);assert.equal(h.requests.find(r=>r.method==='thread/start').params.ephemeral,false);
  h.accounts.forgetSession('folio-session');
  const second=await h.run(first.history,'second',undefined,undefined,undefined,{...settings,saved,restoreInput:async()=>{throw Error('must not replay images');}});
  assert.ok(h.phases.includes('restoring'));
  assert.equal(h.requests.filter(r=>r.method==='thread/start').length,1);
  assert.equal(h.requests.find(r=>r.method==='thread/resume').params.threadId,saved.id);
  const last=h.requests.filter(r=>r.method==='turn/start').at(-1).params;
  assert.equal(last.threadId,saved.id);assert.doesNotMatch(JSON.stringify(last.input),/original paper|first/);
  assert.match(JSON.stringify(last.input),/second/);
  assert.notEqual((await h.accounts.continuation('folio-session')).fingerprint,saved.fingerprint);
  assert.equal(second.usage[0].inputTokens,200);
});

test('pending checkpoints, model changes and compaction rebuild instead of resuming stale native state',async()=>{
  for(const change of ['pending','model','compaction','history']){
    const h=accountHarness(),first=await h.run([],'first',undefined,undefined,undefined,{persistent:true});
    const saved=await h.accounts.continuation('folio-session');h.accounts.forgetSession('folio-session');
    if(change==='pending')saved.pending=true;
    if(change==='history')first.history[0].content='edited';
    await h.run(first.history,'next',undefined,change==='compaction'?1:0,change==='model'?{...h.profile,model:'changed'}:h.profile,{persistent:true,saved});
    assert.equal(h.requests.filter(r=>r.method==='thread/resume').length,0);
    assert.equal(h.requests.filter(r=>r.method==='thread/start').length,2);
    assert.equal(h.requests.find(r=>r.method==='thread/delete').params.threadId,saved.id);
    assert.match(JSON.stringify(h.requests.filter(r=>r.method==='turn/start').at(-1).params.input),/original paper/);
  }
});

test('missing Codex native records report recovery failure and invalidate only the saved checkpoint',async()=>{
  const h=accountHarness(),first=await h.run([],'first',undefined,undefined,undefined,{persistent:true});
  const saved=await h.accounts.continuation('folio-session');h.accounts.forgetSession('folio-session');
  const request=h.rpc.request.bind(h.rpc);h.rpc.request=async(method:string,params:any)=>{if(method==='thread/resume')throw Error('no rollout found for thread');return request(method,params);};
  let cleared=false;
  await assert.rejects(h.run(first.history,'next',undefined,undefined,undefined,{saved,persistent:true,beforeTurn:async(c:any)=>{cleared=c===undefined;}}),/记录已丢失/);
  assert.equal(cleared,true);assert.equal(h.requests.filter(r=>r.method==='turn/start').length,1);
});

test('already deleted or unremovable native records do not trap a conversation in its pending checkpoint',async()=>{
  for(const message of ['thread not found','permission denied']){
    const h=accountHarness(),first=await h.run([],'first',undefined,undefined,undefined,{persistent:true});
    const saved={...await h.accounts.continuation('folio-session'),pending:true};h.accounts.forgetSession('folio-session');
    const original=h.rpc.request.bind(h.rpc),checkpoints:any[]=[],warnings:string[]=[];
    h.rpc.request=async(method:string,params:any)=>{if(method==='thread/delete'){assert.equal(checkpoints[0],undefined);throw Error(message);}return original(method,params);};
    await h.accounts.ask(h.profile,{system:'read carefully',messages:[...first.history,{role:'user',content:'next'}]},new AbortController().signal,()=>{},{onPhase:(phase:string)=>h.phases.push(phase),onWarning:(warning:string)=>warnings.push(warning)},{id:'folio-session',query:'next',evidence:'original paper',compaction:0,saved,persistent:true,beforeTurn:async(c:any)=>checkpoints.push(c)});
    assert.equal(h.requests.filter(r=>r.method==='thread/start').length,2);assert.equal(checkpoints[0],undefined);assert.equal(checkpoints.at(-1).pending,true);
    if(message==='thread not found')assert.equal(warnings.length,0);
    else {assert.match(warnings[0],/permission denied/);assert.ok(warnings[0].includes(saved.id));}
  }
});

test('cleanup does not run a replacement provider executable as the old Codex component',async()=>{
  const h=accountHarness(),saved={protocol:'codex-account',profileID:h.profile.id,id:'old-thread',fingerprint:'a'.repeat(64)};
  h.accounts.storage.state.profiles=[{...h.profile,protocol:'antigravity-account',executable:'agy.exe'}];
  let launches=0;h.accounts.client=async()=>{launches++;throw Error('must not launch');};
  const warning=await h.accounts.cleanupContinuation(saved);
  assert.equal(launches,0);assert.match(warning,/旧组件记录未能清理/);assert.match(warning,/old-thread/);
});

test('a stalled old-record deletion does not delay the new Codex turn and reports failure afterward',async()=>{
  const h=accountHarness(),first=await h.run([],'first',undefined,undefined,undefined,{persistent:true});
  const saved={...await h.accounts.continuation('folio-session'),pending:true};h.accounts.forgetSession('folio-session');
  let fail!:(error:Error)=>void,report!:(warning:string)=>void;
  const warning=new Promise<string>(resolve=>report=resolve),request=h.rpc.request.bind(h.rpc);
  h.rpc.request=(method:string,params:any)=>method==='thread/delete'?new Promise((_resolve,reject)=>fail=reject):request(method,params);
  await h.accounts.ask(h.profile,{system:'read carefully',messages:[...first.history,{role:'user',content:'next'}]},new AbortController().signal,()=>{},{onPhase:(phase:string)=>h.phases.push(phase),onWarning:report},{id:'folio-session',query:'next',evidence:'original paper',compaction:0,saved,persistent:true});
  assert.equal(h.requests.filter(r=>r.method==='turn/start').length,2);
  fail(Error('cleanup timeout'));assert.match(await warning,/cleanup timeout/);
});
