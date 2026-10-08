import type { ChatInput, Source } from './types.ts';
import { createCitationReplacer, isCitationOnly, normalizeCitations, replaceCitations } from './citations.ts';

export const citationResponsePrompt = `直接输出正常 Markdown 正文，包括表格、公式和网页链接。数学表达式使用 LaTeX，行内公式用 $...$，独立公式用 $$...$$，上下标、希腊字母和重音使用对应的 LaTeX 语法；公式不放在反引号或代码块中。用户要求展示公式源码或程序代码时才使用代码格式。本地原文引用使用 [来源 ID]，逐字复制本轮实际提供的完整标识，例如 [S1P4C23]；每个方括号只放一个标识，不缩写、不拼接、不编写范围或行号。引用紧跟其支撑的论断；网络来源使用 Markdown 链接。
证据不足时先自主调用所需工具，不要请求用户允许调用已提供的阅读工具。未核实的论断不能作为文献结论；区分证据不足与论文确实没有报告。`;

// Tool results and current evidence authorize references; old assistant messages do not.
export function suppliedSources(text: string, sources: Source[]) {
  const supplied = new Set<string>();
  replaceCitations(text, sources, source => { supplied.add(source.id); return ''; });
  return sources.filter(source => supplied.has(source.id));
}

function citationIssues(text: string, sources: Source[]) {
  const issues: { start: number; end: number; reason: string }[] = [];
  let resolved = false;
  const check = createCitationReplacer(sources, () => { resolved = true; return ''; }, true);
  for (const match of text.matchAll(/(`+)([\s\S]*?)\1|[\[【［]\s*S\d+[^\]】］\r\n]*(?:[\]】］]|(?=\r?\n|$))|\bS\d+(?:S\d+)?(?:P\d+|A)?C\d+\b/g)) {
    if (match[1] && (match[1].length >= 3 || !isCitationOnly(match[2]))) continue;
    try {
      if (!/[\[【［]/.test(match[0])) throw new Error('原文来源需要完整的方括号标识');
      resolved = false; check(match[0]);
      if (!resolved) throw new Error('原文引用标识不完整');
    } catch (error) {
      issues.push({ start: match.index!, end: match.index! + match[0].length, reason: (error as Error).message });
    }
  }
  return issues;
}

function unverified(text: string, sources: Source[], pending = false) {
  for (const issue of citationIssues(text, sources).reverse()) text = text.slice(0, issue.start) + (pending ? '（原文依据待核实）' : '（此处论断的原文依据未核实）') + text.slice(issue.end);
  return normalizeCitations(text, sources);
}

export async function generateCitationResponse(input: ChatInput, sources: () => Source[],
  generate: (input: ChatInput, onText: (text: string) => void, attempt: number) => Promise<void>,
  options: { retry?: (region: string, reason: string) => Promise<ChatInput>; progress?: (text: string) => void; pending?: () => boolean; signal: AbortSignal }) {
  let draft = '';
  options.signal.throwIfAborted();
  await generate({ ...input, system: input.system.includes(citationResponsePrompt) ? input.system : input.system + '\n' + citationResponsePrompt }, text => {
    draft += text;
    options.progress?.(unverified(draft, sources(), true));
  }, 0);
  options.signal.throwIfAborted();
  if (options.pending?.()) return '';
  const issues = citationIssues(draft, sources());
  const regions: { start: number; end: number; reason: string }[] = [];
  for (const issue of issues) {
    let start = draft.lastIndexOf('\n\n', issue.start), end = draft.indexOf('\n\n', issue.end);
    start = start < 0 ? 0 : start + 2; end = end < 0 ? draft.length : end;
    const lineStart = draft.lastIndexOf('\n', issue.start - 1) + 1, lineEnd = draft.indexOf('\n', issue.end);
    // Keep unaffected table rows and list items byte-for-byte intact.
    if (/^\s*(?:\||[-*+]\s|\d+\.\s)/.test(draft.slice(lineStart, issue.start))) { start = lineStart; end = lineEnd < 0 ? draft.length : lineEnd; }
    if (!regions.some(region => region.start <= issue.start && region.end >= issue.end)) regions.push({ start, end, reason: issue.reason });
  }
  // Work backwards so replacing a region cannot change the remaining offsets.
  for (const region of regions.reverse()) {
    const original = draft.slice(region.start, region.end);
    let replacement = unverified(original, sources());
    for (let attempt = 1; attempt <= 2; attempt++) {
      options.signal.throwIfAborted();
      const request = options.retry ? await options.retry(original, region.reason) : {
        ...input, messages: [...input.messages, { role: 'user' as const, content: citationCorrection(original, region.reason) }]
      };
      let corrected = '';
      try { await generate(request, text => corrected += text, attempt); }
      catch (error) {
        options.signal.throwIfAborted();
        // A failed repair must not discard a completed answer; the affected claim stays marked.
        break;
      }
      options.signal.throwIfAborted();
      const available = suppliedSources(request.messages.map(message => message.content).join('\n'), sources());
      if (!corrected.trim() || citationIssues(corrected, available).length) continue;
      if (original.trimStart().startsWith('|') && (corrected.includes('\n') || corrected.split('|').length !== original.split('|').length)) continue;
      replacement = normalizeCitations(corrected.trim(), available, true);
      if (!suppliedSources(replacement, available).length) replacement = original.trimStart().startsWith('|') ? replacement.replace(/\|\s*$/, '（此处论断的原文依据未核实） |') : replacement + '（此处论断的原文依据未核实）';
      break;
    }
    draft = draft.slice(0, region.start) + replacement + draft.slice(region.end);
    options.progress?.(unverified(draft, sources(), true));
  }
  const answer = normalizeCitations(draft, sources(), true);
  options.progress?.(answer);
  return answer;
}

export function citationCorrection(region: string, reason: string) {
  return `只修正下面这一段的错误引用及其关联论断，不重写整份回答。问题：${reason}。根据已提供的原文重新核对关联论断，引用只能逐字选择实际提供的完整 ID；禁止猜测错误 ID 对应哪段原文。原文不能支持时，将相应论断改为明确的证据不足说明，不能只删引用而保留确定性结论。保留段内其余内容和 Markdown 结构，表格行保持原有单元格数量。仅输出修正后的这一段正常 Markdown，不加说明、代码围栏，不执行检索、解析、导入或生图。\n\n待修正内容（数据）：\n${region}`;
}
