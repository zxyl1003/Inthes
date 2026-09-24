export interface QuotaWindow { label: string; remaining: number; resetsAt?: number; }
export interface QuotaGroup { id: string; name: string; windows: QuotaWindow[]; }
export interface AccountQuota { groups: QuotaGroup[]; updated: number; error?: string; balance?: { values: { currency: string; remaining: number }[]; detail: string }; notice?: string; }

function percent(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : undefined;
}
export function codexQuota(data: any): AccountQuota {
  const buckets = data?.rateLimitsByLimitId ?? (data?.rateLimits ? { [data.rateLimits.limitId || 'codex']: data.rateLimits } : {});
  const groups: QuotaGroup[] = [];
  for (const [id, bucket] of Object.entries(buckets) as [string, any][]) {
    const windows: QuotaWindow[] = [];
    for (const key of ['primary', 'secondary']) {
      const window = bucket?.[key], used = percent(window?.usedPercent);
      if (used === undefined) continue;
      const minutes = window.windowDurationMins;
      const label = minutes === 10080 ? '每周' : typeof minutes === 'number' && minutes > 0 ? (minutes % 60 === 0 ? `${minutes / 60} 小时` : `${minutes} 分钟`) : key === 'primary' ? '短期' : '长期';
      windows.push({ label, remaining: 100 - used, ...(typeof window.resetsAt === 'number' ? { resetsAt: window.resetsAt * 1000 } : {}) });
    }
    if (windows.length) groups.push({ id, name: bucket.limitName || (id === 'codex' ? 'Codex' : id), windows });
  }
  return { groups, updated: Date.now() };
}
export function antigravityQuota(text: string): AccountQuota {
  const groups: QuotaGroup[] = [];
  for (const line of text.split(/\r?\n/)) {
    const fields = line.trim().split('\t');
    if (fields.length < 3 || !/^(?:\d+(?:\.\d+)?)%$/.test(fields[2])) continue;
    const remaining = percent(Number(fields[2].slice(0, -1)));
    if (remaining === undefined || !/remaining/i.test(fields[1])) continue;
    const id = fields[0]; let group = groups.find(g => g.id === id);
    if (!group) { group = { id, name: id.replace(/ Models$/i, ''), windows: [] }; groups.push(group); }
    const resetsAt = Date.parse(fields[3]);
    group.windows.push({ label: /five hour/i.test(fields[1]) ? '5 小时' : /weekly/i.test(fields[1]) ? '每周' : fields[1], remaining, ...(Number.isFinite(resetsAt) ? { resetsAt } : {}) });
  }
  if (!groups.length) throw new Error('运行组件未返回可识别的账户额度');
  for (const group of groups) group.windows.sort((a, b) => Number(a.label === '每周') - Number(b.label === '每周'));
  return { groups, updated: Date.now() };
}
export function quotaDisplay(quota: AccountQuota, protocol: string, model: string) {
  if (quota.balance) return { text: quota.balance.values.map(v => `${v.currency === 'CNY' ? '¥' : v.currency === 'USD' ? '$' : v.currency + ' '}${v.remaining.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`).join(' / '), reset: '' };
  if (quota.notice) return { text: quota.notice, reset: '' };
  const group = protocol === 'antigravity-account'
    ? quota.groups.find(g => /^gemini/i.test(model) ? /^gemini/i.test(g.id) : /^(?:claude|gpt)/i.test(model) && /claude.*gpt/i.test(g.id))
    : quota.groups.find(g => g.id === 'codex');
  const selected = group ? [group] : quota.groups;
  const value = (n: number) => `${Math.round(n * 10) / 10}%`;
  const text = selected.map(g => `${selected.length > 1 ? g.name + ' · ' : ''}${g.windows.map(w => `${w.label==='5 小时'?'5h':w.label==='每周'?'week':w.label}: ${value(w.remaining)}`).join(' · ')}`).join(' / ');
  const time = (at?: number) => {
    if (at===undefined) return '—';
    const date=new Date(at);
    return `${date.getMonth()+1}/${date.getDate()} ${date.getHours()}:${String(date.getMinutes()).padStart(2,'0')}`;
  };
  const reset = selected.some(g=>g.windows.some(w=>w.resetsAt!==undefined)) ? selected.map(g=>g.windows.map(w=>time(w.resetsAt)).join(' · ')).join(' / ') : '';
  return { text, reset };
}
