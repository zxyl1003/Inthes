import type { Session, State } from './types.ts';
import { figureAssetName, safeAssetPath } from './figure-assets.ts';

const object = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v: any) => typeof v === 'string';
const number = (v: any) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const id = (v: any) => string(v) && /^[A-Za-z0-9_-]+$/.test(v);
const optional = (v: any, check: (v: any) => boolean) => v === undefined || check(v);
const array = (v: any, check: (v: any) => boolean) => Array.isArray(v) && v.every(check);
const usage = (v: any) => object(v) && Object.values(v).every(number);
export const validImage = (v: any) => object(v) && string(v.data) && /^[A-Za-z0-9+/]*={0,2}$/.test(v.data) && ['image/png','image/jpeg','image/webp'].includes(v.mimeType) && number(v.width) && number(v.height);
export const validFigure = (v: any) => object(v) && string(v.asset) && figureAssetName.test(v.asset) && optional(v.file, f => string(f) && safeAssetPath(f)) && ['image/png','image/jpeg','image/webp'].includes(v.mimeType) && number(v.width) && v.width > 0 && number(v.height) && v.height > 0;
const image = validImage;
const paper = (v: any) => object(v) && number(v.id) && string(v.title) && number(v.libraryID) && optional(v.attachmentID, number) && optional(v.collectionID, number) && ['abstract','year','authors'].every(k => optional(v[k], string));
const source = (v: any) => object(v) && id(v.id) && number(v.itemID) && string(v.title) && string(v.text) && optional(v.attachmentID, number) && optional(v.page, number) && optional(v.passage, number) && optional(v.image, validFigure);
const message = (v: any) => object(v) && ['user','assistant'].includes(v.role) && string(v.text) && ['error','model'].every(k => optional(v[k], string)) && optional(v.images, v => array(v, image)) && optional(v.usage, usage)
  && optional(v.generatedImages, v => array(v, validFigure))
  && optional(v.retrieval, r => object(r) && [r.retrieved,r.total].every(n => Number.isInteger(n) && n >= 0) && r.retrieved <= r.total && optional(r.unreadPapers, n => Number.isInteger(n) && n >= 0));
const library = (v: any, s: any) => {
  if (!object(v) || !string(v.name) || !optional(v.collectionID, number) || typeof v.descendants !== 'boolean' || !s.papers.length || s.papers.length > 200) return false;
  const ids = new Set(s.papers.map((p: any) => p.id));
  const sourceIDs = new Map<number, Set<string>>();
  for (const source of s.sources) {
    let owned = sourceIDs.get(source.itemID);
    if (!owned) sourceIDs.set(source.itemID, owned = new Set());
    owned.add(source.id);
  }
  return ids.size === s.papers.length && array(v.checked, x => ids.has(x)) && s.sources.every((source: any) => ids.has(source.itemID))
    && array(v.documents, d => object(d) && ids.has(d.paperID) && ['pending','reading','ready','failed','outdated'].includes(d.state) && ['fingerprint','error'].every(k => optional(d[k], string)) && optional(d.passages, number) && optional(d.kind, k => ['fulltext','abstract'].includes(k)))
    && v.documents.length === ids.size && new Set(v.documents.map((d: any) => d.paperID)).size === ids.size
    && array(v.jobs, j => object(j) && id(j.id) && string(j.question) && string(j.model) && ['running','paused','done','failed'].includes(j.status) && optional(j.synthesis, string) && optional(j.synthesisError, string) && Number.isInteger(j.inputBudget) && j.inputBudget >= 1000 && j.inputBudget <= 32000
      && array(j.items, i => object(i) && ids.has(i.paperID) && ['pending','running','done','failed'].includes(i.state) && array(i.notes, string) && array(i.sourceIDs, x => string(x) && sourceIDs.get(i.paperID)?.has(x) === true) && ['result','error','fingerprint'].every(k => optional(i[k], string)) && optional(i.parts, number))
      && j.items.length > 0 && new Set(j.items.map((i: any) => i.paperID)).size === j.items.length)
    && new Set(v.jobs.map((j: any) => j.id)).size === v.jobs.length && optional(v.currentJob, x => v.jobs.some((j: any) => j.id === x));
};
const session = (v: any) => object(v) && id(v.id) && string(v.title) && number(v.updated) && array(v.papers, paper) && array(v.sources, source) && array(v.messages, message)
  && optional(v.library, l => library(l, v))
  && ['remember','pinned','archived','renamed'].every(k => optional(v[k], v => typeof v === 'boolean')) && optional(v.coverage, string) && optional(v.locked, v => typeof v === 'boolean') && optional(v.evidenceTokens, number)
  && optional(v.excludedPapers, v => array(v, e => object(e) && paper(e.paper) && string(e.reason)))
  && optional(v.compaction, c => object(c) && string(c.summary) && Number.isInteger(c.through) && c.through >= 0 && c.through <= v.messages.length && number(c.count))
  && optional(v.continuation, c => object(c) && ['codex-account','antigravity-account'].includes(c.protocol) && id(c.profileID) && id(c.id) && optional(c.pending, p => typeof p === 'boolean') && string(c.fingerprint) && /^[a-f0-9]{64}$/.test(c.fingerprint) && (c.protocol === 'antigravity-account' ? id(c.home) : c.home === undefined))
  && optional(v.usage, u => object(u) && id(u.profileID) && string(u.model) && ['through','compaction','baseline','context'].every(k => number(u[k])) && typeof u.exact === 'boolean' && usage(u.reported));

export function validateSessions(value: unknown): Session[] {
  if (!array(value, session) || new Set((value as Session[]).map(s => s.id)).size !== (value as Session[]).length) throw new Error('Inthes 历史中含有无效的会话数据；原文件未被修改');
  return value as Session[];
}
export function validateState(value: any): State {
  const profile = (p: any) => object(p) && id(p.id) && ['name','preset','baseURL','model','reasoning','extra','headers','executable','args'].every(k => string(p[k]))
    && ['chat','responses','anthropic','gemini','codex-account','antigravity-account'].includes(p.protocol) && number(p.maxTokens) && number(p.contextTokens)
    && ['max_tokens','max_completion_tokens'].includes(p.tokenField) && ['temperature','topP','autoCompactPercent'].every(k => optional(p[k], number)) && optional(p.thinkingBudget, v => v === -1 || number(v))
    && optional(p.openrouterProvider, string) && optional(p.contextAuto, v => typeof v === 'boolean')
    && optional(p.balanceQuery, q => object(q) && ['path','field','currency'].every(k => string(q[k])))
    && optional(p.visionOverrides, v => object(v) && Object.values(v).every(x => typeof x === 'boolean'))
    && optional(p.webSearch, v => typeof v === 'boolean')
    && optional(p.billingMode, v => ['payg','token-plan','token-plan-team'].includes(v))
    && optional(p.models, v => array(v, m => object(m) && string(m.id) && string(m.name) && optional(m.vision, v => typeof v === 'boolean') && optional(m.contextWindow, number) && optional(m.reasoningEfforts, v => array(v, string)) && optional(m.defaultReasoning, string)));
  if (!object(value) || value.version !== 1 || value.historyFormat !== 2 || !array(value.profiles, profile) || !string(value.selected) || typeof value.remember !== 'boolean' || !optional(value.historyPath, string) || !optional(value.cachePath, string) || !optional(value.cacheEnabled, v => typeof v === 'boolean')
    || !optional(value.libraryConcurrency, n => Number.isInteger(n) && n >= 1 && n <= 8)
    || !optional(value.mineruConcurrency, n => Number.isInteger(n) && n >= 1 && n <= 50)
    || !optional(value.mineru, m => object(m) && typeof m.enabled === 'boolean' && ['vlm','pipeline'].includes(m.model) && string(m.language) && /^[a-z_]{2,20}$/.test(m.language) && typeof m.ocr === 'boolean')
    || new Set(value.profiles.map((p: any) => p.id)).size !== value.profiles.length) throw new Error('Inthes 配置格式不兼容或包含无效字段；原文件未被修改');
  validateSessions(value.sessions);
  return value;
}
