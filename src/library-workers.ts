import type { ChatInput, ModelOption, Profile } from './types.ts';
import type { AccountConversation } from './accounts.ts';
import { reasoningChoices } from './usage.ts';
import { contextWindow, inputTokens } from './conversation.ts';

export function extractionProfile(profile: Profile, models: ModelOption[] = profile.models || []): Profile {
  const choices = reasoningChoices(profile, models);
  const reasoning = ['low','minimal','none','medium','high','xhigh','max'].find(value => choices.includes(value)) || '';
  const extra = JSON.parse(profile.extra || '{}');
  for (const key of ['reasoning','reasoning_effort','thinking','enable_thinking','thinking_budget']) delete extra[key];
  if (extra.output_config) { delete extra.output_config.effort; if (!Object.keys(extra.output_config).length) delete extra.output_config; }
  if (extra.generationConfig) delete extra.generationConfig.thinkingConfig;
  return { ...profile, models, reasoning, thinkingBudget: undefined, extra: JSON.stringify(extra) };
}

// Each paper owns a conversation. Reuse the account process and its cached context,
// but never carry another paper's evidence into a worker.
export class LibraryWorkers {
  private histories = new Map<string, ChatInput['messages']>();
  private profile: Profile;
  private generate: (p: Profile, input: ChatInput, onText: (text: string) => void, conversation?: AccountConversation) => Promise<void>;
  private forget: (id: string) => void;
  constructor(profile: Profile, generate: LibraryWorkers['generate'], forget: (id: string) => void) { this.profile=profile; this.generate=generate; this.forget=forget; }
  async run(input: ChatInput, onText: (text: string) => void, worker?: string) {
    if (!worker || !this.profile.protocol.includes('account')) return this.generate(this.profile, input, onText);
    const id = 'library-worker-' + worker;
    let history = this.histories.get(id) || [];
    let request = { ...input, messages: [...history, ...input.messages] };
    if (inputTokens(request) + this.profile.maxTokens + 2000 > contextWindow(this.profile) * .85) {
      this.forget(id); history = []; request = input;
    }
    let answer = '';
    try {
      await this.generate(this.profile, request, text => { answer += text; onText(text); }, { id, compaction: 0, evidence: worker, query: input.messages.at(-1)!.content });
      this.histories.set(id, [...history, ...input.messages, { role: 'assistant', content: answer }]);
    } catch (error) { this.release(worker); throw error; }
  }
  release(worker: string) { const id = 'library-worker-' + worker; this.histories.delete(id); this.forget(id); }
  close() { for (const id of this.histories.keys()) this.forget(id); this.histories.clear(); }
}
