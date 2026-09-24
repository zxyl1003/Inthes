import type { ChatInput, GenerationEvents, ModelOption, Profile, TokenUsage } from './types.ts';
import { discoveredVision, imageURL } from './images.ts';
import { isSiliconFlow, modelDetails, readUsage } from './usage.ts';
import { credentialValues, redactError } from './errors.ts';
import type { ToolTurn } from './tool-api.ts';

export function jsonObject(value: string, label: string): Record<string, any> {
  const result = JSON.parse(value || '{}');
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error(`${label}必须是 JSON 对象`);
  return result;
}
export function buildRequest(p: Profile, key: string, input: ChatInput) {
  const url = new URL(p.baseURL);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('端点须使用 HTTPS；本地服务可使用 HTTP');
  if (url.username || url.password || url.search || url.hash) throw new Error('Base URL 不能包含用户名、密码、查询参数或锚点');
  if (!p.model.trim()) throw new Error('请先获取并选择模型');
  if (!Number.isInteger(p.maxTokens) || p.maxTokens < 1) throw new Error('最大输出 token 必须是正整数');
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  let body: Record<string, any> = { model: p.model, stream: true };
  let suffix = '';
  const messages = input.messages.map(m=>({role:m.role,content:m.images?.length?[{type:'text',text:m.content},...m.images.map(i=>({type:'image_url',image_url:{url:imageURL(i)}}))]:m.content}));
  if (p.protocol === 'chat') {
    suffix = '/chat/completions'; body.messages = [{role:'system',content:input.system},...messages]; body[p.tokenField] = p.maxTokens;
    if (p.reasoning) {
      if (p.preset === 'openrouter') body.reasoning = { effort: p.reasoning };
      else body.reasoning_effort = p.reasoning;
    }
    if (p.preset === 'deepseek') body.thinking = { type: p.reasoning === 'none' ? 'disabled' : 'enabled' };
    if (p.preset === 'deepseek' && p.reasoning === 'none') delete body.reasoning_effort;
    if (isSiliconFlow(p)) {
      if (p.reasoning) body.enable_thinking = p.reasoning !== 'none';
      if (p.reasoning === 'none') delete body.reasoning_effort;
      if (p.thinkingBudget !== undefined) {
        if (!Number.isInteger(p.thinkingBudget) || p.thinkingBudget < 128 || p.thinkingBudget > 32768) throw new Error('硅基流动思考预算须为 128 至 32768 token');
        if (p.reasoning !== 'none') body.thinking_budget = p.thinkingBudget;
      }
    }
    headers.Authorization = `Bearer ${key}`;
  } else if (p.protocol === 'responses') {
    suffix = '/responses'; body.input = input.messages.map(m=>({role:m.role,content:m.images?.length?[{type:'input_text',text:m.content},...m.images.map(i=>({type:'input_image',image_url:imageURL(i),detail:'auto'}))]:m.content})); body.instructions = input.system;
    body.max_output_tokens = p.maxTokens; body.store = false;
    if (p.reasoning) body.reasoning = { effort: p.reasoning };
    headers.Authorization = `Bearer ${key}`;
  } else if (p.protocol === 'anthropic') {
    suffix = '/messages'; body.system = input.system; body.messages = input.messages.map(m=>({role:m.role,content:m.images?.length?[...m.images.map(i=>({type:'image',source:{type:'base64',media_type:i.mimeType,data:i.data}})),{type:'text',text:m.content}]:m.content})); body.max_tokens = p.maxTokens;
    if (p.reasoning && p.reasoning !== 'none') body.output_config = { effort: p.reasoning };
    if (p.reasoning === 'none') body.thinking = { type: 'disabled' };
    if (p.thinkingBudget) {
      if (p.thinkingBudget < 1024 || p.thinkingBudget >= p.maxTokens) throw new Error('思考预算须 ≥ 1024 且小于最大输出 token');
      body.thinking = { type: 'enabled', budget_tokens: p.thinkingBudget };
    }
    headers['x-api-key'] = key; headers['anthropic-version'] = '2023-06-01';
  } else if (p.protocol === 'gemini') {
    suffix = `/models/${encodeURIComponent(p.model.replace(/^models\//, ''))}:streamGenerateContent?alt=sse`;
    body = { systemInstruction: { parts: [{ text: input.system }] }, contents: input.messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content },...(m.images||[]).map(i=>({inlineData:{mimeType:i.mimeType,data:i.data}}))] })), generationConfig: { maxOutputTokens: p.maxTokens } };
    if (p.reasoning && p.reasoning !== 'none') body.generationConfig.thinkingConfig = { thinkingLevel: p.reasoning };
    if (p.reasoning === 'none') body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
    if (p.thinkingBudget !== undefined) body.generationConfig.thinkingConfig = { thinkingBudget: p.thinkingBudget };
    headers['x-goog-api-key'] = key;
  } else throw new Error('账户连接不使用 API 请求');
  const params = p.protocol === 'gemini' ? body.generationConfig : body;
  if (p.temperature !== undefined) params.temperature = p.temperature;
  if (p.topP !== undefined) params[p.protocol === 'gemini' ? 'topP' : 'top_p'] = p.topP;
  if (p.preset === 'openrouter' && p.openrouterProvider?.trim()) body.provider = { only: [p.openrouterProvider.trim()] };
  const extra = jsonObject(p.extra, '附加参数');
  for (const field of Object.keys(extra)) {
    if (['model', 'messages', 'input', 'instructions', 'system', 'systemInstruction', 'contents', 'stream', 'store'].includes(field)) throw new Error(`附加参数不能覆盖 ${field}`);
    if (field in body) throw new Error(`${field} 已由表单配置，请不要重复定义`);
  }
  Object.assign(body, extra);
  if(p.protocol==='chat'&&p.preset!=='openrouter'&&!('stream_options' in body))body.stream_options={include_usage:true};
  for (const [name, value] of Object.entries(jsonObject(p.headers, '附加请求头'))) {
    if (typeof value !== 'string' || /[\r\n]/.test(name + value)) throw new Error('请求头必须为字符串，且不能含换行');
    if (['authorization', 'x-api-key', 'x-goog-api-key', 'host', 'content-type'].includes(name.toLowerCase())) throw new Error(`请勿在附加请求头中覆盖 ${name}`);
    headers[name] = value;
  }
  return { url: p.baseURL.replace(/\/+$/, '') + suffix, body, headers };
}

export async function fetchModels(p:Profile,key:string,signal:AbortSignal,fetcher:typeof fetch):Promise<ModelOption[]> {
  try {
  const {headers}=buildRequest({...p,model:'model-list'},key,{system:'',messages:[]});
  const base=p.baseURL.replace(/\/+$/,'')+'/models';
  const models=new Map<string,ModelOption>();const cursors=new Set<string>();let cursor='';
  do {
    const url=new URL(base);
    if(cursor)url.searchParams.set(p.protocol==='gemini'?'pageToken':'after_id',cursor);
    const response=await fetcher(url.toString(),{headers,signal,credentials:'omit',redirect:'error'});
    if(!response.ok)throw new Error(`获取模型失败：HTTP ${response.status}，请检查连接配置后重试`);
    const data=await response.json();const entries=p.protocol==='gemini'?data.models:data.data;
    if(!Array.isArray(entries))throw new Error('服务未返回可识别的模型列表');
    for(const m of entries) {
      if(p.protocol==='gemini'&&Array.isArray(m.supportedGenerationMethods)&&!m.supportedGenerationMethods.includes('generateContent'))continue;
      const id=p.protocol==='gemini'?m.name?.replace(/^models\//,''):m.id;
      if(typeof id!=='string'||!id.trim())throw new Error('模型列表中缺少有效的模型标识');
      const label=m.displayName||m.display_name||m.name||id;
      models.set(id,{id,name:typeof label==='string'?label:id,...discoveredVision(m),...modelDetails(m)});
    }
    cursor=p.protocol==='gemini'?data.nextPageToken||'':p.protocol==='anthropic'&&data.has_more?data.last_id:'';
    if(p.protocol==='anthropic'&&data.has_more&&!cursor)throw new Error('模型列表缺少下一页标识');
    if(cursor){if(typeof cursor!=='string'||cursors.has(cursor))throw new Error('模型列表分页标识无效');cursors.add(cursor);}
  }while(cursor);
  return [...models.values()];
  } catch (error) { signal.throwIfAborted(); throw new Error(redactError(error, credentialValues(key, p.headers))); }
}

export class SSEParser {
  private buffer = '';
  push(chunk: string, end = false): string[] {
    this.buffer += chunk;
    const events: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = /\r?\n\r?\n/.exec(this.buffer))) {
      events.push(this.buffer.slice(0, match.index));
      this.buffer = this.buffer.slice(match.index + match[0].length);
    }
    if (end && this.buffer.trim()) { events.push(this.buffer); this.buffer = ''; }
    return events.map(e => e.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n')).filter(Boolean);
  }
}
export function retryDelay(header: string | null, attempt = 0, now = Date.now()) {
  if(header?.trim()) {
    const seconds=Number(header);
    if(Number.isFinite(seconds))return seconds>=0?Math.ceil(seconds*1000):5000*2**attempt;
    const date=Date.parse(header);if(Number.isFinite(date))return Math.max(0,date-now);
  }
  return 5000*2**attempt;
}
export function apiError(data: any, status?: number, retryAfter?: string | null) {
  const error=data?.error||data||{},metadata=error.metadata||{};
  const clean=(value:unknown)=>typeof value==='string'?redactError(value):'';
  const code=status||Number(error.code)||undefined;
  const message=clean(error.message||data?.message)||'模型服务返回错误';
  const provider=clean(metadata.provider_name||data?.provider);
  let raw=metadata.raw;
  if(typeof raw==='string'){try{raw=JSON.parse(raw);}catch{ /* Providers also return plain-text explanations. */ }}
  const detail=clean(typeof raw==='string'?raw:raw?.error?.message||raw?.message||raw?.detail?.message||raw?.detail);
  const lines=[`${code?`HTTP ${code} · `:''}${message}${provider?`（提供商：${provider}）`:''}`];
  if(detail&&detail!==message)lines.push(detail);
  if(code===429)lines.push(retryAfter?`服务要求等待约 ${Math.ceil(retryDelay(retryAfter)/1000)} 秒后再试。`:'服务暂时限流或容量不足，请稍后重试，或切换模型／提供商。');
  return new Error(lines.join('\n'));
}
export function readEvent(protocol: Profile['protocol'], data: any): { text?: string; thinking?: boolean; done?: boolean; limited?: boolean; reason?: string } {
  if (data.error || data.type === 'error') throw apiError(data);
  if (protocol === 'chat') {
    const c = data.choices?.[0];
    const delta=c?.delta??c?.message;
    const thinking=!!(delta?.reasoning||delta?.reasoning_content||delta?.reasoning_details?.some((r:any)=>(r.type==='reasoning.summary'||r.type==='reasoning.text')&&(r.summary||r.text)));
    return { text: delta?.content, thinking, done: !!c?.finish_reason, limited: c?.finish_reason === 'length', reason: c?.finish_reason };
  }
  if (protocol === 'responses') {
    if (['response.failed', 'response.incomplete'].includes(data.type)) throw new Error(data.response?.error?.message || `响应未完成：${data.response?.incomplete_details?.reason || data.type}`);
    return { text: data.type === 'response.output_text.delta' ? data.delta : undefined, thinking:data.type?.includes('reasoning')||data.item?.type==='reasoning', done: data.type === 'response.completed' };
  }
  if (protocol === 'anthropic') return { text: data.type === 'content_block_delta' && data.delta?.type === 'text_delta' ? data.delta.text : undefined, thinking:data.content_block?.type==='thinking'||data.delta?.type==='thinking_delta', done: data.type === 'message_stop', limited: data.delta?.stop_reason === 'max_tokens', reason: data.delta?.stop_reason };
  const c = data.candidates?.[0];
  if (data.promptFeedback?.blockReason || ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT'].includes(c?.finishReason)) throw new Error(`Gemini 未返回答案：${data.promptFeedback?.blockReason || c.finishReason}`);
  return { text: c?.content?.parts?.filter((p: any) => !p.thought).map((p: any) => p.text || '').join(''),thinking:c?.content?.parts?.some((p:any)=>p.thought&&p.text), done: !!c?.finishReason, limited: c?.finishReason === 'MAX_TOKENS', reason: c?.finishReason };
}
export async function streamAPI(p: Profile, key: string, input: ChatInput, signal: AbortSignal, onText: (text: string) => void, fetcher: typeof fetch, onStatus?: (text:string)=>void, events:GenerationEvents={}, tools?:ToolTurn): Promise<void> {
  try {
  const request = buildRequest(p, key, input);
  tools?.configure(request.body);
  events.onPhase?.('connecting');
  let usage:TokenUsage={};
  const report=(data:any)=>{const update=readUsage(p.protocol,data);if(update){usage={...usage,...update};events.onUsage?.(usage);}};
  let body=JSON.stringify(request.body);let response:Response;
  let optionalUsage=p.protocol==='chat'&&p.preset!=='openrouter'&&!Object.hasOwn(jsonObject(p.extra,'附加参数'),'stream_options');
  for(let attempt=0;;attempt++) {
    signal.throwIfAborted();
    response = await fetcher(request.url, { method: 'POST', headers: request.headers, body, signal, redirect: 'error', credentials: 'omit' });
    if(response.ok)break;
    let data:any={};try{data=await response.json();}catch{ /* Gateway errors may not contain JSON. */ }
    const message=String(data.error?.message||data.message||'');
    if(optionalUsage&&[400,422].includes(response.status)&&/stream_options|include_usage/i.test(message)&&/unsupported|unknown|unexpected|unrecognized|not.*(?:support|allow)|不支持/i.test(message)){
      optionalUsage=false;delete request.body.stream_options;body=JSON.stringify(request.body);continue;
    }
    const retryAfter=response.headers.get('retry-after'),delay=retryDelay(retryAfter,attempt);
    const terminal=/quota|daily|billing|credit|insufficient/i.test(JSON.stringify(data.error || data));
    // Only retry rejected requests. Never replay a stream after output has begun.
    if(p.preset!=='openrouter'||response.status!==429||attempt>=2||delay>60000||terminal)throw apiError(data,response.status,retryAfter);
    onStatus?.(`OpenRouter 暂时限流，${Math.ceil(delay/1000)} 秒后重试（${attempt+1}/2）… 可点击停止`);
    await new Promise<void>((resolve,reject)=>{
      const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason);};
      const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delay);
      signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    });
  }
  onStatus?.('');
  events.onPhase?.('thinking');
  if (!response.body) throw new Error('服务器未返回内容');
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = await response.json();
    if (data.error) throw apiError(data);
    tools?.accept(data, false); const calls = tools?.finish();
    report(data);
    const text = p.protocol === 'responses' ? data.output?.filter((o: any) => o.type === 'message').flatMap((o: any) => o.content).filter((c: any) => c.type === 'output_text').map((c: any) => c.text).join('') : p.protocol === 'anthropic' ? data.content?.filter((c: any) => c.type === 'text').map((c: any) => c.text).join('') : readEvent(p.protocol, data).text;
    if (text) { events.onPhase?.('answering'); onText(text); }
    const reason = p.protocol === 'responses' ? data.status === 'completed' ? '' : data.incomplete_details?.reason || data.error?.message || data.status || ''
      : p.protocol === 'anthropic' ? ['end_turn','stop_sequence'].includes(data.stop_reason) ? '' : data.stop_reason || ''
      : p.protocol === 'gemini' ? data.candidates?.[0]?.finishReason === 'STOP' ? '' : data.candidates?.[0]?.finishReason || ''
      : data.choices?.[0]?.finish_reason === 'stop' ? '' : data.choices?.[0]?.finish_reason || '';
    if (reason && !(calls?.length && ['tool_calls','tool_use'].includes(reason))) throw new Error(`回答未完成：${reason}${/length|max_tokens/i.test(reason) ? '；可提高最大输出 token 后重试' : ''}`);
    if (!text && !calls?.length) throw new Error('模型未返回可显示的文字');
    return;
  }
  const parser = new SSEParser(); const decoder = new TextDecoder(); const reader = response.body.getReader();
  let complete = false; let limited = false; let anyText = false; let reason = '';
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      for (const event of parser.push(decoder.decode(value, { stream: !done }), done)) {
        if (event === '[DONE]') { complete = true; continue; }
        const data=JSON.parse(event);tools?.accept(data);const result = readEvent(p.protocol, data);
        if(result.thinking)events.onPhase?.('thinking');
        if (result.text) { anyText = true;events.onPhase?.('answering');onText(result.text); }
        report(data);
        complete ||= !!result.done; limited ||= !!result.limited;
        if (result.reason) reason = result.reason;
      }
      if (done) break;
    }
  } catch (error) {
    // A malformed/error event can arrive while the server is still streaming.
    try { await reader.cancel(error); } catch { /* Preserve the original stream error. */ }
    throw error;
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
  if (limited) throw new Error('已达到最大输出 token；可提高上限后重试');
  if (!complete) throw new Error('连接提前结束，当前答案可能不完整');
  const calls = tools?.finish();
  const stopped = p.protocol === 'anthropic' ? ['end_turn','stop_sequence'].includes(reason) : p.protocol === 'gemini' ? reason === 'STOP' : reason === 'stop';
  if (reason && !stopped && !(calls?.length && ['tool_calls','tool_use'].includes(reason))) throw new Error(`回答未完成：${reason}`);
  if (!anyText && !calls?.length) throw new Error('模型未返回文字；可检查模型能力、推理参数与输出上限');
  } catch (error) { signal.throwIfAborted(); throw new Error(redactError(error, credentialValues(key, p.headers)).slice(0,2000)); }
}
