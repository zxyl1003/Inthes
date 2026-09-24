import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { newProfile } from '../src/types.ts';
import { ResearchRun } from '../src/research.ts';

const bundle=await build({entryPoints:['src/antigravity.ts'],bundle:true,platform:'node',format:'cjs',write:false});
function pipe() {
  const queue:string[]=[];let pending:((s:string)=>void)|undefined,closed=false;
  return {readString:async()=>queue.length?queue.shift()!:closed?'':new Promise<string>(r=>pending=r),push(s:string){if(pending){const r=pending;pending=undefined;r(s);}else queue.push(s);},end(){closed=true;pending?.('');pending=undefined;}};
}
function harness() {
  const removed:string[]=[],removedPaths:string[]=[];const files=new Map<string,any>(),launches:any[]=[],endpoints:Record<string,any>={};let count=0;
  const accounts:any={storage:{dir:String.raw`C:\inthes`},win:{crypto:{randomUUID:()=>`id-${++count}`}},statuses:new Map(),models:new Map(),proxyEnvironment:async()=>({HTTPS_PROXY:'http://localhost:7890'}),setStatus(id:string,status:any){this.statuses.set(id,status);}};
  const module={exports:{} as any};
  let launched!:()=>void;const ready=new Promise<void>(r=>launched=r);
  const h={respond:async(process:any)=>process.reply('answer'),launchGate:undefined as Promise<void>|undefined};
  runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,Date,AbortController,crypto,TextEncoder,
    ChromeUtils:{importESModule:()=>({setTimeout,clearTimeout,Subprocess:{ERROR_BAD_EXECUTABLE:1,pathSearch:async()=>{throw Object.assign(Error('missing'),{errorCode:1});},call:async(options:any)=>{
      const stdout=pipe(),stderr=pipe(),inputs:string[]=[];
      const process={stdout,stderr,options,inputs,killed:false,graceful:false,stdin:{close:async()=>{process.graceful=true;process.kill();},write:async(s:string)=>{inputs.push(JSON.parse(s).message.content);await h.respond(process);}},kill(){this.killed=true;stdout.end();stderr.end();},wait:async()=>({exitCode:0}),reply(text:string){stdout.push(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',text_delta:text,usage:{input_tokens:20,cache_read_tokens:50,output_tokens:5}}})+'\n'+JSON.stringify({event:'result',result:{status:'SUCCESS',conversation_id:options.arguments.includes('--conversation')?options.arguments[options.arguments.indexOf('--conversation')+1]:'native-id',response:text,usage:{input_tokens:99999}}})+'\n');}};
      launches.push(process);launched();await h.launchGate;return process;
    }}})},
    Services:{dirsvc:{get:()=>({path:String.raw`C:\reader`})},env:{get:()=>String.raw`C:\Users\reader\AppData\Local`}},Ci:{nsIFile:{}},
    PathUtils:{join:path.win32.join,filename:path.win32.basename,isAbsolute:path.win32.isAbsolute},IOUtils:{exists:async()=>true,makeDirectory:async()=>{},remove:async(p:string)=>{removedPaths.push(p);p=p.replace(/^\\\\\?\\/,'');removed.push(p);assert.ok(p.startsWith(path.win32.join(accounts.storage.dir,'accounts')+path.win32.sep));assert.ok(p.includes('\\sessions\\'));},writeJSON:async(p:string,value:any)=>files.set(p,value)},
    Zotero:{isWin:true,Server:{init:async()=>{},port:23119,Endpoints:endpoints}}
  });
  const ag=new module.exports.Antigravity(accounts),profile={...newProfile('antigravity-account'),model:'gemini-test',reasoning:'low'};
  accounts.cleanupContinuation=(saved:any)=>ag.discardContinuation(saved);
  const run=async(history:any[],query:string,signal=new AbortController().signal,p=profile,tools?:any,continuation:any={})=>{
    let answer='',completed=0;const usages:any[]=[],searches:string[]=[],warnings:string[]=[];
    await ag.ask(p,{system:'Read sources',messages:[...history,{role:'user',content:query+'\nPAPER EVIDENCE'}]},signal,(text:string)=>answer+=text,{onUsage:(u:any)=>usages.push(u),onSearch:(query:string)=>searches.push(query),onSearchCompleted:()=>completed++,onWarning:(warning:string)=>warnings.push(warning)},{id:'session',query,evidence:'paper',compaction:0,...continuation},tools);
    return {history:[...history,{role:'user',content:query},{role:'assistant',content:answer}],usages,searches,completed,warnings};
  };
  return {ag,accounts,profile,run,launches,files,endpoints,h,ready,removed,exports:module.exports,removedPaths};
}

test('Antigravity reuses its stream, reports per-call tokens and isolates model switches',async()=>{
  const h=harness(),first=await h.run([],'first'),second=await h.run(first.history,'second');
  assert.equal(h.launches.length,1);assert.match(h.launches[0].inputs[0],/PAPER EVIDENCE/);assert.equal(h.launches[0].inputs[1],'second');
  assert.equal(second.usages[0].inputTokens,70);assert.equal(second.usages[0].totalTokens,75);
  await h.run(second.history,'third',undefined,{...h.profile,model:'other-model'});
  assert.equal(h.launches.length,2);assert.equal(h.launches[0].killed,true);assert.match(h.launches[1].inputs[0],/first/);
  const options=h.launches[1].options;assert.equal(options.environment.HTTPS_PROXY,'http://localhost:7890');assert.equal(options.environment.GEMINI_API_KEY,null);
  const settings=[...h.files.values()].find(v=>v.permissions);assert.ok(settings.permissions.deny.includes('command(*)'));assert.equal(settings.useG1Credits,false);
  h.ag.stop();assert.equal(h.launches[1].killed,true);
});
test('authorization code waits for confirmed login, including a fast completion or rejection',async()=>{
  for(const success of [true,false]){
    const h=harness();let finish!:(value:any)=>void,fail!:(e:Error)=>void,written='';
    const completion=new Promise((resolve,reject)=>{finish=resolve;fail=reject;});
    h.ag.connections.set(h.profile.id,completion);
    h.ag.logins.set(h.profile.id,{stdin:{write:async(code:string)=>{written=code;}}});
    let done=false;const work=h.ag.loginCode(h.profile.id,'test-code').then(()=>{done=true;});
    await Promise.resolve();assert.equal(done,false);assert.equal(written,'test-code\n');
    h.ag.connections.delete(h.profile.id);
    if(success){finish({phase:'signed-in'});await work;assert.equal(done,true);}
    else {fail(Error('Invalid code test-code'));await assert.rejects(work,e=>/Invalid code/.test(String(e))&&!String(e).includes('test-code'));}
  }
});

test('Antigravity removes only the new session home after setup cancellation or spawn failure',async()=>{
  for(const reason of ['abort','spawn']){
    const h=harness(),controller=new AbortController();
    if(reason==='abort'){const setup=h.ag.setup.bind(h.ag);h.ag.setup=async(home:string)=>{await setup(home);controller.abort();};}
    else h.ag.spawn=async()=>{throw Error('Launch failed');};
    await assert.rejects(h.run([],'question',controller.signal),/abort|Launch failed/i);
    assert.equal(h.removed.length,1);assert.match(h.removed[0],/\\sessions\\id-/);assert.equal(h.ag.threads.size,0);assert.equal(Object.keys(h.endpoints).length,0);
  }
});

test('Antigravity reuses normalized history but rebuilds for later user edits',async()=>{
  const h=harness();h.h.respond=async process=>process.reply('Evidence [S1P1P1]');
  const first=await h.run([],'first');first.history.at(-1)!.content='Evidence [S1P1C1]';h.ag.updateHistory('session',first.history);
  const second=await h.run(first.history,'second');assert.equal(h.launches.length,1);
  second.history[0].content='Edited question';await h.run(second.history,'third');assert.equal(h.launches.length,2);h.ag.stop();
});

test('Antigravity scopes web permissions to research and rebuilds on mode changes',async()=>{
  const h=harness(),tools={definitions:[{name:'resolve_research_papers',description:'Verify metadata',parameters:{type:'object',properties:{identifiers:{type:'array',items:{type:'string'}}},required:['identifiers']}}],execute:async()=>({text:''})};
  const reading=await h.run([],'read',undefined,h.profile,tools);
  const settings=()=>[...h.files.values()].filter(v=>v.permissions).at(-1);
  assert.ok(settings().permissions.deny.includes('read_url(*)'));
  assert.doesNotMatch(h.launches[0].inputs[0],/Use native search_web/);
  const research=await h.run(reading.history,'search',undefined,h.profile,{...tools,webSearch:true});
  assert.equal(h.launches.length,2);assert.equal(h.launches[0].killed,true);
  assert.ok(settings().permissions.allow.includes('read_url(*)'));
  assert.ok(!settings().permissions.deny.includes('read_url(*)'));
  for(const denied of ['read_file(*)','write_file(*)','command(*)','execute_url(*)'])assert.ok(settings().permissions.deny.includes(denied));
  assert.match(h.launches[1].inputs[0],/Use native search_web and read_url_content/);
  assert.ok(h.launches[1].inputs[0].includes(JSON.stringify(tools.definitions)));
  await h.run(research.history,'read again',undefined,h.profile,tools);
  assert.equal(h.launches.length,3);assert.equal(h.launches[1].killed,true);
  assert.ok(settings().permissions.deny.includes('read_url(*)'));
  h.ag.stop();
});

test('Antigravity records successful native search completion separately from starts and failures',async()=>{
  const h=harness();
  h.h.respond=async process=>{
    for(const [state,tool_name,parameters] of [['ACTIVE','search_web',{query:'geolocation papers'}],['DONE','search_web',{query:'geolocation papers'}],['FAILED','search_web',{}],['DONE','read_url_content',{Url:'https://arxiv.org'}],['ACTIVE','search_web',{}]]) {
      process.stdout.push(JSON.stringify({event:'step_update',step_update:{step_type:'tool',state,tool_name,tool_info:{parameters}}})+'\n');
    }
    process.reply('results');
  };
  const result=await h.run([],'search',undefined,h.profile,{definitions:[],webSearch:true,execute:async()=>({text:''})});
  assert.deepEqual(result.searches,['geolocation papers']);assert.equal(result.completed,1);h.ag.stop();
});

test('research follow-ups reuse the process and endpoint but renew tool permissions each turn',async()=>{
  const h=harness(),target={id:3,libraryID:1,name:'测试',path:'我的文库 / 测试'},signal=new AbortController().signal;
  const services={collections:()=>[target],resolve:async()=>{throw Error('unused');},import:async()=>{throw Error('unexpected import');},progress:()=>{},error:(e:unknown)=>String(e)};
  const results:any[]=[];
  h.h.respond=async process=>{
    const server=[...h.files.values()].filter(v=>v.mcpServers).at(-1).mcpServers.inthes;
    const endpoint=new h.endpoints[new URL(server.serverUrl).pathname]();
    const response=await endpoint.init({headers:{authorization:server.headers.Authorization},data:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'find_import_collections',arguments:{query:'测试'}}}});
    results.push(JSON.parse(JSON.parse(response[2]).result.content[0].text));process.reply('results');
  };
  const first=await h.run([],'检索并导入测试分类',signal,h.profile,new ResearchRun(signal,services,3,true));
  first.history.at(-1)!.content+='\n\n---\n**实际导入结果**\n\n新增 1';
  h.ag.updateHistory('session',first.history);
  const second=await h.run(first.history,'继续查找论文，不要导入',signal,h.profile,new ResearchRun(signal,services,3,true));
  assert.equal(h.launches.length,1);assert.equal(Object.keys(h.endpoints).length,1);
  assert.equal(results[0].collections[0].selected,true);assert.equal(results[1].collections[0].selected,true);
  assert.equal(h.launches[0].inputs[1],'继续查找论文，不要导入');
  second.history[0].content='edited question';
  await h.run(second.history,'new question',signal,h.profile,new ResearchRun(signal,services,3,true));
  assert.equal(h.launches.length,2);assert.equal(h.launches[0].killed,true);
  h.ag.forgetSession('session');assert.equal(h.launches[1].killed,true);assert.equal(Object.keys(h.endpoints).length,0);
});

test('Antigravity stop rejects a pending turn and removes the tool endpoint',async()=>{
  const h=harness(),controller=new AbortController();let started!:()=>void;const ready=new Promise<void>(r=>started=r);
  h.h.respond=async()=>{started();};
  const work=h.run([],'first',controller.signal,h.profile,{definitions:[],execute:async()=>({text:''})});
  await ready;assert.equal(Object.keys(h.endpoints).length,1);controller.abort();
  await assert.rejects(work,/停止|abort/i);assert.equal(h.launches[0].killed,true);assert.equal(Object.keys(h.endpoints).length,0);
});

test('Antigravity MCP requires its secret, rejects browser origins and propagates tool failures',async()=>{
  const h=harness();let calls=0;
  h.h.respond=async()=>{
    const config=[...h.files.values()].find(v=>v.mcpServers),server=config.mcpServers.inthes;
    const endpoint=new h.endpoints[new URL(server.serverUrl).pathname]();
    const data={jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'read_paper',arguments:{paper:1}}};
    const headers={authorization:server.headers.Authorization};
    assert.equal((await endpoint.init({headers:{},data}))[0],403);
    assert.equal((await endpoint.init({headers:{...headers,origin:'https://example.com'},data}))[0],403);assert.equal(calls,0);
    const response=await endpoint.init({headers,data});assert.equal(JSON.parse(response[2]).result.isError,true);
  };
  await assert.rejects(h.run([],'first',undefined,h.profile,{definitions:[{name:'read_paper',description:'Read',parameters:{type:'object'}}],execute:async()=>{calls++;throw Error('source read failed');}}),/source read failed/);
  assert.equal(calls,1);assert.equal(Object.keys(h.endpoints).length,0);
});

test('Antigravity declares text-only models and rejects images before launching',async()=>{
  const h=harness(),models=h.exports.antigravityModels('gemini-test\tGemini Test\nnotice');
  assert.equal(models.length,1);assert.equal(models[0].vision,false);
  await assert.rejects(h.ag.ask(h.profile,{system:'',messages:[{role:'user',content:'look',images:[{data:'test'}]}]},new AbortController().signal,()=>{},{}),/仅支持文字/);
  assert.equal(h.launches.length,0);
});

test('Antigravity logout guides interactive exit and verifies it without sending a prompt',async()=>{
  const h=harness(),commands:string[][]=[];let signedIn=true;
  h.ag.run=async(_p:any,args:string[])=>{commands.push(args);assert.deepEqual(Array.from(args),['models']);if(!signedIn)throw Error('Error: Please sign in to view available models. Launch the CLI without arguments to sign in.');return 'gemini-test\tGemini Test';};
  assert.equal(await h.ag.logout(h.profile),false);
  assert.equal(h.accounts.statuses.get(h.profile.id).phase,'signed-in');assert.equal(h.accounts.statuses.get(h.profile.id).logoutPending,true);
  assert.match(h.accounts.statuses.get(h.profile.id).text,/CLI.*\/logout/);
  signedIn=false;assert.equal(await h.ag.logout(h.profile),true);
  assert.equal(h.accounts.statuses.get(h.profile.id).phase,'signed-out');assert.equal(commands.length,2);
  h.accounts.statuses.set(h.profile.id,{phase:'pending'});assert.equal(await h.ag.logout(h.profile),true);assert.equal(commands.length,2);
});

test('Antigravity recognizes signed-out models without swallowing failures and permits login again',async()=>{
  const h=harness();let signedIn=false,loginCalls=0;
  h.ag.run=async(_p:any,args:string[],login:boolean)=>{if(login){loginCalls++;signedIn=true;return ''; }assert.deepEqual(Array.from(args),['models']);if(!signedIn)throw Error('Please sign in to view available models.');return 'gemini-test\tGemini Test';};
  assert.equal((await h.ag.connect(h.profile)).phase,'signed-out');
  assert.equal((await h.ag.connect(h.profile,true)).phase,'signed-in');assert.equal(loginCalls,1);
  h.ag.run=async()=>{throw Error('Network unavailable');};
  await assert.rejects(h.ag.logout(h.profile),/Network unavailable/);assert.equal(h.accounts.statuses.get(h.profile.id).phase,'error');
});

test('stopping Antigravity during process startup kills the late process without sending papers',async()=>{
  const h=harness();let resume!:()=>void;h.h.launchGate=new Promise<void>(r=>resume=r);
  const work=h.run([],'first',undefined,h.profile,{definitions:[],execute:async()=>({text:''})});
  await h.ready;h.ag.stop();resume();await assert.rejects(work,/连接已关闭/);
  assert.equal(h.launches[0].killed,true);assert.equal(h.launches[0].inputs.length,0);assert.equal(Object.keys(h.endpoints).length,0);
});


test('Antigravity restores its saved native conversation in a fresh process and renews MCP credentials',async()=>{
  const h=harness(),tools={definitions:[{name:'test_tool',parameters:{type:'object'}}],execute:async()=>({text:'ok'})},checkpoints:any[]=[];
  const options={persistent:true,beforeTurn:async(c:any)=>checkpoints.push(c)};
  const first=await h.run([],'first',undefined,undefined,tools,options);
  const saved=await h.ag.continuation('session');assert.equal(saved.id,'native-id');assert.equal(checkpoints[0].pending,true);
  const old=[...h.files.values()].find(v=>v.mcpServers).mcpServers.inthes;
  h.ag.forgetSession('session');await Promise.resolve();assert.equal(h.removed.length,0);
  await h.run(first.history,'second',undefined,undefined,tools,{...options,saved,restoreInput:async()=>{throw Error('history must not be replayed');}});
  assert.equal(h.launches.length,2);const args=h.launches[1].options.arguments;
  assert.equal(args[args.indexOf('--conversation')+1],saved.id);
  assert.equal(h.launches[1].options.environment.HOME,h.launches[0].options.environment.HOME);
  assert.equal(h.launches[1].inputs[0],'second');assert.equal(Object.keys(h.endpoints).length,1);
  const fresh=[...h.files.values()].find(v=>v.mcpServers).mcpServers.inthes;
  assert.notEqual(fresh.serverUrl,old.serverUrl);assert.notEqual(fresh.headers.Authorization,old.headers.Authorization);
  const updated=await h.ag.continuation('session');assert.notEqual(updated.fingerprint,saved.fingerprint);
  h.ag.forgetSession('session');await h.ag.discardContinuation(updated);assert.equal(h.removed.length,1);assert.equal(h.launches[1].graceful,true);
});

test('Antigravity rebuilds a pending checkpoint and removes its incomplete native home',async()=>{
  const h=harness(),first=await h.run([],'first',undefined,undefined,undefined,{persistent:true});
  const saved=await h.ag.continuation('session');saved.pending=true;h.ag.forgetSession('session');
  await h.run(first.history,'next',undefined,undefined,undefined,{persistent:true,saved});
  assert.equal(h.removed.length,1);assert.ok(!h.launches[1].options.arguments.includes('--conversation'));
  assert.match(h.launches[1].inputs[0],/PAPER EVIDENCE/);
  assert.notEqual(h.launches[1].options.environment.HOME,h.launches[0].options.environment.HOME);h.ag.stop();
});

test('Antigravity rebuilds despite reported cleanup failure and clears the old checkpoint first',async()=>{
  const h=harness(),first=await h.run([],'first',undefined,undefined,undefined,{persistent:true});
  const saved={...await h.ag.continuation('session'),pending:true},checkpoints:any[]=[];h.ag.forgetSession('session');
  h.accounts.cleanupContinuation=async()=>{assert.equal(checkpoints[0],undefined);return '旧组件记录未能清理：'+saved.home;};
  const next=await h.run(first.history,'next',undefined,undefined,undefined,{saved,persistent:true,beforeTurn:async(c:any)=>checkpoints.push(c)});
  assert.equal(next.warnings.length,1);assert.ok(next.warnings[0].includes(saved.home));assert.equal(checkpoints.at(-1).pending,true);
  assert.equal(h.launches.length,2);assert.ok(!h.launches[1].options.arguments.includes('--conversation'));h.ag.stop();
});


test('Antigravity removes long Windows transcript paths only inside its isolated session directory',async()=>{
  const h=harness(),saved={profileID:h.profile.id,home:'test-home'};
  await h.ag.discardContinuation(saved);
  assert.equal(h.removedPaths[0],path.win32.toNamespacedPath(h.removed[0]));
  await assert.rejects(h.ag.discardContinuation({...saved,home:'../escape'}),/路径无效/);
});
