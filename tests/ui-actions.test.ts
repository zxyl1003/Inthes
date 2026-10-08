import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {runInNewContext} from 'node:vm';
import {newProfile} from '../src/types.ts';
import {libraryState} from '../src/library.ts';

const bundle=await build({entryPoints:['src/ui.ts'],bundle:true,platform:'browser',format:'cjs',loader:{'.css':'text','.svg':'text'},write:false});
const module={exports:{} as any};
const zotero:any={Folio:{show:()=>{}}};
runInNewContext(bundle.outputFiles[0].text,{module,exports:module.exports,Zotero:zotero,structuredClone,URL,ChromeUtils:{importESModule:()=>({})}});
const {Panel}=module.exports;
function harness(messages:any[]=[]) {
  const events:string[]=[],panel=Object.create(Panel.prototype);
  Object.assign(panel,{workspace:'reading',scopeVersion:0,workspaceSessions:new Map(),libraryMarkup:new WeakMap(),session:{id:'current',messages},storage:{state:{profiles:[],sessions:[]}},accounts:{forgetSession:()=>events.push('forget')},render:()=>events.push('render'),toast:(s:string)=>events.push(s),availableModels:()=>[{id:'model'}],ask:async()=>{events.push('ask');}});
  Object.defineProperty(panel,'profile',{value:{model:'model'}});
  return {panel,events};
}

test('generated images already loaded reuse their display URL without reading the image again',async()=>{
  const {panel}=harness(),errors:string[]=[],img={dataset:{generatedImage:'0:0'},src:'',alt:'',isConnected:true};
  const image={asset:'cached.png',get bytes(){throw Error('Image must not be read again');}};
  panel.session.messages=[{role:'assistant',text:'',generatedImages:[image]}];
  panel.root={querySelectorAll:()=>[img]};panel.generatedURLs=new Map([['cached.png','blob:cached-image']]);panel.safeError=(error:Error)=>{errors.push(error.message);return error.message;};
  panel.loadGeneratedImages();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(img.src,'blob:cached-image');assert.deepEqual(errors,[]);
});

test('API connection cards expose four providers and plan changes clear old credentials and models',async()=>{
  const {panel}=harness();panel.pageHead=()=>'';
  const cards=panel.addView();for(const preset of ['qwen','kimi','glm','minimax'])assert.match(cards.match(new RegExp(`data-preset="${preset}"[\\s\\S]*?</button>`))?.[0]||'',/service-logo/);
  const p={...newProfile('qwen'),model:'old',models:[{id:'old',name:'old'}]};
  panel.editing=p;panel.modelOptions=p.models;panel.editingVersion=0;panel.readForm=()=>({p,key:'old-secret'});
  const field={value:'old-secret'};panel.root={querySelector:()=>field};
  await panel.change({target:{name:'billingMode',value:'token-plan-team'}});
  assert.equal(panel.editing.billingMode,'token-plan-team');assert.equal(panel.editing.protocol,'responses');assert.equal(panel.editing.model,'');assert.equal(panel.modelOptions.length,0);assert.equal(field.value,'');
});

test('manually entered model IDs can be selected without a model listing API and cannot add duplicates',async()=>{
  const {panel}=harness(),field={value:'glm-5.3'},select={value:''};
  panel.editing=newProfile('glm');panel.modelOptions=[];panel.root={querySelector:(q:string)=>q.includes('modelID')?field:select};panel.updateStatus=()=>{};
  panel.updateModelOptions=()=>{select.value=panel.editing.model;};
  await panel.action('add-model',{});assert.equal(select.value,'glm-5.3');assert.equal(panel.modelOptions.length,1);assert.equal(field.value,'');
  assert.equal(panel.editing.models[0].manual,true);
  field.value='glm-5.3';await panel.action('add-model',{});assert.equal(panel.modelOptions.length,1);
  field.value='invalid model';await assert.rejects(panel.action('add-model',{}),/模型 ID/);
  await panel.action('remove-model',{dataset:{id:'glm-5.3'}});assert.equal(panel.editing.model,'');assert.equal(panel.modelOptions.length,0);assert.equal(panel.editing.models.length,0);
});

test('model refreshes preserve manual entries and metadata without restoring removed entries',async()=>{
  const {panel}=harness(),manual={id:'local',name:'local',manual:true},shared={id:'shared',name:'shared',manual:true};
  const form={querySelector:()=>({disabled:false})},input={value:'late'},select={value:''};
  panel.editing=newProfile('minimax');panel.modelOptions=[manual,shared,{id:'old',name:'old'}];
  panel.root={querySelector:(q:string)=>q==='#profile-form'?form:q.includes('modelID')?input:select};
  panel.readForm=()=>({p:{...panel.editing,models:panel.modelOptions},key:'test-key'});panel.updateModelOptions=()=>{};panel.updateStatus=()=>{};
  panel.getModels=async()=>[{id:'shared',name:'New name',vision:true},{id:'new',name:'new'}];
  await panel.loadModels();
  assert.deepEqual(Array.from(panel.modelOptions,(m:any)=>m.id),['shared','new','local']);
  assert.equal(panel.modelOptions[0].manual,true);assert.equal(panel.modelOptions[0].vision,true);assert.equal(panel.modelOptions[0].name,'New name');

  let finish!:(models:any[])=>void;panel.getModels=()=>new Promise(resolve=>finish=resolve);
  const pending=panel.loadModels();
  await panel.action('add-model',{});await panel.action('remove-model',{dataset:{id:'local'}});
  finish([{id:'new',name:'new'}]);await pending;
  assert.deepEqual(Array.from(panel.modelOptions,(m:any)=>m.id),['new','shared','late']);
  panel.invalidateModels();assert.deepEqual(Array.from(panel.modelOptions,(m:any)=>m.id),['shared','late']);
});

test('saved manual models remain selectable after chat list refresh and reopening a connection',async()=>{
  const {panel}=harness(),p=Object.assign(panel.profile,newProfile('kimi'),{models:[{id:'manual',name:'manual',manual:true}],model:'manual'});
  panel.storage.state.profiles=[p];panel.storage.getKey=()=> 'test-key';
  let saved:any;panel.storage.save=async()=>{saved=structuredClone(p);};
  panel.modelLoadVersion=0;panel.updateModelResults=()=>{};panel.updateImageNotice=()=>{};panel.root={querySelector:()=>null};panel.prepareAccount=async()=>{};
  panel.availableModels=Panel.prototype.availableModels;
  panel.getModels=async()=>[{id:'remote',name:'remote'}];
  await panel.loadChatModels();
  assert.deepEqual(Array.from(saved.models,(m:any)=>m.id),['remote','manual']);
  panel.storage.state.profiles=[saved];await panel.action('edit',{dataset:{id:p.id}});
  assert.ok(panel.modelOptions.some((m:any)=>m.id==='manual'&&m.manual));
});

test('API connection settings expose manual models and their delete controls',()=>{
  const {panel}=harness();
  for(const preset of ['deepseek','qwen','kimi','glm','minimax','openai','gemini','anthropic','openrouter','custom']){
    panel.editing=newProfile(preset);assert.match(panel.modelFields(),/data-action="add-model"/);
  }
  panel.modelOptions=[{id:'manual',name:'manual',manual:true},{id:'remote',name:'remote'}];
  const select={value:''},list={};let markup='';
  panel.root={querySelector:(q:string)=>q==='#available-model'?select:q==='#manual-model-list'?list:null};
  panel.html=(target:any,value:string)=>{if(target===list)markup=value;};panel.updateReasoningOptions=()=>{};panel.selectMenu={refresh:()=>{}};
  panel.updateModelOptions();assert.match(markup,/data-action="remove-model" data-id="manual"/);assert.doesNotMatch(markup,/data-id="remote"/);
});

test('late completion persistence cannot overwrite a new turn or a switched session',async()=>{
  for(const change of ['running','finished','switched']){
    const {panel,events}=harness([{role:'assistant',text:'previous',error:'invalid reference'}]),writes:any[]=[];
    const old={id:'old-native',pending:true},next={id:'new-native',pending:change==='running'};panel.session.continuation=old;
    let finish!:(value:any)=>void;panel.accounts.continuation=()=>new Promise(resolve=>finish=resolve);
    panel.storage.storeSession=async(s:any)=>writes.push(structuredClone(s));panel.showHistoryWarning=()=>{};
    const previousSession=panel.session,work=panel.persist();
    if(change==='switched')panel.session={id:'other',messages:[],continuation:next};
    else {panel.session.messages.push({role:'user',text:'new question'},{role:'assistant',text:change==='finished'?'new answer':''});panel.session.continuation=next;if(change==='running')panel.controller=new AbortController();}
    finish({...old,pending:false});await work;
    assert.equal(panel.session.continuation,next);assert.equal(writes.length,0);assert.ok(!events.includes('forget'));
    if(change==='switched')assert.equal(previousSession.continuation,old);
  }
});

test('local history deletion succeeds even when old component cleanup reports failure',async()=>{
  const {panel,events}=harness(),checkpoint={protocol:'codex-account',id:'native-thread'},cleaned:any[]=[];
  panel.storage.state.sessions=[panel.session,{id:'old',continuation:checkpoint}];
  panel.protectedSessions=()=>new Set(['current']);panel.historyPanels=()=>[panel];panel.scrollPositions=new Map([['old',20]]);panel.showHistoryWarning=()=>{};panel.view='history';
  panel.storage.deleteSessions=async(ids:string[])=>{assert.equal(cleaned.length,0);panel.storage.state.sessions=panel.storage.state.sessions.filter((s:any)=>!ids.includes(s.id));};
  panel.accounts.cleanupContinuation=async(saved:any)=>{cleaned.push(saved);return '旧组件记录未能清理：native-thread，未找到运行组件';};
  await panel.removeHistory(['old','current']);
  assert.deepEqual(panel.storage.state.sessions.map((s:any)=>s.id),['current']);assert.equal(cleaned[0],checkpoint);assert.equal(panel.scrollPositions.has('old'),false);
  assert.ok(events.some(s=>s.includes('已删除 1 条对话')&&s.includes('native-thread')));
});

test('native cleanup follows an actual history deletion even if image cleanup subsequently fails',async()=>{
  const {panel}=harness(),checkpoint={id:'native'},cleaned:any[]=[];
  panel.storage.state.sessions=[{id:'old',continuation:checkpoint}];panel.protectedSessions=()=>new Set();panel.historyPanels=()=>[panel];panel.scrollPositions=new Map();
  panel.storage.deleteSessions=async()=>{panel.storage.state.sessions=[];throw Error('image cleanup failed');};
  panel.accounts.cleanupContinuation=async(saved:any)=>{cleaned.push(saved);};
  await assert.rejects(panel.removeHistory(['old']),/image cleanup failed/);assert.equal(cleaned[0],checkpoint);
});
test('authorization button retains the code on failure and clears it only after confirmation',async()=>{
  for(const success of [true,false]){
    const {panel}=harness();let finish!:()=>void,fail!:(e:Error)=>void;
    const waiting=new Promise<void>((resolve,reject)=>{finish=resolve;fail=reject;});
    const input={value:'test-code',readOnly:false},button={disabled:false,textContent:'完成授权'};
    panel.root={querySelector:()=>input};panel.editing={id:'ag'};
    panel.accounts.antigravity={loginCode:async()=>waiting};
    const work=panel.action('login-code',button);assert.equal(button.disabled,true);assert.equal(input.value,'test-code');
    if(success){finish();await work;assert.equal(input.value,'');}
    else {fail(Error('Rejected'));await assert.rejects(work,/Rejected/);assert.equal(input.value,'test-code');}
    assert.equal(button.disabled,false);assert.equal(input.readOnly,false);
  }
});

test('late scope success and failure cannot replace a locked or different session',async()=>{
  for(const change of ['locked','new','newer','failure']){
    let finish!:()=>void,reject!:(e:Error)=>void;
    const loading=new Promise<void>((resolve,fail)=>{finish=resolve;reject=fail;});
    zotero.Collections={get:()=>({name:'B',loadDataType:()=>loading,getChildItems:()=>[{id:2,libraryID:1,isRegularItem:()=>true,getAttachments:()=>[],getField:()=>''}]})};
    const {panel}=harness();Object.assign(panel,{workspace:'library',safeError:(e:Error)=>e.message});
    panel.session.papers=[{id:1,title:'A',libraryID:1}];panel.session.sources=[{id:'S1P1C1'}];
    const pending=panel.selectLibraryScope(2,false);
    assert.equal(panel.scopeLoading,true);
    await Panel.prototype.ask.call(panel);assert.equal(panel.controller,undefined);
    if(change==='locked'){panel.session.locked=true;panel.controller=new AbortController();}
    else if(change==='newer')await panel.selectLibraryScope(0,false);
    else panel.session={id:'new',messages:[],papers:[{id:3}],sources:[{id:'S3P1C1'}]};
    if(change==='failure')reject(Error('Old load failed'));else finish();
    await pending;
    assert.equal(panel.scopeError,'');assert.equal(panel.scopeLoading,false);
    assert.deepEqual(Array.from(panel.session.papers,(p:any)=>p.id),change==='locked'?[1]:change==='newer'?[]:[3]);
    if(change==='locked')assert.equal(panel.session.sources.length,1);
  }
});

test('opening a history already owned by another panel focuses its live session',()=>{
  const a=harness().panel,b=harness().panel;let shown:any,focused=false;
  const live={id:'shared',messages:[{role:'assistant',text:'New answer'}],papers:[],sources:[]};
  a.session=live;a.win={focus:()=>{focused=true;}};b.session.id='other';
  b.storage.state.sessions=[{...live,messages:[]}];b.historyPanels=()=>[a,b];zotero.Folio.show=(win:any)=>shown=win;
  b.openSession('shared');assert.equal(a.session,live);assert.equal(b.session.id,'other');assert.equal(shown,a.win);assert.equal(focused,true);
  a.workspaceSessions.set('library',{session:live,draft:'pending question',images:[]});a.session={id:'reading',messages:[]};
  b.openSession('shared');assert.equal(a.session,live);assert.equal(a.draft,'pending question');assert.equal(a.workspaceSessions.has('library'),false);assert.equal(a.workspaceSessions.get('reading').session.id,'reading');
});

test('recent and archived history menus offer a full-conversation note',()=>{
  for(const archived of [false,true]){
    const {panel}=harness();let markup='';
    panel.storage.state.sessions=[{id:'saved',title:'Saved',archived}];
    const menu={setAttribute:()=>{},style:{},getBoundingClientRect:()=>({width:240,height:320}),querySelector:()=>null};
    panel.win={document:{createElementNS:()=>menu}};panel.root={querySelector:()=>({append:()=>{}})};
    panel.host={getBoundingClientRect:()=>({left:0,top:0,right:500,bottom:900})};panel.protectedSessions=()=>new Set();panel.closeHistoryMenu=()=>{};panel.html=(_el:any,html:string)=>{markup=html;};
    panel.openHistoryMenu('saved',{x:20,y:20});assert.match(markup,/data-action="history-note" data-id="saved"/);assert.match(markup,/保存完整会话为笔记/);
  }
});

test('saving a removed history as a note reports it without using the current session',async()=>{
  const {panel,events}=harness();panel.closeHistoryMenu=()=>{};
  await panel.historyAction('history-note',{dataset:{id:'missing'}});
  assert.equal(events.at(-1),'这条对话已不存在');assert.equal(panel.historyBusy,false);
});

function readingHarness(output:(input:any,index:number)=>string) {
  const {panel}=harness(),requests:any[]=[],snapshots:any[]=[];
  Object.assign(panel.profile,newProfile('codex-account'),{model:'model'});
  Object.assign(panel,{draft:'解释方法',draftImages:[],win:{AbortController,setTimeout,clearTimeout},root:{querySelector:()=>null},syncSelection:()=>{},updateDraftImages:()=>{},updateComposer:()=>{},refreshReading:()=>{},updateContextMeter:()=>{},updateStatus:()=>{},setGenerationPhase:()=>{},renderAnswer:()=>{},scheduleAnswer:()=>{},updateLibraryProgress:()=>{},persist:async()=>{},safeError:(e:Error)=>e.message,generate:async(_p:any,input:any,onText:any,_events:any,_conversation:any,tools:any)=>{requests.push(input);if(tools?.definitions.some((t:any)=>t.name==='read_current_papers')&&!input.messages.at(-1).content.includes('<literature>'))await tools.execute({id:'read',name:'read_current_papers',arguments:{query:'解释方法',full:false}});onText(output(input,requests.length));}});
  panel.accounts.updateHistory=(id:string,history:any)=>snapshots.push({id,history});
  // Routing tests supply completed Markdown; citation repair is tested separately.
  panel.generateCited=(...args:any[])=>panel.generate(...args.slice(0,6));
  panel.session.papers=[{id:1,title:'Paper',libraryID:1}];panel.session.sources=[{id:'S1P1C1',itemID:1,title:'Paper',text:'Evidence'}];
  return {panel,requests,snapshots};
}

const citationResponse=(id='S1P1C1')=>`Evidence [${id}]`;
test('account citation repair keeps completed tools and native continuation intact',async()=>{
  for(const protocol of ['codex-account','antigravity-account']){
    const h=readingHarness(()=>''),panel=h.panel;panel.profile.protocol=protocol;panel.controller=new AbortController();
    let reads=0,calls=0;const shown:string[]=[],requests:any[]=[],updates:string[]=[];
    panel.session.continuation={id:'native-checkpoint'};
    panel.accounts.forgetSession=()=>{throw Error('local repair must not reset native continuation');};
    const tools={definitions:[],execute:async()=>{reads++;return {text:'[S1P1C1] Paper evidence'};}};
    panel.generate=async(_p:any,request:any,onText:any,_events:any,conversation:any,offered:any)=>{
      requests.push({request,conversation,offered});calls++;
      if(calls===1){await offered.execute({name:'read_papers',arguments:{}});onText('正常 [S1P1C1]。\n\nClaim [S4C23]');}
      else {assert.match(request.messages.map((m:any)=>m.content).join('\n'),/Evidence/);assert.doesNotMatch(request.messages.at(-1).content,/正常 \[S1P1C1\]/);assert.match(updates[0],/正常/);onText(citationResponse());}
    };
    await Panel.prototype.generateCited.call(panel,panel.profile,{system:'Read',messages:[{role:'user',content:'Question'}]},(text:string)=>shown.push(text),{}, {id:'current',query:'Question',compaction:0,evidence:''},tools,undefined,(text:string)=>updates.push(text));
    assert.equal(reads,1);assert.equal(calls,2);assert.deepEqual(shown,[]);assert.equal(updates.at(-1),'正常 [S1P1C1]。\n\nEvidence [S1P1C1]');assert.equal(panel.session.continuation.id,'native-checkpoint');
    assert.equal(requests[0].conversation.id,'current');assert.equal(requests[1].conversation,undefined);assert.equal(requests[1].offered,undefined);
  }
});

test('unprovided citations are marked locally without losing normal body text',async()=>{
  const {panel}=readingHarness(()=>''),shown:string[]=[];panel.controller=new AbortController();
  panel.session.messages=[{role:'assistant',text:'Previous evidence [S1P1C1]'}];let calls=0;
  panel.generate=async(_p:any,_input:any,onText:any)=>{calls++;onText('正常正文。\n\n'+citationResponse());};
  await Panel.prototype.generateCited.call(panel,panel.profile,{system:'Read',messages:[{role:'assistant',content:'Previous [S1P1C1]'},{role:'user',content:'New question without evidence'}]},(text:string)=>shown.push(text));
  assert.equal(calls,3);assert.deepEqual(shown,['正常正文。\n\nEvidence （此处论断的原文依据未核实）']);
});

test('API citation correction reuses actual tool evidence without repeating a read',async()=>{
  const {panel}=readingHarness(()=>''),shown:string[]=[],requests:any[]=[];panel.controller=new AbortController();
  Object.assign(panel.profile,newProfile('custom'),{baseURL:'https://api.example.com/v1',model:'model',reasoning:'',contextAuto:false});
  panel.generate=Panel.prototype.generate;panel.storage.getKey=()=> 'test-key';let reads=0;
  const tools={definitions:[{name:'read_papers',description:'Read',parameters:{type:'object',properties:{}}}],execute:async()=>{reads++;return {text:'[S1P1C1] Actual tool evidence'};}};
  panel.win.fetch=async(_url:string,init:any)=>{
    const body=JSON.parse(init.body);requests.push(body);assert.equal(shown.length,0);
    const message=requests.length===1?{content:'Reading…',tool_calls:[{id:'read',type:'function',function:{name:'read_papers',arguments:'{}'}}]}:{content:requests.length===2?'Unsupported [S4C23]':citationResponse()};
    return Response.json({choices:[{message,finish_reason:requests.length===1?'tool_calls':'stop'}]});
  };
  await Panel.prototype.generateCited.call(panel,panel.profile,{system:'Read',messages:[{role:'user',content:'Question'}]},(text:string)=>shown.push(text),{},undefined,tools);
  assert.equal(reads,1);assert.equal(requests.length,3);assert.deepEqual(shown,['Reading…\n\nEvidence [S1P1C1]']);
  assert.equal(requests[0].tool_choice,'auto');assert.equal(requests[2].tools,undefined);
  assert.match(JSON.stringify(requests[2].messages),/Evidence/);assert.doesNotMatch(JSON.stringify(requests[2].messages),/Reading…/);
});

test('extraction corrects a malformed summary locally before the main paper answer',async()=>{
  const {panel}=readingHarness(()=>''),source=panel.session.sources[0];panel.controller=new AbortController();panel.generateCited=Panel.prototype.generateCited;
  let calls=0;panel.preparePapers=async()=>{throw Error('cached paper must not be reread');};panel.session.sources[0].text='Content '.repeat(1800);
  panel.generate=async(_p:any,_input:any,onText:any)=>onText(++calls===1?'Bad summary [S4C23]':citationResponse());
  const result=await panel.readCurrentPapers(panel.profile,'Summary',true,1000,{},panel.controller.signal);
  assert.ok(calls>1);assert.match(result.text,/Evidence \[S1P1C1\]/);assert.equal(result.sources[0].id,source.id);assert.doesNotMatch(result.text,/S4C23/);
});

test('automatic model metadata discovery retains the selected manual API model',async()=>{
  const {panel}=readingHarness(()=> 'Answer [S1P1C1]');
  Object.assign(panel.profile,newProfile('custom'),{baseURL:'https://models.example/v1',model:'manual',models:[{id:'manual',name:'manual',manual:true}]});
  panel.availableModels=(p:any)=>p.models||[];panel.metadataChecked=new Set();panel.storage.getKey=()=> 'test-key';
  panel.win.fetch=async()=>Response.json({data:[{id:'remote'}]});
  await Panel.prototype.ask.call(panel);
  assert.equal(panel.session.messages.at(-1).error,undefined);assert.ok(panel.profile.models.some((m:any)=>m.id==='manual'&&m.manual));
});

test('paper conversations use the paper title by default and preserve manual names',async()=>{
  const {panel}=readingHarness(()=> 'Answer [S1P1C1]');
  await Panel.prototype.ask.call(panel);
  assert.equal(panel.session.title,'Paper');

  const {panel:multiple}=readingHarness(()=> 'Answer [S1P1C1]');
  multiple.session.papers.push({id:2,title:'Second paper',libraryID:1});
  await Panel.prototype.ask.call(multiple);
  assert.equal(multiple.session.title,'Paper 等 2 篇文献');

  const {panel:renamed}=readingHarness(()=> 'Answer [S1P1C1]');
  renamed.session.title='我的研究';renamed.session.renamed=true;
  await Panel.prototype.ask.call(renamed);
  assert.equal(renamed.session.title,'我的研究');

  const {panel:withoutPaper}=readingHarness(()=> 'Answer');
  withoutPaper.session.papers=[];withoutPaper.session.sources=[];
  await Panel.prototype.ask.call(withoutPaper);
  assert.equal(withoutPaper.session.title,'解释方法');
});

test('sending a follow-up reloads generated images after replacing the conversation DOM',async()=>{
  const {panel}=readingHarness(()=> 'Answer [S1P1C1]'),calls:string[]=[];
  panel.session.messages=[{role:'user',text:'Draw'},{role:'assistant',text:'Image',generatedImages:[{asset:'saved.png'}]}];
  const log={scrollTop:0,scrollHeight:100};
  panel.root={querySelector:(q:string)=>q==='.conversation'?log:null};
  panel.messagesHTML=()=>'<figure>Saved image</figure>';panel.html=()=>calls.push('render');
  panel.loadGeneratedImages=()=>calls.push('images');
  const generate=panel.generate;panel.generate=async(...args:any[])=>{assert.deepEqual(calls,['render','images']);return generate(...args);};
  await Panel.prototype.ask.call(panel);assert.equal(panel.session.messages.at(-1).error,undefined);
});

test('question-focused reading limits evidence while full reading retains the complete paper',async()=>{
  const {panel}=readingHarness(()=>''),answer:any={role:'assistant',text:''};
  panel.session.sources=Array.from({length:200},(_,i)=>({id:`S1P1C${i+1}`,itemID:1,title:'Paper',text:i===150?'Training hardware: A100 GPUs; 22,016 GPU hours.':'Other result '+('Unrelated experiment. '.repeat(50))}));
  const signal=new AbortController().signal;
  const found=await panel.readCurrentPapers(panel.profile,'training hardware GPU hours',false,100000,answer,signal);
  assert.ok(found.sources.some((s:any)=>s.id==='S1P1C151'));assert.ok(found.sources.length<50);assert.equal(answer.retrieval.total,200);
  const full=await panel.readCurrentPapers(panel.profile,'full paper',true,100000,answer,signal);
  assert.equal(full.sources.length,200);assert.equal(answer.retrieval.retrieved,200);
});

test('MiniMax receives question-focused paper evidence before choosing tools',async()=>{
  const {panel}=readingHarness(()=>''),source=panel.session.sources[0],reads:any[]=[],requests:any[]=[];
  Object.assign(panel.profile,newProfile('minimax'),{model:'MiniMax-M3',models:[{id:'MiniMax-M3',name:'MiniMax-M3'}],contextAuto:false});
  panel.availableModels=()=>[{id:'MiniMax-M3',name:'MiniMax-M3'}];
  panel.storage.getKey=()=> 'test-key';
  panel.draft='翻译 Robustness to Raw Demonstrations 一节';
  panel.readCurrentPapers=async(_p:any,query:string,full:boolean)=>{reads.push({query,full});return {text:'[S1P1C1] Paper · PDF 第 1 页\nRobustness to Raw Demonstrations',images:[],sources:[source]};};
  panel.generate=async(_p:any,input:any,onText:any)=>{requests.push(input);onText('该节讨论鲁棒性。[S1P1C1]');};
  await Panel.prototype.ask.call(panel);
  assert.deepEqual(reads,[{query:'翻译 Robustness to Raw Demonstrations 一节',full:false}]);
  assert.match(requests[0].messages.at(-1).content,/Robustness to Raw Demonstrations/);
  assert.match(requests[0].system,/无需再次询问用户是否允许调用/);
  assert.equal(panel.session.messages.at(-1).retrieval.retrieved,1);
  assert.equal(panel.session.messages.at(-1).error,undefined);
});

test('generation status appears below the current Inthes label and keeps it in view',()=>{
  const {panel}=harness([{role:'user',text:'Question'},{role:'assistant',text:''}]);
  panel.view='chat';panel.controller=new AbortController();panel.markdown=()=>'';panel.generatedImagesHTML=()=>'';panel.coverageHTML=()=>'';
  const markup=panel.messageHTML(panel.session.messages[1],1);
  assert.match(markup,/<div class="message-label">[\s\S]*INTHES<\/div><div class="message-progress" role="status"><\/div>/);
  let content='';const log={scrollHeight:100,scrollTop:0,clientHeight:100};
  const pending={closest:()=>log,classList:{toggle:()=>{}},set textContent(value:string){content=value;log.scrollHeight=120;}};
  const fallback={textContent:'old status'};
  panel.root={querySelector:(selector:string)=>selector.includes('.message-progress')?pending:fallback};
  panel.generationPhase='thinking';panel.waitStarted=Date.now();panel.updateStatus();
  assert.match(content,/思考中/);assert.equal(fallback.textContent,'');assert.equal(log.scrollTop,120);
});

test('switching connections or models keeps conversation context visible',async()=>{
  const first={...newProfile('minimax'),id:'minimax',model:'MiniMax-M3',models:[{id:'MiniMax-M3',name:'MiniMax-M3'},{id:'MiniMax-M4',name:'MiniMax-M4'}]};
  const second={...newProfile('deepseek'),id:'deepseek'};
  const panel=Object.create(Panel.prototype),attributes=new Map<string,string>();let markup='';
  const meter={getAttribute:(name:string)=>attributes.get(name),setAttribute:(name:string,value:string)=>attributes.set(name,value)};
  Object.assign(panel,{storage:{state:{profiles:[first,second],selected:first.id},save:async()=>{}},session:{id:'session',messages:[{role:'user',text:'Explain the method '.repeat(100)},{role:'assistant',text:'The method uses evidence.'}],sources:[],evidenceTokens:0,usage:{profileID:first.id,model:first.model,through:2,compaction:0,baseline:1000,context:22000,exact:true,reported:{contextTokens:22000}}},accounts:{forgetSession:()=>{}},root:{querySelector:(selector:string)=>selector==='#context-meter'?meter:null},html:(_el:any,value:string)=>{markup=value;},availableModels:()=>first.models,closeModelPicker:()=>{}});
  panel.refreshConnections=()=>panel.updateContextMeter();
  panel.updateContextMeter();assert.match(markup,/22k\/200k/);
  await panel.selectProfile(second.id);assert.doesNotMatch(markup,/>0\/200k</);assert.match(attributes.get('aria-label')!,/已用上下文 [1-9]/);
  await panel.selectProfile(first.id);assert.match(markup,/22k\/200k/);
  await panel.chooseModel('MiniMax-M4');assert.match(attributes.get('aria-label')!,/已用上下文 [1-9]/);
  await panel.chooseModel('MiniMax-M3');assert.match(markup,/22k\/200k/);
});

test('multiple local reads count unique supplied passages across the current answer',async()=>{
  const {panel}=readingHarness(()=>''),first=panel.session.sources[0],second={...first,id:'S1P2C1'};
  panel.session.sources.push(second);let calls=0;
  panel.readCurrentPapers=async()=>({text:'Evidence',images:[],sources:++calls===1?[first]:[first,second]});
  panel.generate=async(_p:any,_input:any,onText:any,_events:any,_conversation:any,tools:any)=>{
    for(let i=0;i<2;i++)await tools.execute({name:'read_current_papers',arguments:{query:'method',full:false}});
    onText('Answer [S1P2C1]');
  };
  await Panel.prototype.ask.call(panel);
  assert.equal(panel.session.messages.at(-1).retrieval.retrieved,2);assert.equal(panel.session.coverage,'本次检索 2 / 2 个来源片段');
});

test('native search and local reading clear a stale thinking phase',async()=>{
  const {panel}=readingHarness(()=>''),phases:any[]=[];
  panel.setGenerationPhase=(phase:any)=>phases.push(phase);
  panel.generate=async(_p:any,_input:any,onText:any,events:any,_conversation:any,tools:any)=>{
    events.onPhase('thinking');events.onSearch('DINOv2');assert.equal(phases.at(-1),undefined);events.onSearchCompleted();
    events.onPhase('thinking');await tools.execute({name:'read_current_papers',arguments:{query:'method',full:false}});assert.equal(phases.at(-1),undefined);
    onText('Local evidence [S1P1C1]');
  };
  await Panel.prototype.ask.call(panel);assert.equal(panel.session.messages.at(-1).error,undefined);
});

test('image-related requests reach the model with the actual connection capabilities',async()=>{
  for(const preset of ['custom','antigravity-account','codex-account'])for(const query of ['根据当前文献生成一张图','不要画图，只解释图像生成原理','给我生成图片的 Python 代码']){
    const {panel}=readingHarness(()=>''),requests:any[]=[];
    Object.assign(panel.profile,newProfile(preset),{model:'model',baseURL:'https://example.com/v1',contextAuto:false,reasoning:''});
    panel.session.papers=[];panel.session.sources=[];panel.draft=query;panel.generate=Panel.prototype.generate;
    panel.storage.getKey=()=> 'test-key';
    panel.accounts.ask=async(_p:any,input:any,_signal:any,onText:any)=>{requests.push(input);onText('模型理解后的回答');};
    panel.win.fetch=async(_url:string,init:any)=>{const body=JSON.parse(init.body);requests.push({system:body.messages[0].content,messages:body.messages.slice(1)});return Response.json({choices:[{message:{content:'模型理解后的回答'},finish_reason:'stop'}]});};
    await Panel.prototype.ask.call(panel);
    assert.equal(panel.session.messages.at(-1).error,undefined);assert.equal(requests.length,1);
    assert.ok(requests[0].messages.at(-1).content.includes(query));assert.equal(panel.session.messages.at(-1).text,'模型理解后的回答');
    if(preset==='codex-account')assert.doesNotMatch(requests[0].system,/不提供图片生成工具/);
    else {assert.match(requests[0].system,/不提供图片生成工具/);assert.match(requests[0].system,/提供绘图代码或提示词不受此限制/);}
  }
});

test('direct reading rejects nonexistent citations and synchronizes valid normalized answers',async()=>{
  for(const [reference,valid] of [['[S999P1C1]',false],['[S1P1P1]',true],['`[S999P1C1]`',false],['`[S1P1P1]`',true]] as const){
    const h=readingHarness(()=>`Answer ${reference}`);await Panel.prototype.ask.call(h.panel);
    const answer=h.panel.session.messages.at(-1);
    if(valid){assert.equal(answer.error,undefined);assert.equal(answer.text,'Answer [S1P1C1]');assert.equal(h.snapshots[0].history.at(-1).content,answer.text);}
    else {assert.match(answer.error,/未提供/);assert.equal(answer.partial,true);assert.equal(h.snapshots.length,0);}
  }
});

test('direct reading rejects existing but unprovided sources while retaining valid history citations',async()=>{
  const h=readingHarness(()=>`Answer [S1P2C1]`);
  h.panel.profile.contextTokens=8000;h.panel.profile.contextAuto=false;h.panel.profile.maxTokens=50;
  h.panel.session.sources.push({id:'S1P2C1',itemID:1,title:'Long',text:'无关'.repeat(6000)});
  await Panel.prototype.ask.call(h.panel);assert.match(h.panel.session.messages.at(-1).error,/未提供/);
  h.panel.session.messages=[{role:'user',text:'以前的问题'},{role:'assistant',text:'以前已阅读的证据 [S1P2C1]'}];h.panel.draft='追问';
  await Panel.prototype.ask.call(h.panel);assert.equal(h.panel.session.messages.at(-1).error,undefined);
  assert.match(h.requests.at(-1).messages.at(-1).content,/\[S1P2C1\] Long/);
  assert.match(h.requests.at(-1).messages.at(-1).content,/无关/);
  h.panel.session.messages=h.panel.session.messages.slice(0,2);h.panel.session.compaction={summary:'较早对话已压缩，无原文引用。',through:2,count:1};h.panel.draft='再次追问';
  await Panel.prototype.ask.call(h.panel);assert.match(h.panel.session.messages.at(-1).error,/未提供/);
});

test('chunk summaries reject invalid citations before synthesis',async()=>{
  const h=readingHarness(()=>`Summary [S999P1C1]`);h.panel.profile.contextTokens=8000;h.panel.profile.contextAuto=false;h.panel.profile.maxTokens=50;
  h.panel.session.sources[0].text='正文'.repeat(6000);
  await Panel.prototype.ask.call(h.panel,true);assert.equal(h.requests.length,1);assert.match(h.panel.session.messages.at(-1).error,/未提供/);
});

test('explicit summaries bind native continuation to the supplied evidence',async()=>{
  const h=readingHarness(()=>''),requests:any[]=[];
  h.panel.generate=async(_p:any,input:any,onText:any,_events:any,conversation:any)=>{requests.push({input,conversation});onText('Summary [S1P1C1]');};
  await Panel.prototype.ask.call(h.panel,true);assert.equal(h.panel.session.messages.at(-1).error,undefined);
  assert.match(requests[0].conversation.evidence,/Evidence/);assert.ok(requests[0].input.messages.at(-1).content.includes(requests[0].conversation.evidence));
});

test('library follow-ups omit empty images and retain normalized account history',async()=>{
  const h=readingHarness(()=>`Answer [S1P1P1]`);h.panel.session.remember=false;h.panel.session.library=libraryState(h.panel.session.papers,'Papers');
  await h.panel.askLibrary(h.panel.profile,'first',[]);await h.panel.askLibrary(h.panel.profile,'second',[]);
  assert.equal(h.panel.session.title,'Paper');
  assert.equal(h.panel.session.messages.at(-1).error,undefined);assert.equal(h.requests.length,2);
  assert.equal(h.requests[0].messages.at(-1).images,undefined);
  assert.equal(JSON.stringify(h.requests[1].messages.slice(0,-1)),JSON.stringify(h.snapshots[0].history));
});

test('hidden and collapsed library results do not render Markdown; opened results update only on change',()=>{
  const h=readingHarness(()=>''),panel=h.panel;let markdown=0,changes=0,timer!:()=>void;
  panel.session.library=libraryState(panel.session.papers,'Papers');panel.session.library.currentJob='job';
  const item={paperID:1,state:'done',notes:[],result:'Answer'};
  panel.session.library.jobs=[{id:'job',question:'Question',items:[item]}];
  panel.markdown=()=>{markdown++;return '<p>Answer</p>';};panel.html=()=>changes++;
  const body={},summary={},task={},row={dataset:{paper:'1'},open:false,querySelector:(s:string)=>s==='summary'?summary:body};
  const list={hidden:true,querySelectorAll:()=>[row],querySelector:()=>task};
  panel.root={querySelector:(s:string)=>s==='.library-papers'?list:null};panel.selectMenu={refresh:()=>{}};
  panel.win.setTimeout=(fn:()=>void)=>{timer=fn;return 1;};panel.updateLibraryProgress=Panel.prototype.updateLibraryProgress;
  panel.updateLibraryProgress();timer();assert.equal(markdown,0);assert.equal(changes,0);
  assert.doesNotMatch(panel.libraryPapersHTML(),/<p>Answer/);assert.equal(markdown,0);
  list.hidden=false;panel.refreshLibraryPapers();assert.equal(markdown,0);
  row.open=true;panel.refreshLibraryPapers();assert.equal(markdown,1);
  panel.refreshLibraryPapers();assert.equal(markdown,1);
  item.result='Changed';panel.refreshLibraryPapers();assert.equal(markdown,2);
});

test('natural questions use the same tool-capable entry point without reading PDFs eagerly',async()=>{
  for(const preset of ['codex-account','antigravity-account','custom'])for(const selected of [true,false]){
    const h=readingHarness(()=>''),panel=h.panel;Object.assign(panel.profile,newProfile(preset),{model:'model',contextAuto:false});
    if(!selected)panel.session.papers=[];panel.session.sources=[];panel.draft='这个方向最近三年有哪些新进展？';
    panel.preparePapers=async()=>{throw Error('must not parse before tool choice');};let offered:any;
    panel.generate=async(_p:any,_input:any,onText:any,_events:any,_conversation:any,tools:any)=>{offered=tools;onText('Response');};
    await Panel.prototype.ask.call(panel);assert.equal(panel.session.messages.at(-1).error,undefined);
    assert.equal(offered.webSearch,preset!=='custom');assert.equal(offered.definitions.some((t:any)=>t.name==='read_current_papers'),selected);
    assert.ok(offered.definitions.some((t:any)=>t.name==='resolve_research_papers'));assert.equal(panel.session.sources.length,0);
  }
});

test('account turns can switch between reading and native search without switching conversation or tools',async()=>{
  for(const protocol of ['codex-account','antigravity-account']){
    const h=readingHarness(()=>''),panel=h.panel,requests:any[]=[];Object.assign(panel.profile,newProfile(protocol),{model:'model'});
    panel.generate=async(_p:any,input:any,onText:any,events:any,conversation:any,tools:any)=>{
      requests.push({input,conversation,tools});
      if(requests.length===1){await tools.execute({id:'read',name:'read_current_papers',arguments:{query:'method',full:false}});onText('Method [S1P1C1]');}
      else if(requests.length===2){events.onSearch('recent work');events.onSearchCompleted();onText('[Related paper](https://arxiv.org)');}
      else onText('Follow-up [S1P1C1]');
    };
    for(const query of ['解释这篇论文的方法','这个方向最近有哪些进展？','回到刚才那篇，方法有什么局限']){panel.draft=query;await Panel.prototype.ask.call(panel);assert.equal(panel.session.messages.at(-1).error,undefined);}
    assert.equal(requests.length,3);assert.equal(requests[0].conversation.id,requests[2].conversation.id);
    assert.equal(requests[0].input.system,requests[2].input.system);assert.deepEqual(requests[0].tools.definitions,requests[2].tools.definitions);
    assert.equal(JSON.stringify(requests[1].input.messages.slice(0,-1)),JSON.stringify(h.snapshots[0].history));assert.equal(h.snapshots.at(-1).history.length,6);
  }
});

test('enabling search on an unsupported API does not block reading but reports a requested search failure',async()=>{
  const h=readingHarness(()=>''),panel=h.panel;Object.assign(panel.profile,newProfile('deepseek'),{model:'model',webSearch:true,contextAuto:false,reasoning:''});
  panel.storage.getKey=()=> 'test-key';panel.win.fetch=async()=>{throw Error('unsupported service must not be contacted');};
  panel.generate=async(_p:any,_input:any,onText:any,_events:any,_conversation:any,tools:any)=>{await tools.execute({id:'read',name:'read_current_papers',arguments:{query:'method',full:false}});onText('Method [S1P1C1]');};
  await Panel.prototype.ask.call(panel);assert.equal(panel.session.messages.at(-1).error,undefined);
  panel.draft='这个方向最近有什么新进展？';panel.generate=async(_p:any,_input:any,_onText:any,_events:any,_conversation:any,tools:any)=>{await tools.execute({id:'search',name:'search_research_papers',arguments:{query:'recent research'}});};
  await Panel.prototype.ask.call(panel);assert.match(panel.session.messages.at(-1).error,/不支持|未接入/);
});

test('library turns offer reading and research together without resuming on a keyword alone',async()=>{
  const h=readingHarness(()=>''),panel=h.panel;panel.session.remember=false;panel.session.library=libraryState(panel.session.papers,'Papers');
  panel.session.library.jobs=[{id:'paused',question:'Old question',paperIDs:[1],items:[],status:'paused'}];panel.session.library.currentJob='paused';
  panel.generate=async(_p:any,_input:any,onText:any,events:any,_conversation:any,tools:any)=>{
    for(const name of ['resume_analysis','read_papers','resolve_research_papers','import_research_papers'])assert.ok(tools.definitions.some((t:any)=>t.name===name));
    events.onSearch('new developments');events.onSearchCompleted();onText('External findings');
  };
  await panel.askLibrary(panel.profile,'继续聊聊最新进展',[]);
  assert.equal(panel.session.messages.at(-1).error,undefined);assert.equal(panel.session.library.jobs[0].status,'paused');
});

test('late local tools preserve all results and surface errors after an early native completion',async()=>{
  for(const fail of [false,true]){
    const h=readingHarness(()=>''),panel=h.panel;let requests=0;
    panel.readCurrentPapers=async()=>{await new Promise(r=>setTimeout(r,5));if(fail)throw Error('PDF read failed');return {text:'Local evidence [S1P1C1]',sources:panel.session.sources,images:[]};};
    panel.researchTools=()=>({instructions:'Research',run:{pendingTools:0,settle:async()=>{},checkSearch:()=>{},report:()=>'',withTools:(local:any)=>({definitions:[...local.definitions,{name:'search_research_papers'}],execute:async(call:any)=>call.name==='read_current_papers'?local.execute(call):{text:'Web evidence'}})}});
    panel.generate=async(_p:any,input:any,onText:any,_events:any,_conversation:any,tools:any)=>{
      if(++requests===1){await tools.execute({id:'search',name:'search_research_papers',arguments:{}});void tools.execute({id:'read',name:'read_current_papers',arguments:{query:'method',full:false}}).catch(()=>{});onText('Still waiting');}
      else {assert.match(input.messages.at(-1).content,/Web evidence/);assert.match(input.messages.at(-1).content,/Local evidence/);onText('Combined answer [S1P1C1]');}
    };
    await Panel.prototype.ask.call(panel);
    if(fail){assert.equal(requests,1);assert.match(panel.session.messages.at(-1).error,/PDF read failed/);}
    else {assert.equal(requests,2);assert.equal(panel.session.messages.at(-1).text,'Combined answer [S1P1C1]');assert.equal(panel.session.messages.at(-1).error,undefined);}
  }
});

test('quota polling continues during generation and avoids inactive hidden panels',()=>{
  const {panel}=harness();let queries=0;
  panel.accounts.refreshQuota=async()=>{queries++;};
  panel.host={isConnected:true,getBoundingClientRect:()=>({width:380})};panel.view='chat';
  panel.pollAccountQuota();assert.equal(queries,1);
  panel.host.getBoundingClientRect=()=>({width:0});panel.pollAccountQuota();assert.equal(queries,1);
  panel.controller=new AbortController();panel.view='settings';panel.pollAccountQuota();assert.equal(queries,2);
  panel.controller=undefined;panel.pollAccountQuota();assert.equal(queries,2);
  panel.host.isConnected=false;panel.controller=new AbortController();panel.pollAccountQuota();assert.equal(queries,2);
});

test('retry redraws removed messages before generation preflight can return',async()=>{
  const h=harness([{role:'user',text:'Question',images:[{data:'image'}]},{role:'assistant',text:'Partial answer'}]);
  await h.panel.action('retry',{dataset:{}});
  assert.deepEqual(h.events,['forget','render','ask']);assert.equal(h.panel.session.messages.length,0);
  assert.equal(h.panel.draft,'Question');assert.equal(h.panel.draftImages[0].data,'image');
});

test('retry without a user question preserves the conversation',async()=>{
  const h=harness([{role:'assistant',text:'Keep me'}]);
  await h.panel.action('retry',{dataset:{}});
  assert.equal(h.panel.session.messages[0].text,'Keep me');assert.deepEqual(h.events,['没有可重试的提问']);
});

test('logout guidance does not clear saved models before exit is confirmed',async()=>{
  const h=harness(),p={...newProfile('antigravity-account'),models:[{id:'test',name:'Test'}]};let confirmed=false,saves=0;
  Object.assign(h.panel,{editing:{...p},modelOptions:p.models,readForm:()=>({p}),updateAccountView:()=>{}});
  h.panel.storage.state.profiles=[p];h.panel.storage.save=async()=>saves++;h.panel.accounts.logout=async()=>confirmed;
  await h.panel.action('logout',{dataset:{}});assert.equal(saves,0);assert.equal(p.models.length,1);assert.equal(h.panel.modelOptions.length,1);
  confirmed=true;await h.panel.action('logout',{dataset:{}});assert.equal(saves,1);assert.equal(p.models.length,0);assert.equal(h.panel.modelOptions.length,0);
});

test('stale history and connection actions preserve the active panel after another window deletes them',async()=>{
  for(const action of ['open-session','edit','remove-profile:missing']){
    const h=harness([{role:'user',text:'Keep me'}]),session=h.panel.session;
    await h.panel.action(action,{dataset:{id:'missing'}});
    assert.equal(h.panel.session,session);assert.equal(h.panel.editing,undefined);
    assert.equal(h.events[0],'render');assert.match(h.events[1],/已不存在/);assert.ok(!h.events.includes('forget'));
  }
});

test('image preview has no close button and dismisses only from blank areas or panel cleanup',()=>{
  for(const trigger of ['blank','backdrop','header','cleanup']){
    const h=harness(),handlers=new Map<string,(event:any)=>void>();let removed=false,focused=false,markup='';
    const image:any={},stage={},header={};
    const dialog={setAttribute:()=>{},querySelector:(selector:string)=>selector==='img'?image:null,addEventListener:(type:string,handler:(event:any)=>void)=>handlers.set(type,handler),showModal:()=>{},remove:()=>{removed=true;}};
    const target={querySelector:()=>({src:'blob:figure',alt:'生成图片 1'}),isConnected:true,focus:()=>{focused=true;}};
    Object.assign(h.panel,{win:{document:{createElementNS:()=>dialog},URL:{revokeObjectURL:()=>{}}},root:{append:()=>{}},html:(_el:any,text:string)=>{markup=text;},generatedURLs:new Map()});
    h.panel.previewGeneratedImage(target);
    assert.doesNotMatch(markup,/原始尺寸|适应窗口|image-viewer-zoom|image-viewer-close|<button/);assert.equal(image.src,'blob:figure');
    handlers.get('click')!({target:image});assert.equal(removed,false);
    let prevented=false;handlers.get('cancel')!({preventDefault:()=>{prevented=true;}});assert.equal(prevented,true);assert.equal(removed,false);
    if(trigger==='cleanup')h.panel.clearGeneratedURLs();
    else handlers.get('click')!({target:trigger==='blank'?stage:trigger==='backdrop'?dialog:header,stopPropagation:()=>{}});
    assert.equal(removed,true);assert.equal(focused,true);assert.equal(h.panel.closeImageViewer,undefined);
  }
});


test('account generation checkpoints native progress before sending and persists synchronized completion',async()=>{
  const {panel}=harness(),writes:any[]=[];
  Object.assign(panel.profile,newProfile('codex-account'),{model:'model'});
  Object.assign(panel,{controller:new AbortController(),win:{},showHistoryWarning:()=>{}});
  const checkpoint={protocol:'codex-account',profileID:panel.profile.id,id:'native-thread',fingerprint:'a'.repeat(64)};
  panel.session={id:'current',title:'Test',messages:[],sources:[],papers:[],continuation:checkpoint};
  panel.storage.storeSession=async(s:any)=>writes.push(structuredClone(s));
  let args:any;
  panel.accounts.ask=async(_p:any,_input:any,_signal:any,onText:any,_events:any,conversation:any)=>{
    args=conversation;assert.deepEqual(conversation.saved,checkpoint);assert.equal(conversation.persistent,true);
    await conversation.beforeTurn({...checkpoint,pending:true});assert.equal(writes.at(-1).continuation.pending,true);onText('answer');
  };
  await panel.generate(panel.profile,{system:'Read',messages:[{role:'user',content:'question'}]},()=>{}, {}, {id:'current',query:'question',evidence:'',compaction:0});
  panel.accounts.continuation=async()=>checkpoint;
  await panel.persist();assert.equal(writes.at(-1).continuation.pending,true);
  panel.controller=undefined;await panel.persist();assert.equal(writes.at(-1).continuation.pending,undefined);
  panel.session.messages.push({role:'assistant',text:'bad reference',error:'Invalid citation'});
  await panel.persist();assert.equal(writes.at(-1).continuation.pending,true);
  panel.session.remember=false;writes.length=0;
  panel.accounts.ask=async(_p:any,_input:any,_signal:any,_onText:any,_events:any,conversation:any)=>{args=conversation;};
  panel.controller=new AbortController();
  await panel.generate(panel.profile,{system:'Read',messages:[{role:'user',content:'question'}]},()=>{}, {}, {id:'worker',query:'question',evidence:'',compaction:0});
  assert.equal(args.persistent,undefined);assert.equal(args.saved,undefined);assert.equal(writes.length,0);
});
