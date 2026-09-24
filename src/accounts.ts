import type { AccountContinuation, ChatInput, GenerationEvents, ModelOption, Profile, ToolAccess, ToolOutput } from './types.ts';
import { continuationFingerprint } from './account-continuation.ts';
import { version } from '../package.json';
import type { Storage } from './storage.ts';
import { accountPrompt, discoveredVision, imageURL } from './images.ts';
import { modelDetails, readUsage } from './usage.ts';
import { abortable } from './abort.ts';
import { redactError } from './errors.ts';
import { Antigravity } from './antigravity.ts';
import { codexQuota, type AccountQuota } from './account-quota.ts';
import { balanceQuery, balanceUnavailable, fetchBalance } from './api-balance.ts';

const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
const { setTimeout: rpcSetTimeout, clearTimeout: rpcClearTimeout } = ChromeUtils.importESModule('resource://gre/modules/Timer.sys.mjs');
function runtimeArgs(value: string) {
  let args: unknown;
  try { args = JSON.parse(value || '[]'); } catch { throw new Error('运行组件参数必须是字符串数组'); }
  if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) throw new Error('运行组件参数必须是字符串数组');
  return args as string[];
}
class RPC {
  pending = new Map<number, { resolve: (value:any)=>void; reject:(e:Error)=>void; timer:any }>();
  listeners = new Set<(method:string, params:any)=>void>(); nextID = 1; closed = false;
  toolHandlers = new Map<string, (params:any) => Promise<ToolOutput>>();
  constructor(public process:any, public win:any) { void this.read(); void this.drainErrors(); }
  async drainErrors() { try { while (await this.process.stderr.readString()) { /* CLI diagnostics are intentionally not persisted with document history. */ } } catch(error) { if (!this.closed) Zotero.debug(`Inthes CLI stderr closed: ${(error as Error).name}`); } }
  async read() {
    let buffer='';
    try {
      while(true) {
        const chunk=await this.process.stdout.readString(); if(!chunk)break;buffer+=chunk;
        let index;
        while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(!line)continue;
          let msg;
          try { msg=JSON.parse(line); } catch { throw new Error('账户组件返回了无效的 JSON-RPC 数据，请更新或检查运行组件'); }
          if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('账户组件返回了无效的 JSON-RPC 消息');
          if(msg.method && msg.id!==undefined){
            // Only the active thread's Folio tools are callable. Do not block the
            // RPC reader while a tool makes nested model requests.
            if(msg.method==='item/tool/call'&&this.toolHandlers.has(msg.params?.threadId))void this.toolResponse(msg);
            else await this.send({jsonrpc:'2.0',id:msg.id,error:{code:-32601,message:'Inthes does not expose tools or filesystem access'}});
          } else if(msg.id!==undefined){const pending=this.pending.get(msg.id);if(pending){this.pending.delete(msg.id);rpcClearTimeout(pending.timer);if(msg.error)pending.reject(new Error(redactError(msg.error.message||'账户组件返回错误')));else pending.resolve(msg.result);}}
          else if(msg.method)for(const listener of this.listeners)listener(msg.method,msg.params);
        }
      }
      if(!this.closed)this.fail(new Error('账户组件已退出，请检查运行组件路径或重新登录'));
    }catch(error){if(!this.closed)this.fail(error instanceof Error?error:new Error(String(error)));}
  }
  send(msg:any){return this.process.stdin.write(JSON.stringify(msg)+'\n');}
  async toolResponse(msg:any) {
    let result;
    try {
      const output=await this.toolHandlers.get(msg.params.threadId)!(msg.params);
      result={success:true,contentItems:[{type:'inputText',text:output.text},...(output.images||[]).map(i=>({type:'inputImage',imageUrl:imageURL(i)}))]};
    } catch(error) { result={success:false,contentItems:[{type:'inputText',text:redactError(error)}]}; }
    if(!this.closed)try{await this.send({jsonrpc:'2.0',id:msg.id,result});}catch(error){this.fail(error as Error);}
  }
  request(method:string,params:any={},timeout=120000):Promise<any>{
    if(this.closed)return Promise.reject(new Error('账户组件已关闭，请重新连接'));
    const id=this.nextID++;
    return new Promise((resolve,reject)=>{const timer=rpcSetTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} 超时，请检查登录状态`));},timeout);this.pending.set(id,{resolve,reject,timer});void this.send({jsonrpc:'2.0',id,method,params}).catch((e:Error)=>this.fail(new Error(redactError(e))));});
  }
  notify(method:string,params:any={}){return this.send({jsonrpc:'2.0',method,params});}
  fail(error:Error){if(this.closed)return;this.closed=true;try{for(const p of this.pending.values()){rpcClearTimeout(p.timer);p.reject(error);}this.pending.clear();for(const fn of this.listeners)fn('folio/closed',{error:error.message});}finally{this.process.kill();}}
  close(){this.fail(new Error('账户组件已停止'));}
}

export interface AccountStatus { phase: 'checking' | 'signed-out' | 'pending' | 'signed-in' | 'error'; text: string; logoutPending?: boolean; }
export interface AccountConversation { id:string; compaction:number; evidence:string; query:string; figureCount?:number; restoreInput?:()=>Promise<ChatInput>; persistent?:boolean; saved?:AccountContinuation; beforeTurn?:(checkpoint?:AccountContinuation)=>Promise<void>; }
interface AccountThread { rpc:RPC; id:string; signature:string; history:string; busy:boolean; profileID?:string; persistent?:boolean; releasePending?:boolean; defaultEffort?:string; }
interface AccountClient { signature:string; rpc:RPC; cwd:string; home:string; }
export class Accounts {
  clients = new Map<string,{ signature:string; rpc:RPC; cwd:string; home:string }>();
  statuses = new Map<string, AccountStatus>();
  models = new Map<string, ModelOption[]>();
  listeners = new Set<(id:string)=>void>();
  threads = new Map<string,AccountThread>();
  private starting = new Map<string, { token: object; signature: string; work: Promise<AccountClient>; rpc?: RPC }>();
  private loginIDs = new Map<string, string>();
  quotas = new Map<string, AccountQuota>();
  private quotaRequests = new Map<string, Promise<void>>();
  private quotaChecks = new Map<string, number>();
  private quotaSources = new Map<string, string>();
  private quotaControllers = new Map<string, AbortController>();
  antigravity = new Antigravity(this);
  constructor(public storage:Storage, public win:any){}
  setStatus(id:string, status:AccountStatus) { this.statuses.set(id,{...status,text:redactError(status.text)}); for(const listener of this.listeners)listener(id); }
  async detectRuntime(p:Profile, force=false):Promise<{executable:string;args:string}|null> {
    if(p.protocol==='antigravity-account')return this.antigravity.detectRuntime(p,force);
    const resolve=async(command:string,args=p.args)=>{
      let path=command;
      if(!PathUtils.isAbsolute(path)) {
        try { path=await Subprocess.pathSearch(path); }
        catch(error) { if((error as any).errorCode===Subprocess.ERROR_BAD_EXECUTABLE)return null; throw error; }
      }
      if(!await IOUtils.exists(path))return null;
      if(/\.(cmd|bat|ps1)$/i.test(path)||(Zotero.isWin&&PathUtils.filename(path).toLowerCase()==='codex')) {
        // Windows pathSearch can return npm's extensionless shell shim as well as .cmd.
        const packageDir=PathUtils.join(PathUtils.parent(path),'node_modules','@openai','codex');
        const manifestPath=PathUtils.join(packageDir,'package.json');
        if(!await IOUtils.exists(manifestPath))return null;
        const manifest=await IOUtils.readJSON(manifestPath);
        const entry=typeof manifest.bin==='string'?manifest.bin:manifest.bin?.codex;
        if(typeof entry!=='string')return null;
        const script=PathUtils.join(packageDir,...entry.split(/[\\/]/));
        if(!await IOUtils.exists(script))return null;
        let node=PathUtils.join(PathUtils.parent(path),'node.exe');
        if(!await IOUtils.exists(node)) {
          try { node=await Subprocess.pathSearch(Zotero.isWin?'node.exe':'node'); }
          catch(error) { if((error as any).errorCode===Subprocess.ERROR_BAD_EXECUTABLE)return null; throw error; }
        }
        return {executable:node,args:JSON.stringify([script,...runtimeArgs(args)])};
      }
      return {executable:path,args};
    };
    if(p.executable&&!force) { const found=await resolve(p.executable); if(found)return found;if(p.executable!=='codex')return null; }
    const found=await resolve('codex','[]');if(found)return found;
    const local=Services.env.get('LOCALAPPDATA');
    if(local) {
      const dir=PathUtils.join(local,'OpenAI','Codex','bin');
      if(await IOUtils.exists(dir)) {
        const direct=await resolve(PathUtils.join(dir,'codex.exe'),'[]');if(direct)return direct;
        const candidates=[];
        for(const child of await IOUtils.getChildren(dir)) {
          if((await IOUtils.stat(child)).type!=='directory')continue;
          const path=PathUtils.join(child,'codex.exe');
          if(await IOUtils.exists(path))candidates.push({path,modified:(await IOUtils.stat(path)).lastModified});
        }
        candidates.sort((a,b)=>b.modified-a.modified);
        if(candidates.length)return {executable:candidates[0].path,args:'[]'};
      }
    }
    const roaming=Services.env.get('APPDATA');
    if(roaming) { const found=await resolve(PathUtils.join(roaming,'npm','codex.cmd'),'[]');if(found)return found; }
    if(Zotero.isMac) return resolve('/Applications/Codex.app/Contents/Resources/codex','[]');
    return null;
  }
  async client(p:Profile):Promise<AccountClient>{
    const signature=JSON.stringify([p.protocol,p.executable,p.args]);
    const starting = this.starting.get(p.id); if (starting?.signature===signature) return starting.work;
    if(starting)this.releaseProfile(p.id);
    const token = {}, entry = { token, signature, work: undefined as any, rpc: undefined as RPC | undefined };
    this.starting.set(p.id, entry);
    entry.work = this.createClient(p, token).finally(() => { if (this.starting.get(p.id) === entry) this.starting.delete(p.id); });
    return entry.work;
  }
  private async createClient(p:Profile, token:object):Promise<AccountClient>{
    const signature=JSON.stringify([p.protocol,p.executable,p.args]);const old=this.clients.get(p.id);
    if(old && old.signature===signature&&!old.rpc.closed)return old;
    this.clients.delete(p.id);old?.rpc.close();this.models.delete(p.id);
    const home=PathUtils.join(this.storage.dir,'accounts',p.id);const cwd=PathUtils.join(home,'workspace');
    await IOUtils.makeDirectory(cwd,{ignoreExisting:true,createAncestors:true});
    const runtime=await this.detectRuntime(p);
    if(!runtime)throw new Error('未找到运行组件。请手动填写路径，或按照安装说明安装后重新检测。');
    const executable=runtime.executable;
    const args=runtimeArgs(runtime.args);
    const environment: Record<string,string|null>={...await this.proxyEnvironment(),OPENAI_API_KEY:null,CODEX_HOME:home};
    args.push('app-server','--stdio','-c','features.shell_tool=false','-c','features.apply_patch_freeform=false','-c','web_search="disabled"','-c','mcp_servers={}');
    const process=await Subprocess.call({command:executable,arguments:args,workdir:cwd,environment,environmentAppend:true,stderr:'pipe'});
    const rpc=new RPC(process,this.win);
    if (this.starting.get(p.id)?.token !== token) { rpc.close(); throw new Error('连接已关闭'); }
    this.starting.get(p.id)!.rpc = rpc;
    try{await rpc.request('initialize',{clientInfo:{name:'folio_zotero',title:'Inthes',version},capabilities:{experimentalApi:true}});await rpc.notify('initialized');}
    catch(error){rpc.close();throw error;}
    if (this.starting.get(p.id)?.token !== token) { rpc.close(); throw new Error('连接已关闭'); }
    const client={signature,rpc,cwd,home};this.clients.set(p.id,client);
    let refreshing:Promise<void>|undefined;
      rpc.listeners.add((method,params)=>{
      if(this.clients.get(p.id)?.rpc!==rpc)return;
      if(method==='account/rateLimits/updated')void this.refreshQuota(p,true);
      if(method==='account/login/completed')this.loginIDs.delete(p.id);
      if(method==='account/login/completed'&&!params.success) { this.setStatus(p.id,{phase:'error',text:params.error||'登录未完成，请重试'});return; }
      if(method==='account/login/completed'||method==='account/updated') {
        // Both notifications can arrive together; one refresh handles the pair.
        refreshing ||= this.readAccount(p,rpc).then(async status=>{
          if(status.phase==='signed-in'){void this.refreshQuota(p,true);try { await this.listModels(p); } catch(error) { this.setStatus(p.id,{phase:'signed-in',text:`${status.text} · 获取模型失败，请重试`}); }}else {this.quotas.delete(p.id);for(const listener of this.listeners)listener(p.id);}
        }).catch(error=>{if(this.clients.get(p.id)?.rpc===rpc)this.setStatus(p.id,{phase:'error',text:(error as Error).message});}).finally(()=>{refreshing=undefined;});
      }
      if(method==='folio/closed')this.setStatus(p.id,{phase:'error',text:'运行组件已退出；重新打开连接即可恢复'});
    });
    return client;
  }
  async proxyEnvironment():Promise<Record<string,string>> {
    const home=Services.env.get('CODEX_HOME')||PathUtils.join(Services.dirsvc.get('Home',Ci.nsIFile).path,'.codex');
    const file=PathUtils.join(home,'.env');
    if(!await IOUtils.exists(file))return {};
    const environment:Record<string,string>={};
    // Share network settings only; Folio keeps its own account state and credentials.
    for(const line of (await IOUtils.readUTF8(file)).split(/\r?\n/)) {
      const match=line.match(/^\s*(?:export\s+)?(HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY)\s*=\s*(.*?)\s*$/i);
      if(!match)continue;
      const key=match[1].toUpperCase();let value=match[2];
      if(/^["']/.test(value)) {
        const quoted=value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
        if(!quoted)throw new Error(`Codex .env 中的 ${key} 引号不完整，请检查配置`);
        value=quoted[2];
      }else value=value.replace(/\s+#.*$/,'').trim();
      environment[key]=value;environment[key.toLowerCase()]=value;
    }
    return environment;
  }
  async readAccount(p:Profile,rpc:RPC):Promise<AccountStatus> {
    const {account}=await rpc.request('account/read',{});
    if(rpc.closed)throw new Error('连接已关闭');
    const status:AccountStatus=account ? {phase:'signed-in',text:`已登录 ChatGPT${account.email?` · ${account.email}`:''}`} : {phase:'signed-out',text:'尚未登录'};
    this.setStatus(p.id,status);return status;
  }
  async connect(p:Profile,login=false){
    if(p.protocol==='antigravity-account') {
      const status=await this.antigravity.connect(p,login);if(status.phase==='signed-in')void this.refreshQuota(p,true);return status;
    }
    if(this.statuses.get(p.id)?.phase==='pending'&&this.clients.get(p.id)?.signature===JSON.stringify([p.protocol,p.executable,p.args]))return this.statuses.get(p.id)!;
    this.setStatus(p.id,{phase:'checking',text:'正在检查登录状态…'});
    try {
    const {rpc}=await this.client(p);
    const status=await this.readAccount(p,rpc);
    if(login&&status.phase!=='signed-in') {
      const result=await rpc.request('account/login/start',{type:'chatgpt'});
      const url=new URL(result.authUrl);
      if(url.protocol!=='https:'||url.username||url.password||!['openai.com','chatgpt.com'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))throw new Error('账户组件返回了非官方登录地址，已阻止打开');
      if (result.loginId) this.loginIDs.set(p.id, result.loginId);
      if(this.statuses.get(p.id)?.phase!=='signed-in')this.setStatus(p.id,{phase:'pending',text:'等待浏览器授权，完成后将自动更新…'});
      Zotero.launchURL(url.href);
    }
    if(status.phase==='signed-in')void this.refreshQuota(p);
    return this.statuses.get(p.id)!;
    } catch(error) { this.setStatus(p.id,{phase:'error',text:(error as Error).message});throw error; }
  }
  async listModels(p:Profile):Promise<ModelOption[]> {
    if(p.protocol==='antigravity-account')return this.antigravity.listModels(p);
    const {rpc}=await this.client(p);const models:ModelOption[]=[];
    const status=await this.readAccount(p,rpc);if(status.phase!=='signed-in')throw new Error('请先登录账户，再获取可用模型');
    let cursor:string|null=null;const cursors=new Set<string>();
    do {
      const result=await rpc.request('model/list',{limit:100,includeHidden:false,...(cursor?{cursor}:{})});
      if(!Array.isArray(result.data)||result.data.some((m:any)=>!m||typeof(m.model||m.id)!=='string')||(result.nextCursor!=null&&typeof result.nextCursor!=='string'))throw new Error('账户组件返回了无效的模型列表');
      models.push(...result.data.map((m:any)=>({id:m.model||m.id,name:m.displayName||m.model||m.id,...discoveredVision(m),...modelDetails(m)})));cursor=result.nextCursor;
      if(cursor){if(cursors.has(cursor)||cursors.size>=100)throw new Error('模型列表分页异常，请更新运行组件后重试');cursors.add(cursor);}
    } while(cursor);
    if(rpc.closed)throw new Error('连接已关闭');
    this.models.set(p.id,models);for(const listener of this.listeners)listener(p.id);return models;
  }
  private release(thread:AccountThread) {
    if(thread.busy){thread.releasePending=true;return;}
    if(!thread.rpc.closed)void thread.rpc.request('thread/unsubscribe',{threadId:thread.id}).catch(error=>Zotero.debug(`Inthes thread cleanup: ${error.message}`));
  }
  forgetSession(id:string) {this.antigravity.forgetSession(id);const thread=this.threads.get(id);this.threads.delete(id);if(thread)this.release(thread);}
  updateHistory(id:string,history:ChatInput['messages']) {
    this.antigravity.updateHistory(id,history);
    const thread=this.threads.get(id);if(thread&&!thread.busy)thread.history=JSON.stringify(history);
  }
  async continuation(id:string):Promise<AccountContinuation|undefined> {
    const thread=this.threads.get(id);
    if(!thread)return this.antigravity.continuation(id);
    if(thread.busy||!thread.persistent||!thread.history)return;
    return {protocol:'codex-account',profileID:thread.profileID!,id:thread.id,fingerprint:await continuationFingerprint(thread.signature,thread.history)};
  }
  async discardContinuation(saved:AccountContinuation) {
    if(saved.protocol==='antigravity-account'){await this.antigravity.discardContinuation(saved);return;}
    const profile=this.storage.state.profiles.find(p=>p.id===saved.profileID&&p.protocol==='codex-account');
    if(!profile)throw new Error('原 ChatGPT 连接已移除或改为其他类型，无法调用原组件清理记录');
    const {rpc}=await this.client(profile);
    try {await rpc.request('thread/delete',{threadId:saved.id});}
    catch(error){if(!/(?:not found|no rollout|does not exist)/i.test((error as Error).message))throw error;}
  }
  async cleanupContinuation(saved:AccountContinuation):Promise<string|undefined> {
    try {await this.discardContinuation(saved);}
    catch(error){
      const location=saved.protocol==='antigravity-account'?PathUtils.join(this.storage.dir,'accounts',saved.profileID,'antigravity','sessions',saved.home!):`ChatGPT thread ${saved.id}（连接 ${saved.profileID}）`;
      const warning=`旧组件记录未能清理，本地操作可继续。待清理：${location}。${redactError(error)}`;
      Zotero.debug(warning);return warning;
    }
  }
  releaseProfile(id:string) {
    this.antigravity.releaseProfile(id);this.quotas.delete(id);this.quotaRequests.delete(id);this.quotaChecks.delete(id);this.quotaSources.delete(id);this.quotaControllers.get(id)?.abort();this.quotaControllers.delete(id);
    const client = this.clients.get(id), starting = this.starting.get(id);
    this.starting.delete(id); this.clients.delete(id);
    for (const [session, thread] of this.threads) if (thread.rpc === client?.rpc || thread.rpc === starting?.rpc) { this.threads.delete(session); this.release(thread); }
    starting?.rpc?.close(); client?.rpc.close();
    this.models.delete(id); this.statuses.delete(id); this.loginIDs.delete(id);
  }
  async logout(p:Profile) {
    if(p.protocol==='antigravity-account') {if(!await this.antigravity.logout(p))return false;this.models.delete(p.id);this.quotas.delete(p.id);this.quotaRequests.delete(p.id);this.quotaChecks.delete(p.id);for(const fn of this.listeners)fn(p.id);return true;}
    const { rpc } = await this.client(p);
    const loginId = this.loginIDs.get(p.id);
    if (loginId) await rpc.request('account/login/cancel', { loginId });
    await rpc.request('account/logout', {});
    this.releaseProfile(p.id);
    this.setStatus(p.id, { phase: 'signed-out', text: '已退出登录；此连接的专用登录凭据已清除' });
    return true;
  }
  async ask(p:Profile,input:ChatInput,signal:AbortSignal,onText:(text:string)=>void,events:GenerationEvents={},conversation?:AccountConversation,tools?:ToolAccess){
    if(p.protocol==='antigravity-account') {await this.antigravity.ask(p,input,signal,onText,events,conversation,tools);void this.refreshQuota(p);return;}
    events.onPhase?.('connecting');
    signal.throwIfAborted();const {rpc,cwd}=await abortable(this.client(p),signal);signal.throwIfAborted();
    const signature=JSON.stringify([p.id,p.model,input.system,conversation?.compaction,conversation?.evidence,conversation?.figureCount,tools?.definitions,tools?.webSearch]);
    const history=input.messages.slice(0,-1),last=input.messages.at(-1)!;
    const userLast={...last};
    if(conversation?.figureCount){const images=last.images!.slice(0,-conversation.figureCount);if(images.length)userLast.images=images;else delete userLast.images;}
    let thread=conversation?this.threads.get(conversation.id):undefined;
    let reuse=!!(thread&&thread.rpc===rpc&&!thread.busy&&thread.signature===signature&&thread.history===JSON.stringify(history));
    const saved=conversation?.saved;
    const resume=!reuse&&!saved?.pending&&saved?.protocol==='codex-account'&&saved.profileID===p.id&&saved.fingerprint===await continuationFingerprint(signature,JSON.stringify(history));
    let restored=input;
    signal.throwIfAborted();
    if(!reuse){
      if(conversation)this.forgetSession(conversation.id);
      const account=await abortable(rpc.request('account/read',{}),signal);signal.throwIfAborted();if(!account.account)throw new Error('请先在连接设置中登录 ChatGPT 账户');
      if(saved&&!resume){await conversation?.beforeTurn?.();void this.cleanupContinuation(saved).then(warning=>{if(warning)events.onWarning?.(warning);});}
      if(resume||history.length)events.onPhase?.('restoring');
      const starting=rpc.request(resume?'thread/resume':'thread/start',{...(resume?{threadId:saved!.id,excludeTurns:true}:{ephemeral:!conversation?.persistent,...(tools?{dynamicTools:tools.definitions.map(t=>({type:'function',name:t.name,description:t.description,inputSchema:t.parameters}))}:{})}),...(p.model?{model:p.model}:{}),cwd,approvalPolicy:'never',sandbox:'read-only',baseInstructions:input.system,config:{web_search:tools?.webSearch?'live':'disabled','features.shell_tool':false,'features.apply_patch_freeform':false}}).then(result=>{if(signal.aborted)this.release({rpc,id:result.thread.id,signature,history:'',busy:false});return result;});
      let result;
      try { result=await abortable(starting,signal); }
      catch(error){
        if(resume&&!signal.aborted){
          if(/(?:not found|no rollout|does not exist)/i.test((error as Error).message)){await conversation?.beforeTurn?.();throw new Error('ChatGPT 官方会话记录已丢失，请重试以从已保存的对话重建上下文');}
          throw new Error(`无法恢复 ChatGPT 会话，请重试：${(error as Error).message}`);
        }
        throw error;
      }
      signal.throwIfAborted();
      if(result.approvalPolicy!=='never'||result.sandbox?.type!=='readOnly'){
        this.release({rpc,id:result.thread.id,signature,history:'',busy:false});
        throw new Error('账户组件未启用所要求的只读权限，已停止发送文献；请更新或检查组件配置');
      }
      thread={rpc,id:result.thread.id,signature,history:'',busy:false,profileID:p.id,persistent:!!conversation?.persistent,defaultEffort:result.reasoningEffort};
      if(conversation)this.threads.set(conversation.id,thread);
      reuse=!!resume;
    }
    const active=thread!;active.busy=true;let output='';let succeeded=false;
    try {
      if(!reuse&&conversation?.restoreInput)restored=await conversation.restoreInput();
      signal.throwIfAborted();
      // Invalidate the disk checkpoint before the native history can advance.
      if(conversation?.persistent)await conversation.beforeTurn?.({protocol:'codex-account',profileID:p.id,id:active.id,fingerprint:await continuationFingerprint(signature,JSON.stringify(history)),pending:true});signal.throwIfAborted();
      await new Promise<void>((resolve,reject)=>{
        let turnId:string|undefined,finished=false,imageWork=Promise.resolve(),imageError:Error|undefined,imageCount=0;
        const imageIDs=new Set<string>(),messageDeltas=new Map<string,string>();
        const interrupt=()=>{if(turnId)void rpc.request('turn/interrupt',{threadId:active.id,turnId}).catch(error=>Zotero.debug(`Inthes interrupt: ${error.message}`));};
        const finish=(error?:Error)=>{if(finished)return;finished=true;rpc.listeners.delete(listener);signal.removeEventListener('abort',abort);error?reject(error):resolve();};
        const abort=()=>{interrupt();finish(new Error('生成已停止'));};
        if(tools)rpc.toolHandlers.set(active.id,async params=>{
          signal.throwIfAborted();
          if(finished||params.turnId!==turnId||params.namespace||!tools.definitions.some(t=>t.name===params.tool))throw new Error('不允许的工具调用');
          try {return await tools.execute({id:params.callId,name:params.tool,arguments:params.arguments});}
          catch(error){interrupt();finish(error as Error);throw error;}
        });
        const listener=(method:string,params:any)=>{
          if(method==='folio/closed'){finish(new Error(params.error));return;}
          if(params.threadId!==active.id)return;
          if(method==='thread/closed'){finish(new Error('账户会话已关闭，请重试'));return;}
          if(method==='turn/started')turnId=params.turn.id;
          if(turnId&&params.turnId&&params.turnId!==turnId)return;
          if(method==='error'&&!params.willRetry){finish(new Error(redactError(params.error?.message||'账户服务返回错误')));return;}
          if(method==='thread/tokenUsage/updated'){const usage=readUsage('codex-account',params);if(usage)events.onUsage?.(usage);}
          if(method==='item/started'&&params.item?.type==='webSearch')events.onSearch?.(params.item.query||'');
          if(method==='item/completed'&&params.item?.type==='webSearch'&&params.item.action?.type==='search')events.onSearchCompleted?.();
          if(method==='item/started'&&params.item?.type==='reasoning')events.onPhase?.('thinking');
          if(method==='item/reasoning/summaryTextDelta'){events.onPhase?.('thinking');}
          if(method==='item/agentMessage/delta'){messageDeltas.set(params.itemId,(messageDeltas.get(params.itemId)||'')+params.delta);events.onPhase?.('answering');output+=params.delta;onText(params.delta);}
          if(method==='item/completed'&&params.item?.type==='agentMessage'){
            const text=params.item.text||'',seen=messageDeltas.get(params.item.id)||'';
            if(text.startsWith(seen)&&text.length>seen.length){const remaining=text.slice(seen.length);output+=remaining;onText(remaining);messageDeltas.set(params.item.id,text);}
          }
          if(method==='item/started'&&params.item?.type==='imageGeneration')events.onPhase?.('imaging');
          if(method==='item/completed'&&params.item?.type==='imageGeneration'&&!imageIDs.has(params.item.id)){
            const item=params.item;imageIDs.add(item.id);
            imageWork=imageWork.then(async()=>{
              if(finished||signal.aborted)return;
              if(item.status!=='completed'||!item.result)throw new Error(item.failure?.type==='usageLimitExceeded'?'图片生成额度不足，请稍后重试。':'图片生成未完成，请重试。');
              if(!events.onImage)throw new Error('当前操作无法接收生成的图片，请在对话中请求生图。');
              await events.onImage(item.result);imageCount++;
            }).catch(error=>{imageError=error;});
          }
          if(method==='turn/completed')void imageWork.then(()=>{
            if(finished)return;
            if(params.turn.status!=='completed')finish(new Error(params.turn.error?.message||`生成未完成：${params.turn.status}`));
            else if(imageError)finish(imageError);
            else if(!output&&!imageCount)finish(new Error('模型未返回文字或图片'));
            else {if(!output){output='已生成图片。';onText(output);}finish();}
          });
        };
        rpc.listeners.add(listener);signal.addEventListener('abort',abort,{once:true});
        if(signal.aborted){abort();return;}
        const prompt=reuse?{...input,messages:[{...userLast,content:conversation!.query}]}:restored;
        const effort=p.reasoning||this.models.get(p.id)?.find(m=>m.id===p.model)?.defaultReasoning||active.defaultEffort;
        void rpc.request('turn/start',{threadId:active.id,input:accountPrompt(prompt),summary:'none',...(effort?{effort}:{})}).then(result=>{turnId=result.turn.id;if(signal.aborted)interrupt();}).catch(finish);
      });
      active.history=JSON.stringify([...history,{...userLast,content:conversation?.query??last.content},{role:'assistant',content:output}]);succeeded=true;
    } finally {
      if(tools)rpc.toolHandlers.delete(active.id);
      active.busy=false;
      if(!succeeded||!conversation||active.releasePending){if(conversation&&this.threads.get(conversation.id)===active)this.threads.delete(conversation.id);this.release(active);}
    }
  }
  refreshQuota(p:Profile,force=false):Promise<void> {
    const account=p.protocol.includes('account'),key=account?'':this.storage.getKey(p.id);
    const source=JSON.stringify([p.protocol,p.baseURL,p.headers,p.balanceQuery,p.billingMode,p.billingMode==='token-plan'?p.model:'',p.executable,p.args,key]);
    if(this.quotaSources.get(p.id)!==source){this.quotaControllers.get(p.id)?.abort();this.quotaControllers.delete(p.id);this.quotaRequests.delete(p.id);this.quotaChecks.delete(p.id);this.quotas.delete(p.id);this.quotaSources.set(p.id,source);}
    const pending=this.quotaRequests.get(p.id);if(pending)return pending;
    const previous=this.quotas.get(p.id);if(!force&&Date.now()-(this.quotaChecks.get(p.id)||0)<60000)return Promise.resolve();
    if(!force&&previous?.notice)return Promise.resolve();
    this.quotaChecks.set(p.id,Date.now());
    let work!:Promise<void>;
    work=(async()=>{
      let timer:any,controller:AbortController|undefined;
      try {
        let quota:AccountQuota;
        if(account)quota=p.protocol==='antigravity-account'?await this.antigravity.quota(p):codexQuota(await (await this.client(p)).rpc.request('account/rateLimits/read',{},30000));
        else if(!balanceQuery(p))quota={groups:[],updated:Date.now(),notice:balanceUnavailable(p)};
        else {
          controller=new this.win.AbortController();this.quotaControllers.set(p.id,controller!);
          timer=rpcSetTimeout(()=>controller!.abort(),15000);
          quota=await fetchBalance(p,key,controller!.signal,this.win.fetch.bind(this.win));
        }
        // Keep synchronous unsupported results on the same publication path as network replies.
        await Promise.resolve();
        if(!quota.groups.length&&!quota.balance&&!quota.notice)throw new Error('服务未提供账户额度');
        if(this.quotaRequests.get(p.id)===work)this.quotas.set(p.id,quota);
      }catch(error){await Promise.resolve();if(this.quotaRequests.get(p.id)===work)this.quotas.set(p.id,{...previous,groups:previous?.groups||[],updated:previous?.updated||Date.now(),error:redactError(error,[key])});}
      finally{rpcClearTimeout(timer);if(controller&&this.quotaControllers.get(p.id)===controller)this.quotaControllers.delete(p.id);if(this.quotaRequests.get(p.id)===work){this.quotaRequests.delete(p.id);for(const fn of this.listeners)fn(p.id);}}
    })();
    this.quotaRequests.set(p.id,work);return work;
  }
  stop(){this.antigravity.stop();for(const id of new Set([...this.clients.keys(),...this.starting.keys(),...this.quotaSources.keys()]))this.releaseProfile(id);this.threads.clear();this.quotaRequests.clear();}
}
