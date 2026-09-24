import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';
import { newProfile } from '../src/types.ts';

const bundle=await build({entryPoints:['src/storage.ts'],bundle:true,platform:'node',format:'cjs',write:false});
const defaultDir=String.raw`C:\profile\folio`, customDir=String.raw`D:\阅读历史`;
const stateFile=path.win32.join(defaultDir,'state.json'), defaultHistory=path.win32.join(defaultDir,'folio-history.json'), historyFile=path.win32.join(customDir,'folio-history.json');
const api={...newProfile('gemini'),id:'api'},chatgpt={...newProfile('codex-account'),id:'chatgpt'};
const conversation={id:'conversation',title:'Paper discussion',updated:10,papers:[],sources:[{id:'S1P1C1',itemID:1,title:'Paper',text:'Source passage'}],messages:[{role:'user',text:'Explain',images:[{mimeType:'image/png',data:'aGVsbG8=',width:1,height:1}]}]};
const initialState=()=>({version:1,profiles:[api,chatgpt],selected:'api',remember:true,historyFormat:2,sessions:[]});

test('API billing mode and manual models survive reload with keys only in credentials',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();
  const profile={...newProfile('minimax'),billingMode:'token-plan' as const,model:'MiniMax-M3',models:[{id:'MiniMax-M3',name:'MiniMax-M3'}]};
  await storage.saveProfile(profile,'plan-test-secret');
  const restored=(await disk.newStorage()).state.profiles.find((p:any)=>p.id===profile.id);
  assert.equal(restored.billingMode,'token-plan');assert.equal(restored.models[0].id,'MiniMax-M3');
  assert.ok(!JSON.stringify(disk.files.get(stateFile)).includes('plan-test-secret'));
});
function historyDisk(saved:any=initialState(),initial:Record<string,any>={}) {
  const files=new Map<string,any>([[stateFile,structuredClone(saved)],[defaultHistory,{version:1,sessions:[structuredClone(conversation)]}],...Object.entries(initial)]),writes:string[]=[],logins:any[]=[];
  let beforeWrite:undefined|((file:string)=>Promise<void>),failCredential=false;
  const module={exports:{} as any};
  runInNewContext(bundle.outputFiles[0].text,{
    module,exports:module.exports,crypto,atob,btoa,structuredClone,PathUtils:{join:path.win32.join,isAbsolute:path.win32.isAbsolute,filename:path.win32.basename},Zotero:{Profile:{dir:String.raw`C:\profile`}},
    Services:{logins:{findLogins:()=>logins,removeLogin:(l:any)=>logins.splice(logins.indexOf(l),1),addLoginAsync:async(l:any)=>{if(failCredential)throw Error('Credential failed');logins.push(l);},modifyLogin:(a:any,b:any)=>{if(failCredential)throw Error('Credential failed');logins.splice(logins.indexOf(a),1,b);}}},
    Cc:{'@mozilla.org/login-manager/loginInfo;1':{createInstance:()=>({init(_a:any,_b:any,_c:any,username:string,password:string){Object.assign(this,{username,password});}})}},Ci:{nsILoginInfo:{}},
    IOUtils:{getChildren:async(dir:string)=>[...files.keys()].filter(f=>path.win32.dirname(f)===dir),stat:async()=>({type:'regular'}),remove:async(file:string)=>files.delete(file),read:async(file:string)=>{if(!files.has(file))throw Error("Missing image");return new Uint8Array(files.get(file));},write:async(file:string,bytes:Uint8Array)=>{await beforeWrite?.(file);writes.push(file);files.set(file,new Uint8Array(bytes));},makeDirectory:async()=>{},exists:async(file:string)=>files.has(file)||[...files.keys()].some(f=>path.win32.dirname(f)===file),copy:async(a:string,b:string)=>files.set(b,structuredClone(files.get(a))),readJSON:async(file:string)=>{
      if(!files.has(file))throw new Error('File not found');return structuredClone(files.get(file));
    },writeUTF8:async(file:string,text:string)=>{await beforeWrite?.(file);writes.push(file);files.set(file,JSON.parse(text));}}
  });
  return {files,writes,logins,newStorage:async()=>{const storage=new module.exports.Storage();await storage.init();return storage;},setWriteHook:(hook?:typeof beforeWrite)=>{beforeWrite=hook;},failCredentials:(fail:boolean)=>{failCredential=fail;}};
}

test('custom balance query configuration survives save and reload without persisting API keys',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();
  const profile={...api,balanceQuery:{path:'/balance',field:'data.balance',currency:'USD'}};
  await storage.saveProfile(profile,'balance-test-secret');
  const reloaded=await disk.newStorage();
  assert.deepEqual(reloaded.state.profiles.find((p:any)=>p.id===api.id).balanceQuery,profile.balanceQuery);
  assert.ok(!JSON.stringify(disk.files.get(stateFile)).includes('balance-test-secret'));
});

test('MinerU settings persist independently, Token stays in credentials, and failed saves roll back both',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();
  const settings={enabled:true,model:'vlm',language:'ch',ocr:false};
  await storage.setMinerU(settings,'parser-secret');assert.equal(storage.getKey('mineru-parser'),'parser-secret');
  assert.deepEqual(disk.files.get(stateFile).mineru,settings);assert.ok(!JSON.stringify([...disk.files.values()]).includes('parser-secret'));
  await storage.setMinerU({...settings,enabled:false},'parser-secret');assert.equal(storage.getKey('mineru-parser'),'parser-secret');assert.equal(storage.state.mineru.enabled,false);
  disk.setWriteHook(async()=>{throw Error('Disk full');});await assert.rejects(storage.setMinerU(settings,'new-parser-secret'),/Disk full/);
  assert.equal(storage.state.mineru.enabled,false);assert.equal(storage.getKey('mineru-parser'),'parser-secret');
});

test('missing historical images warn without blocking other conversations, edits, deletion or migration',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();
  const image={asset:'a'.repeat(64)+'.png',mimeType:'image/png',width:1,height:1,directory:path.win32.join(defaultDir,'folio-history-images')};
  const damaged={...structuredClone(conversation),id:'missing',sources:[{...conversation.sources[0],image}],messages:[{role:'assistant',text:'Image',generatedImages:[image]}]};
  await storage.storeSession(damaged);assert.match(storage.historyWarning,/1 张图片/);
  const other={...structuredClone(conversation),id:'new',title:'New conversation'};
  await storage.storeSession(other);assert.equal(disk.files.get(defaultHistory).sessions.length,3);
  await storage.updateSession('new',{pinned:true});assert.equal(storage.state.sessions.find((s:any)=>s.id==='new').pinned,true);
  await storage.deleteSessions(['conversation']);assert.equal(disk.files.get(defaultHistory).sessions.length,2);
  await storage.setHistoryPath(customDir);assert.equal(disk.files.get(historyFile).sessions.length,2);
  assert.equal(disk.files.get(historyFile).sessions.find((s:any)=>s.id==='missing').messages[0].generatedImages[0].asset,image.asset);
  await storage.deleteSessions(['missing']);assert.equal(storage.historyWarning,'');
});

test('failed image writes retain in-memory pixels for a later successful save',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();
  const image={asset:'b'.repeat(64)+'.png',mimeType:'image/png',width:1,height:1,bytes:new Uint8Array([1,2,3])};
  const session={...structuredClone(conversation),id:'retry-image',messages:[{role:'assistant',text:'Image',generatedImages:[image]}]};
  disk.setWriteHook(async file=>{if(file.endsWith('.png'))throw Error('Image directory unavailable');});
  await storage.storeSession(session);assert.ok(session.messages[0].generatedImages[0].bytes);assert.match(storage.historyWarning,/Image directory unavailable/);
  disk.setWriteHook();await storage.storeSession(session);assert.equal(storage.historyWarning,'');assert.equal(session.messages[0].generatedImages[0].bytes,undefined);
});

test('image garbage collection removes unreferenced temporary writes and leaves unrelated files',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage(),dir=path.win32.join(defaultDir,'folio-history-images');
  const temporary=path.win32.join(dir,'c'.repeat(64)+'.png.tmp'),other=path.win32.join(dir,'notes.tmp');
  disk.files.set(temporary,new Uint8Array([1]));disk.files.set(other,'keep');
  await storage.deleteSessions(['conversation']);assert.equal(disk.files.has(temporary),false);assert.equal(disk.files.has(other),true);
});

test('history figures use shared files and survive moves without cache dependence',async()=>{
  const image={asset:'c'.repeat(64)+'.png',mimeType:'image/png',width:12,height:20,bytes:new Uint8Array([97,98,99])};
  const session={...structuredClone(conversation),sources:[{...conversation.sources[0],image}]};
  const disk=historyDisk(),storage=await disk.newStorage();
  await storage.storeSession(session);await storage.storeSession({...session,id:'second'});
  const saved=disk.files.get(defaultHistory),ref=saved.sessions[0].sources[0].image;
  assert.ok(ref.asset.endsWith('.png'));assert.equal(ref.data,undefined);assert.equal(ref.directory,undefined);
  assert.equal(saved.sessions[1].sources[0].image.asset,ref.asset);
  const original=path.win32.join(defaultDir,'folio-history-images',ref.asset);
  assert.deepEqual(Array.from(disk.files.get(original)),[97,98,99]);
  assert.equal([...disk.files.keys()].filter(p=>p.includes('folio-history-images')).length,1);
  await storage.setHistoryPath(customDir);
  const copy=path.win32.join(customDir,'folio-history-images',ref.asset);assert.ok(disk.files.has(copy));assert.ok(disk.files.has(original));
  const reloaded=await disk.newStorage();assert.equal(reloaded.state.sessions[0].sources[0].image.directory,path.win32.join(customDir,'folio-history-images'));
  // A directory injected into the JSON cannot redirect a subsequent image read.
  disk.files.get(historyFile).sessions[0].sources[0].image.directory='C:\\untrusted';
  assert.equal((await disk.newStorage()).state.sessions[0].sources[0].image.directory,path.win32.join(customDir,'folio-history-images'));
});
test('generated images persist as files and survive reload and history relocation',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage(),session=structuredClone(conversation) as any;
  session.messages.push({role:'assistant',text:'Generated image.',generatedImages:[{asset:'a'.repeat(64)+'.png',mimeType:'image/png',width:20,height:10,bytes:new Uint8Array([1,2,3])}]});
  await storage.storeSession(session);
  assert.equal(session.messages[1].generatedImages[0].bytes,undefined);
  assert.equal(session.messages[1].generatedImages[0].directory,path.win32.join(defaultDir,'folio-history-images'));
  const metadata=disk.files.get(defaultHistory).sessions[0].messages[1].generatedImages[0];
  assert.equal(metadata.bytes,undefined);assert.equal(metadata.directory,undefined);assert.equal(metadata.data,undefined);
  assert.deepEqual(Array.from(disk.files.get(path.win32.join(defaultDir,'folio-history-images',metadata.asset))),[1,2,3]);
  await storage.setHistoryPath(customDir);const reloaded=await disk.newStorage(),image=reloaded.state.sessions[0].messages[1].generatedImages[0];
  assert.equal(image.directory,path.win32.join(customDir,'folio-history-images'));assert.deepEqual(Array.from(disk.files.get(path.win32.join(image.directory,image.asset))),[1,2,3]);
  disk.files.get(historyFile).sessions[0].messages[1].generatedImages[0].directory='C:\\untrusted';
  assert.equal((await disk.newStorage()).state.sessions[0].messages[1].generatedImages[0].directory,path.win32.join(customDir,'folio-history-images'));
});

test('history deletion removes only unreferenced Folio images and preserves open/shared files',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage(),dir=path.win32.join(defaultDir,'folio-history-images');
  const image=(letter:string)=>({asset:letter.repeat(64)+'.png',mimeType:'image/png',width:1,height:1,bytes:new Uint8Array([1])});
  const a={...structuredClone(conversation),id:'a',messages:[{role:'assistant',text:'image',generatedImages:[image('a'),image('b'),image('c')]}]};
  const b={...structuredClone(conversation),id:'b',sources:[{...conversation.sources[0],image:image('b')}]};
  await storage.storeSession(a);await storage.storeSession(b);
  const open={...a,id:'open',messages:[{role:'assistant',text:'image',generatedImages:[a.messages[0].generatedImages[2]]}]};
  const unrelated=path.win32.join(dir,'my-photo.png');disk.files.set(unrelated,new Uint8Array([5]));
  const elsewhere=path.win32.join(customDir,'folio-history-images','a'.repeat(64)+'.png');disk.files.set(elsewhere,new Uint8Array([1]));
  await storage.deleteSessions(['a'],()=>[open]);
  assert.equal(disk.files.has(path.win32.join(dir,'a'.repeat(64)+'.png')),false);
  for(const letter of ['b','c'])assert.ok(disk.files.has(path.win32.join(dir,letter.repeat(64)+'.png')));
  assert.ok(disk.files.has(unrelated));assert.ok(disk.files.has(elsewhere));
  await storage.deleteSessions(['b']);assert.deepEqual([...disk.files.keys()].filter(f=>path.win32.dirname(f)===dir),[unrelated]);
});

test('saving releases only the generated bytes in that snapshot, preserving newer images',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage(),session=structuredClone(conversation) as any;
  const first={asset:'a'.repeat(64)+'.png',mimeType:'image/png',width:1,height:1,bytes:new Uint8Array([1])};
  const newer={...first,asset:'b'.repeat(64)+'.png'};
  session.messages.push({role:'assistant',text:'image',generatedImages:[first]});
  disk.setWriteHook(async file=>{if(file===defaultHistory)session.messages[1].generatedImages.push(newer);});
  await storage.storeSession(session);
  assert.equal(session.messages[1].generatedImages[0].bytes,undefined);
  assert.equal(session.messages[1].generatedImages[1],newer);
  disk.setWriteHook(async()=>{throw Error('Disk full');});
  await assert.rejects(storage.storeSession(session),/Disk full/);assert.ok(session.messages[1].generatedImages[1].bytes);
});

test('history metadata survives reload, continuing a conversation, and a custom history path',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage(),stale=structuredClone(storage.state.sessions[0]);
  await storage.updateSession(stale.id,{title:'Renamed discussion',renamed:true});
  await storage.updateSession(stale.id,{pinned:true,archived:true});
  stale.title='Automatic question title';stale.messages.push({role:'assistant',text:'A new answer'});
  await storage.storeSession(stale);
  await storage.setHistoryPath(customDir);
  const saved=(await disk.newStorage()).state.sessions[0];
  assert.equal(saved.title,'Renamed discussion');assert.equal(saved.renamed,true);assert.equal(saved.pinned,true);assert.equal(saved.archived,true);assert.equal(saved.messages.length,2);
  await storage.updateSession(stale.id,{archived:false});assert.equal(storage.state.sessions[0].archived,false);
});

test('failed history rename and deletion preserve both in-memory and saved conversations',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage(),before=JSON.stringify(storage.state.sessions);
  disk.setWriteHook(async()=>{throw Error('Disk full');});
  await assert.rejects(storage.updateSession(conversation.id,{title:'Lost',renamed:true}),/Disk full/);
  assert.equal(JSON.stringify(storage.state.sessions),before);
  await assert.rejects(storage.deleteSessions([conversation.id]),/Disk full/);
  assert.equal(JSON.stringify(storage.state.sessions),before);
  disk.setWriteHook();await storage.deleteSessions([conversation.id]);
  assert.equal((await disk.newStorage()).state.sessions.length,0);
});

test('queued history changes do not lose a renamed or pinned conversation during a save',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();
  await Promise.all([storage.updateSession(conversation.id,{pinned:true}),storage.storeSession(structuredClone(conversation)),storage.updateSession(conversation.id,{title:'Final title',renamed:true})]);
  const saved=(await disk.newStorage()).state.sessions[0];assert.equal(saved.pinned,true);assert.equal(saved.title,'Final title');
});

test('unsupported inline-history configurations are rejected without migration or writes',async()=>{
  for(const original of [{...initialState(),historyFormat:undefined,sessions:[conversation]},{...initialState(),profiles:[{...api,protocol:'gemini-account'}]}]){
    const disk=historyDisk(original);await assert.rejects(disk.newStorage(),/不兼容/);assert.equal(disk.writes.length,0);assert.deepEqual(disk.files.get(stateFile),original);
  }
});
test('settings saves do not serialize or rewrite history',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();disk.writes.length=0;
  storage.state.sessions[0].messages[0].text='New message';storage.state.profiles[0].reasoning='low';await storage.save();
  assert.deepEqual(disk.writes,[stateFile]);assert.equal(disk.files.get(defaultHistory).sessions[0].messages[0].text,'Explain');
  await storage.storeSession(storage.state.sessions[0]);assert.equal(disk.files.get(defaultHistory).sessions[0].messages[0].text,'New message');
});
test('custom history reloads and returning to default keeps both copies',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();await storage.setHistoryPath(customDir);
  assert.deepEqual(disk.files.get(historyFile).sessions,[conversation]);const reloaded=await disk.newStorage();assert.deepEqual(reloaded.state.sessions,[conversation]);
  await reloaded.setHistoryPath(' ');assert.equal(disk.files.get(stateFile).historyPath,undefined);assert.deepEqual(disk.files.get(stateFile).sessions,[]);assert.deepEqual(disk.files.get(defaultHistory).sessions,[conversation]);assert.deepEqual(disk.files.get(historyFile).sessions,[conversation]);
});
test('history location merges newer sessions without overwriting unrelated history',async()=>{
  const other={...conversation,id:'other',updated:20},old={...conversation,updated:1,title:'old'};
  const disk=historyDisk(initialState(),{[historyFile]:{version:1,sessions:[old,other]}}),storage=await disk.newStorage();await storage.setHistoryPath(customDir);
  assert.deepEqual(structuredClone(storage.state.sessions),[other,conversation]);
});
test('bad history IDs, message fields and configuration traversal IDs are rejected before use',async()=>{
  for(const session of [{...conversation,id:'a" onpointerenter="alert(1)'},{...conversation,messages:[{role:'user" onclick="x',text:'x'}]}]){
    const original={...initialState(),sessions:[session]},disk=historyDisk(original);await assert.rejects(disk.newStorage(),/无效/);assert.equal(disk.writes.length,0);assert.deepEqual(disk.files.get(stateFile),original);
  }
  await assert.rejects(historyDisk({...initialState(),profiles:[{...api,id:'../escape'}]}).newStorage(),/无效/);
});
test('unavailable custom history permits settings but prevents accidental overwrite and recovers explicitly',async()=>{
  const disk=historyDisk({...initialState(),historyFormat:2,historyPath:customDir,sessions:[]}),storage=await disk.newStorage();assert.match(storage.historyError,/无法读取/);
  await storage.save();await assert.rejects(storage.storeSession(conversation),/无法读取/);assert.equal(disk.files.has(historyFile),false);
  await assert.rejects(storage.setHistoryPath(customDir),/File not found/);
  disk.files.set(historyFile,{version:1,sessions:[conversation]});await storage.setHistoryPath(customDir);assert.equal(storage.historyError,'');assert.deepEqual(structuredClone(storage.state.sessions),[conversation]);
});
test('invalid locations and failed history writes roll back path and in-memory history',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage(),before=structuredClone(disk.files.get(stateFile));
  assert.throws(()=>storage.setHistoryPath('relative'),/完整路径/);disk.files.set(historyFile,{version:99,sessions:[]});await assert.rejects(storage.setHistoryPath(customDir),/不兼容/);disk.files.delete(historyFile);
  disk.setWriteHook(async file=>{if(file===historyFile)throw Error('Permission denied');});await assert.rejects(storage.setHistoryPath(customDir),/Permission denied/);
  assert.equal(storage.state.historyPath,undefined);assert.deepEqual(structuredClone(storage.state.sessions),[conversation]);assert.deepEqual(disk.files.get(stateFile),before);
});
test('a history save queued during a location change keeps the latest conversation',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();let unblock!:()=>void,started!:()=>void;
  const blocked=new Promise<void>(r=>unblock=r),writing=new Promise<void>(r=>started=r);disk.setWriteHook(async file=>{if(file===historyFile){started();await blocked;}});
  const moving=storage.setHistoryPath(customDir);await writing;const latest={...conversation,updated:30,title:'Latest'};const saving=storage.storeSession(latest);unblock();await Promise.all([moving,saving]);assert.deepEqual(disk.files.get(historyFile).sessions,[latest]);
});
test('disabling retention preserves history across reloads, continued saves and location changes',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();await storage.setHistoryPath(customDir);disk.writes.length=0;
  storage.state.remember=false;await storage.save();assert.deepEqual(disk.writes,[stateFile]);
  const reloaded=await disk.newStorage();assert.equal(reloaded.state.remember,false);assert.deepEqual(reloaded.state.sessions,[conversation]);
  reloaded.state.sessions[0].messages[0].text='Continued conversation';await reloaded.storeSession(reloaded.state.sessions[0]);assert.equal(disk.files.get(historyFile).sessions[0].messages[0].text,'Continued conversation');
  await reloaded.setHistoryPath('');assert.equal(disk.files.get(defaultHistory).sessions[0].messages[0].text,'Continued conversation');
  await reloaded.deleteSessions([conversation.id]);assert.equal((await disk.newStorage()).state.sessions.length,0);
});

test('unavailable history remains protected when saving new conversations is disabled',async()=>{
  const disk=historyDisk({...initialState(),remember:false,historyFormat:2,historyPath:customDir,sessions:[]}),storage=await disk.newStorage();
  assert.match(storage.historyError,/无法读取/);await assert.rejects(storage.storeSession(conversation),/无法读取/);assert.equal(disk.files.has(historyFile),false);
});

test('cache switch persists without removing history and rolls back on write failure',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();await storage.setCacheEnabled(false);
  assert.equal((await disk.newStorage()).state.cacheEnabled,false);assert.deepEqual(disk.files.get(defaultHistory).sessions,[conversation]);
  disk.setWriteHook(async()=>{throw Error('Disk full');});await assert.rejects(storage.setCacheEnabled(true),/Disk full/);assert.equal(storage.state.cacheEnabled,false);
});
test('credential update failure preserves the previous key and profile',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();await storage.setKey('api','old-secret');disk.failCredentials(true);
  await assert.rejects(storage.saveProfile({...api,baseURL:'https://new.example'},'new-secret'),/Credential failed/);assert.equal(storage.getKey('api'),'old-secret');assert.equal(storage.state.profiles[0].baseURL,api.baseURL);
});
test('configuration write failure restores credentials, profile and selection',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();await storage.setKey('api','old-secret');disk.setWriteHook(async()=>{throw Error('Disk full');});
  await assert.rejects(storage.saveProfile({...api,baseURL:'https://new.example'},'new-secret'),/Disk full/);assert.equal(storage.getKey('api'),'old-secret');assert.deepEqual(storage.state.profiles,[api,chatgpt]);
  await assert.rejects(storage.deleteProfile(api),/Disk full/);assert.equal(storage.getKey('api'),'old-secret');assert.deepEqual(storage.state.profiles,[api,chatgpt]);
});
test('cache path is validated and restored when settings write fails',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();assert.throws(()=>storage.setCachePath('relative'),/完整路径/);await storage.setCachePath(customDir);assert.equal(storage.cache.directory(),customDir);
  disk.setWriteHook(async()=>{throw Error('Disk full');});await assert.rejects(storage.setCachePath(''),/Disk full/);assert.equal(storage.state.cachePath,customDir);
});


test('native checkpoints survive history reload while invalid recovery paths are rejected',async()=>{
  const disk=historyDisk(),storage=await disk.newStorage();
  const continuation={protocol:'antigravity-account',profileID:'account',id:'native-thread',home:'isolated-home',fingerprint:'a'.repeat(64),pending:true};
  await storage.storeSession({...conversation,continuation});
  const restored=await disk.newStorage();assert.deepEqual(structuredClone(restored.state.sessions[0].continuation),continuation);
  disk.files.get(defaultHistory).sessions[0].continuation.home='../escape';
  const invalid=await disk.newStorage();assert.match(invalid.historyError,/无效/);assert.equal(invalid.state.sessions.length,0);
});
