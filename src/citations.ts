import type { Source } from './types.ts';

export function isCitationOnly(text: string) {
  return /^(?:[\[【［]\s*S\d+[^\]】］\r\n]*[\]】］]\s*)+$/.test(text.trim());
}

// Accept the citation formats models actually produce, while leaving code examples alone.
export function replaceCitations(text: string, sources: Source[], render: (source: Source) => string, strict = false): string {
  if (!/[\[【［]\s*S\d/.test(text)) return text;
  const available = new Map(sources.map(source => [source.id, source]));
  return text.replace(/(`+)([\s\S]*?)\1|[\[【［]\s*(S\d+[^\]】］\r\n]*)[\]】］]/g, (raw, code, content: string | undefined, value: string | undefined) => {
    if (code) return code.length < 3 && isCitationOnly(content!) ? replaceCitations(content!.trim(), sources, render, strict) : raw;
    if (value === undefined) return raw;
    const identifier = value.trim().replace(/^(S\d+P\d+)P(\d+)$/, (original, page, passage) => {
      const id = `${page}C${passage}`;
      return available.has(id) ? id : original;
    });
    const match = /^(S\d+(?:P\d+|A)C)(\d+)(?:\s*[-–—]\s*(S\d+(?:P\d+|A)C)(\d+))?$/.exec(identifier);
    if (!match) {
      if (strict) throw new Error(`无法识别引用格式 ${raw}；请使用单个原文片段标识`);
      return raw;
    }
    const start = Number(match[2]), end = match[4] === undefined ? start : Number(match[4]);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < 1) {
      if (strict) throw new Error(`引用范围无效 ${raw}`);
      return raw;
    }
    if (match[3] && match[3] !== match[1]) {
      const from = /^S(\d+)P(\d+)C$/.exec(match[1]), to = /^S(\d+)P(\d+)C$/.exec(match[3]);
      if (!from || !to || from[1] !== to[1] || Number(to[2]) <= Number(from[2])) {
        if (strict) throw new Error(`引用范围无效 ${raw}；不能跨文献或倒序引用`);
        return raw;
      }
      const selected = sources.map(source => ({ source, id: /^S(\d+)P(\d+)C(\d+)$/.exec(source.id) }))
        .filter(({ id }) => id && id[1] === from[1] && Number(id[2]) >= Number(from[2]) && Number(id[2]) <= Number(to[2]) && (id[2] !== from[2] || Number(id[3]) >= start) && (id[2] !== to[2] || Number(id[3]) <= end))
        .sort((a, b) => Number(a.id![2]) - Number(b.id![2]) || Number(a.id![3]) - Number(b.id![3]));
      let page = Number(from[2]), passage = start;
      const contiguous = selected.every(({ id }) => {
        if (Number(id![2]) === page + 1 && Number(id![3]) === 1) { page++; passage = 1; }
        return Number(id![2]) === page && Number(id![3]) === passage++;
      });
      if (!contiguous || selected[0]?.source.id !== match[1] + start || selected.at(-1)?.source.id !== match[3] + end) {
        if (strict) throw new Error(`引用范围包含未提供的片段 ${raw}，请逐一核对引用`);
        return raw;
      }
      return selected.map(({ source }) => render(source)).join('');
    }
    if (end < start || (match[3] && end - start + 1 > available.size)) {
      if (strict) throw new Error(`引用范围无效 ${raw}；仅支持实际提供的连续片段`);
      return raw;
    }
    const selected: Source[] = [];
    for (let i = start; i <= end; i++) {
      const id = match[1] + i, source = available.get(id);
      if (!source) {
        if (strict) throw new Error(`模型返回了未提供的引用 [${id}]，结果未标记为完成，请重试`);
        return raw;
      }
      selected.push(source);
    }
    return selected.map(render).join('');
  });
}

export function normalizeCitations(text: string, sources: Source[], strict = false) {
  return replaceCitations(text, sources, source => `[${source.id}]`, strict);
}

export function citedSources(text: string, sources: Source[]) {
  const ids = new Set<string>();
  replaceCitations(text, sources, source => { ids.add(source.id); return ''; }, true);
  return sources.filter(source => ids.has(source.id));
}
