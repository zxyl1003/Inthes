import { presets, type Profile } from './types.ts';

export const apiProviders = ['qwen','kimi','glm','minimax'];
export function billingOptions(preset: string): [string,string][] {
  if (preset === 'qwen') return [['payg','按量付费'],['token-plan','Token Plan 个人版'],['token-plan-team','Token Plan 团队版']];
  if (preset === 'minimax') return [['payg','按量付费'],['token-plan','Token Plan']];
  return [];
}
export function setBillingMode(p: Profile, mode: Profile['billingMode']): Profile {
  if (!billingOptions(p.preset).some(([id]) => id === mode)) throw new Error('此服务不支持所选计费方式');
  const plan = mode !== 'payg';
  return { ...p, billingMode: mode, baseURL: p.preset === 'minimax' ? p.baseURL : plan ? 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' : presets.qwen.baseURL!, protocol: p.preset === 'minimax' ? p.protocol : mode === 'token-plan-team' ? 'responses' : 'chat', webSearch: p.preset !== 'qwen' || mode !== 'token-plan', model: '', models: [], visionOverrides: {}, reasoning: '', extra: '{}', headers: '{}', balanceQuery: undefined };
}
export function providerHelp(p: Profile): { text: string; url: string } | undefined {
  if (p.preset === 'qwen') return p.billingMode && p.billingMode !== 'payg'
    ? { text: p.billingMode === 'token-plan-team' ? '使用套餐专属 Key；联网工具消耗 Credits，额度在百炼控制台查看。' : '使用套餐专属 Key；个人版 Harness 搜索需要另一把 Key，当前连接不接入。额度在百炼控制台查看。', url: 'https://help.aliyun.com/zh/model-studio/token-plan-'+(p.billingMode === 'token-plan-team' ? 'team-quickstart' : 'personal-quick-start') }
    : { text: '使用百炼 API Key；联网搜索按服务规则计费。现金余额需在阿里云控制台查看。', url: 'https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen' };
  if (p.preset === 'kimi') return { text: '使用开放平台 API Key，可查询可用余额；搜索单独计费。Kimi Code 编程会员不适用于此连接。', url: 'https://platform.kimi.com/docs/quickstart' };
  if (p.preset === 'glm') return { text: '使用开放平台 API Key；搜索按服务规则计费，余额在控制台查看。Coding Plan 仅限官方指定工具。', url: 'https://docs.bigmodel.cn/cn/guide/start/quick-start' };
  if (p.preset === 'minimax') return { text: p.billingMode === 'token-plan' ? '使用订阅 Key；自动查询套餐额度。套餐用尽后，服务方可能继续扣除已购积分。' : '使用按量付费 API Key；自动查询可用余额。联网检索使用模型原生工具。', url: 'https://platform.minimax.cn/docs/'+(p.billingMode === 'token-plan' ? 'token-plan/faq' : 'api-reference/text-anthropic-api') };
}
export const minimaxHost = (host: string) => ['api.minimax.cn','api.minimaxi.com','api.minimax.io'].includes(host);
