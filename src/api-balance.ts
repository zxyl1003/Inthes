import type { Profile } from './types.ts';
import type { AccountQuota } from './account-quota.ts';
import { buildRequest } from './api.ts';
import { credentialValues, redactError } from './errors.ts';
import { minimaxHost } from './api-providers.ts';

export function balanceQuery(p: Profile): { url: string; kind: 'deepseek' | 'openrouter' | 'kimi' | 'minimax-balance' | 'minimax-plan' | 'custom' } | undefined {
  if (p.protocol.includes('account') || !p.baseURL) return;
  const base = new URL(p.baseURL);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(base.hostname)))) throw new Error('余额查询需要有效的 API 端点');
  if (p.balanceQuery) {
    const q = p.balanceQuery;
    if (!q.path.startsWith('/') || q.path.startsWith('//') || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(q.field) || !/^[A-Z]{3}$/.test(q.currency)) throw new Error('请填写余额接口路径、金额字段和三位货币代码');
    const url = new URL(q.path, base);
    if (url.origin !== base.origin || url.username || url.password || url.hash) throw new Error('余额接口必须与当前 API 端点同源');
    return { url: url.href, kind: 'custom' };
  }
  if (base.origin === 'https://api.deepseek.com' && /^\/(?:v1\/?)?$/.test(base.pathname)) return { url: base.origin + '/user/balance', kind: 'deepseek' };
  if (base.origin === 'https://openrouter.ai' && /^\/api\/v1\/?$/.test(base.pathname)) return { url: base.origin + '/api/v1/credits', kind: 'openrouter' };
  if (['https://api.moonshot.cn','https://api.moonshot.ai'].includes(base.origin) && /^\/v1\/?$/.test(base.pathname)) return { url: base.origin + '/v1/users/me/balance', kind: 'kimi' };
  if (base.protocol === 'https:' && !base.port && minimaxHost(base.hostname) && /^\/(?:anthropic\/)?v1\/?$/.test(base.pathname)) return p.billingMode === 'token-plan'
    ? { url: base.origin + '/v1/token_plan/remains', kind: 'minimax-plan' }
    : { url: base.origin + '/account/query_balance', kind: 'minimax-balance' };
}
export function balanceUnavailable(p: Profile) {
  try { if (/^api\.siliconflow\.(cn|com)$/.test(new URL(p.baseURL).hostname)) return '硅基流动已停用原余额接口，暂无法自动查询'; } catch { /* An incomplete connection has no balance endpoint. */ }
  return p.billingMode && p.billingMode !== 'payg' ? '此套餐未提供已适配的公开额度接口，请在服务商控制台查看' : '此服务未配置可用的余额查询接口';
}
function amount(value: unknown): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+(?:\.\d+)?$/.test(value.trim()))) throw new Error('余额接口未返回有效金额');
  const number = Number(value); if (!Number.isFinite(number)) throw new Error('余额接口未返回有效金额');
  return number;
}
function minimaxQuota(data: any, model: string): AccountQuota {
  if (!Array.isArray(data.model_remains)) throw new Error('MiniMax 未返回套餐额度');
  const row = data.model_remains.find((r: any) => r.model_name === model)
    ?? data.model_remains.find((r: any) => r.model_name === 'general')
    ?? (/^MiniMax-M/i.test(model) ? data.model_remains.find((r: any) => r.model_name === 'MiniMax-M*') : undefined);
  if (!row) throw new Error('MiniMax 未返回当前模型的套餐额度');
  const now = Date.now(), windows: AccountQuota['groups'][number]['windows'] = [];
  for (const [prefix,label,end,remaining] of [['current_interval','5h','end_time','remains_time'],['current_weekly','week','weekly_end_time','weekly_remains_time']]) {
    const value = row[prefix+'_remaining_percent'];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error('MiniMax 返回的套餐百分比无效');
    const boost = prefix === 'current_weekly' ? row.weekly_boost_permille ?? 1000 : 1000;
    if (typeof boost !== 'number' || !Number.isFinite(boost) || boost <= 0) throw new Error('MiniMax 返回的额度倍率无效');
    const resetsAt = typeof row[end] === 'number' && Number.isFinite(row[end]) && row[end] > 0 ? row[end]
      : typeof row[remaining] === 'number' && Number.isFinite(row[remaining]) && row[remaining] >= 0 ? now + row[remaining] : undefined;
    windows.push({ label, remaining: value * boost / 1000, ...(resetsAt === undefined ? {} : { resetsAt }) });
  }
  // Count fields have changed meaning across API versions; use explicit percentages only.
  if (!windows.length) throw new Error('MiniMax 未返回可识别的套餐百分比，请在控制台查看');
  return { groups: [{ id: 'minimax', name: 'MiniMax', windows }], updated: now };
}
export async function fetchBalance(p: Profile, key: string, signal: AbortSignal, fetcher: typeof fetch): Promise<AccountQuota> {
  try {
    const query = balanceQuery(p); if (!query) throw new Error(balanceUnavailable(p));
    if (!key) throw new Error('请先配置 API Key');
    const { headers } = buildRequest({ ...p, model: p.model || 'balance-query' }, key, { system: '', messages: [] });
    if (query.kind !== 'custom') { headers.Authorization = `Bearer ${key}`; delete headers['x-api-key']; delete headers['x-goog-api-key']; }
    const response = await fetcher(query.url, { method: 'GET', headers, signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (response.status === 403 && query.kind === 'openrouter') return { groups: [], updated: Date.now(), notice: '当前 Key 无余额查询权限', };
    if (!response.ok) throw new Error(`余额查询失败：HTTP ${response.status}`);
    const data = await response.json();
    if (query.kind.startsWith('minimax')) {
      if (data.base_resp && data.base_resp.status_code !== 0) throw new Error(`MiniMax 查询失败：${data.base_resp.status_msg || data.base_resp.status_code}`);
      if (query.kind === 'minimax-plan') return minimaxQuota(data, p.model);
    }
    let values: { currency: string; remaining: number }[], detail: string;
    if (query.kind === 'deepseek') {
      if (!Array.isArray(data.balance_infos) || !data.balance_infos.length) throw new Error('服务未返回余额');
      values = data.balance_infos.map((v: any) => { if (!['CNY','USD'].includes(v.currency)) throw new Error('无法识别余额货币');return { currency: v.currency, remaining: amount(v.total_balance) }; });
      detail = data.balance_infos.map((v: any) => `${v.currency} 可用余额（含赠金）：${amount(v.total_balance)}；充值余额：${amount(v.topped_up_balance)}；赠金：${amount(v.granted_balance)}`).join('\n');
    } else if (query.kind === 'openrouter') {
      values = [{ currency: 'USD', remaining: amount(data.data?.total_credits) - amount(data.data?.total_usage) }];
      detail = 'OpenRouter 可用余额（美元）：累计 credits 减累计使用额；不是当前 Key 的调用限额。';
    } else if (query.kind === 'kimi') {
      if (data.code !== 0 || data.status !== true) throw new Error('Kimi 未返回有效余额');
      const currency = new URL(p.baseURL).hostname === 'api.moonshot.cn' ? 'CNY' : 'USD';
      values = [{ currency, remaining: amount(data.data?.available_balance) }];
      detail = `${currency} 可用余额（含赠金）：${amount(data.data.available_balance)}；现金余额：${amount(data.data.cash_balance)}；赠金：${amount(data.data.voucher_balance)}`;
    } else if (query.kind === 'minimax-balance') {
      const currency = new URL(p.baseURL).hostname === 'api.minimax.io' ? 'USD' : 'CNY';
      values = [{ currency, remaining: amount(data.available_amount) }];
      detail = `${currency} 可用余额：${amount(data.available_amount)}；现金余额：${amount(data.cash_balance)}；代金券：${amount(data.voucher_balance)}；信用余额：${amount(data.credit_balance)}；欠款：${amount(data.owed_amount)}`;
    } else {
      let value: any = data;
      for (const field of p.balanceQuery!.field.split('.')) { if (value === null || typeof value !== 'object' || !Object.hasOwn(value, field)) throw new Error('余额响应中找不到配置的金额字段');value = value[field]; }
      values = [{ currency: p.balanceQuery!.currency, remaining: amount(value) }];
      detail = `服务返回的 ${p.balanceQuery!.field} 金额，货币按连接配置为 ${p.balanceQuery!.currency}。`;
    }
    return { groups: [], balance: { values, detail }, updated: Date.now() };
  } catch (error) { signal.throwIfAborted(); throw new Error(redactError(error, credentialValues(key, p.headers))); }
}
