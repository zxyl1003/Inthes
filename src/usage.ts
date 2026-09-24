import type { ModelOption, Profile, TokenUsage } from './types.ts';

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
export function readUsage(protocol: Profile['protocol'], data: any): TokenUsage | undefined {
  const result: TokenUsage = {};
  if (protocol === 'codex-account') {
    const u=data.tokenUsage?.last;
    if(!u)return;
    Object.assign(result,{inputTokens:count(u.inputTokens),outputTokens:count(u.outputTokens),totalTokens:count(u.totalTokens),cachedInputTokens:count(u.cachedInputTokens),reasoningTokens:count(u.reasoningOutputTokens),contextTokens:count(u.totalTokens),modelContextWindow:count(data.tokenUsage.modelContextWindow)});
  } else if (protocol === 'gemini') {
    const u=data.usageMetadata;if(!u)return;
    const visible=count(u.candidatesTokenCount),reasoning=count(u.thoughtsTokenCount);
    Object.assign(result,{inputTokens:count(u.promptTokenCount),outputTokens:visible===undefined?undefined:visible+(reasoning??0),totalTokens:count(u.totalTokenCount),cachedInputTokens:count(u.cachedContentTokenCount),reasoningTokens:reasoning});
  } else {
    const u=protocol==='responses'?data.response?.usage??data.usage:protocol==='anthropic'?data.message?.usage??data.usage:data.usage;
    if(!u)return;
    if(protocol==='chat')Object.assign(result,{inputTokens:count(u.prompt_tokens),outputTokens:count(u.completion_tokens),totalTokens:count(u.total_tokens),cachedInputTokens:count(u.prompt_tokens_details?.cached_tokens??u.prompt_cache_hit_tokens),reasoningTokens:count(u.completion_tokens_details?.reasoning_tokens)});
    else {
      const input=count(u.input_tokens);
      Object.assign(result,{inputTokens:input===undefined?undefined:input+(protocol==='anthropic'?(count(u.cache_read_input_tokens)??0)+(count(u.cache_creation_input_tokens)??0):0),outputTokens:count(u.output_tokens),totalTokens:count(u.total_tokens),cachedInputTokens:count(u.input_tokens_details?.cached_tokens??u.cache_read_input_tokens),reasoningTokens:count(u.output_tokens_details?.reasoning_tokens)});
    }
  }
  // Missing fields remain unknown; partial/cumulative stream events replace, never add, counters.
  for(const key of Object.keys(result) as (keyof TokenUsage)[])if(result[key]===undefined)delete result[key];
  return Object.keys(result).length?result:undefined;
}
export function modelDetails(model:any): Pick<ModelOption,'contextWindow'|'reasoningEfforts'|'defaultReasoning'> {
  const result:ReturnType<typeof modelDetails>={};
  const window=count(model.context_length??model.contextWindow??model.context_window??model.inputTokenLimit);
  if(window)result.contextWindow=window;
  const efforts=model.supportedReasoningEfforts?.map((entry:any)=>entry.reasoningEffort??entry.effort) ?? model.reasoning?.supported_efforts;
  if(model.reasoning?.supported_efforts === null) result.reasoningEfforts=['none','minimal','low','medium','high','xhigh','max'].filter(e=>e!=='none'||!model.reasoning.mandatory);
  if(model.reasoning && efforts === undefined)result.reasoningEfforts=[];
  if(!model.reasoning && Array.isArray(model.supported_parameters))result.reasoningEfforts=model.supported_parameters.some((v:string)=>v==='reasoning'||v==='reasoning.effort')?['none','minimal','low','medium','high','xhigh','max']:[];
  if(Array.isArray(efforts)&&efforts.every(e=>typeof e==='string'))result.reasoningEfforts=efforts.filter(e=>e!=='none'||!model.reasoning?.mandatory);
  if(typeof model.defaultReasoningEffort==='string')result.defaultReasoning=model.defaultReasoningEffort;
  return result;
}
export const isSiliconFlow = (p: Profile) => /^https:\/\/api\.siliconflow\.(?:cn|com)(?:\/|$)/i.test(p.baseURL);
export function reasoningChoices(p:Profile, models=p.models||[]):string[] {
  const reported=models.find(m=>m.id===p.model)?.reasoningEfforts;
  if(reported)return reported;
  const model=p.model.toLowerCase().replace(/^models\//,'');
  if(p.protocol==='chat'&&isSiliconFlow(p)&&/^(?:(?:pro\/)?deepseek-ai\/deepseek-v4(?:-flash)?|pro\/zai-org\/glm-5\.2)$/.test(model))return ['none','high','max'];
  if(p.preset==='deepseek'&&/deepseek-(?:flash|v4)/.test(model))return ['none','low','high','max'];
  if(p.protocol==='gemini') {
    if(/^gemini-3\.1-flash-lite.*image/.test(model))return ['minimal','high'];
    if(/^gemini-3\.[78]-flash|^gemini-3\.1-pro/.test(model))return ['low','medium','high'];
    if(/^gemini-3(?:\.[1356])?-flash/.test(model))return ['minimal','low','medium','high'];
    if(/^gemini-3-pro/.test(model))return ['low','high'];
    if(/^gemini-2\.5-flash/.test(model))return ['none'];
  }
  if(p.protocol==='anthropic') {
    if(/^claude-opus-4-[78]/.test(model))return ['low','medium','high','xhigh','max'];
    if(/^claude-opus-4-6/.test(model))return ['low','medium','high','max'];
    if(/^claude-(?:opus-4-5|sonnet-4-6)/.test(model))return ['low','medium','high'];
  }
  if((p.protocol==='responses'||p.protocol==='chat')&&p.preset==='openai') {
    if(/^gpt-5\.2-pro(?:-\d|$)/.test(model))return ['medium','high','xhigh'];
    if(/^gpt-5\.2-codex(?:-\d|$)/.test(model))return ['low','medium','high','xhigh'];
    if(/^gpt-5\.[24](?:-\d|$)/.test(model))return ['none','low','medium','high','xhigh'];
  }
  // Unknown endpoints/models stay on their own defaults until capabilities are reported.
  return [];
}
