export type Protocol = 'chat' | 'responses' | 'anthropic' | 'gemini' | 'codex-account' | 'antigravity-account';
export interface Profile {
  id: string; name: string; preset: string; protocol: Protocol; baseURL: string; model: string;
  maxTokens: number; contextTokens: number; reasoning: string; temperature?: number; topP?: number;
  tokenField: 'max_tokens' | 'max_completion_tokens'; thinkingBudget?: number;
  extra: string; headers: string; executable: string; args: string;
  openrouterProvider?: string;
  autoCompactPercent?: number;
  contextAuto?: boolean;
  models?: ModelOption[];
  visionOverrides?: Record<string, boolean>;
  webSearch?: boolean;
  billingMode?: 'payg' | 'token-plan' | 'token-plan-team';
  balanceQuery?: { path: string; field: string; currency: string };
}
export interface ImageInput { data: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; width: number; height: number; }
export interface FigureImage { asset: string; mimeType: ImageInput['mimeType']; width: number; height: number; file?: string; directory?: string; bytes?: Uint8Array; }
export type SourceImage = FigureImage;
export interface TokenUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; reasoningTokens?: number; contextTokens?: number; modelContextWindow?: number; }
export interface GenerationEvents { onUsage?: (usage: TokenUsage) => void; onImage?: (data: string) => Promise<void>; onSearch?: (query: string) => void; onSearchCompleted?: () => void; onWarning?: (warning: string) => void; onPhase?: (phase: 'connecting' | 'restoring' | 'thinking' | 'answering' | 'imaging') => void; }
export interface Retrieval { retrieved: number; total: number; unreadPapers?: number; }
export interface Message { role: 'user' | 'assistant'; text: string; images?: ImageInput[]; generatedImages?: FigureImage[]; error?: string; partial?: boolean; model?: string; usage?: TokenUsage; retrieval?: Retrieval; }
export interface Source { id: string; itemID: number; attachmentID?: number; title: string; page?: number; passage?: number; text: string; image?: SourceImage; }
export interface Paper { id: number; title: string; attachmentID?: number; libraryID: number; collectionID?: number; abstract?: string; year?: string; authors?: string; }
export interface LibraryDocument { paperID: number; state: 'pending' | 'reading' | 'ready' | 'failed' | 'outdated'; fingerprint?: string; passages?: number; kind?: 'fulltext' | 'abstract'; error?: string; }
export interface LibraryJobItem { paperID: number; state: 'pending' | 'running' | 'done' | 'failed'; notes: string[]; result?: string; error?: string; parts?: number; fingerprint?: string; sourceIDs: string[]; }
export interface LibraryJob { id: string; question: string; model: string; status: 'running' | 'paused' | 'done' | 'failed'; items: LibraryJobItem[]; synthesis?: string; synthesisError?: string; inputBudget: number; }
export interface LibraryState { name: string; collectionID?: number; descendants: boolean; documents: LibraryDocument[]; jobs: LibraryJob[]; currentJob?: string; checked: number[]; }
export interface AccountContinuation { protocol: 'codex-account' | 'antigravity-account'; profileID: string; id: string; fingerprint: string; home?: string; pending?: boolean; }
export interface Session { continuation?: AccountContinuation; library?: LibraryState; remember?: boolean; pinned?: boolean; archived?: boolean; renamed?: boolean; id: string; title: string; updated: number; papers: Paper[]; sources: Source[]; messages: Message[]; coverage?: string; excludedPapers?: { paper: Paper; reason: string }[]; locked?: boolean; compaction?: { summary: string; through: number; count: number }; evidenceTokens?: number; usage?: { profileID: string; model: string; through: number; compaction: number; baseline: number; context: number; exact: boolean; reported: TokenUsage }; }
export interface ModelOption { id: string; name: string; vision?: boolean; contextWindow?: number; reasoningEfforts?: string[]; defaultReasoning?: string; }
export interface MinerUSettings { enabled: boolean; model: 'vlm' | 'pipeline'; language: string; ocr: boolean; }
export interface State { version: 1; profiles: Profile[]; selected: string; remember: boolean; historyPath?: string; historyFormat: 2; cachePath?: string; cacheEnabled?: boolean; mineru?: MinerUSettings; libraryConcurrency?: number; mineruConcurrency?: number; sessions: Session[]; }
export interface ChatInput { system: string; messages: { role: 'user' | 'assistant'; content: string; images?: ImageInput[] }[]; }
export interface ToolDefinition { name: string; description: string; parameters: Record<string, any>; }
export interface ToolCall { id: string; name: string; arguments: unknown; }
export interface ToolOutput { text: string; images?: ImageInput[]; }
export interface ToolAccess { definitions: ToolDefinition[]; execute: (call: ToolCall) => Promise<ToolOutput>; webSearch?: boolean; }
export const presets: Record<string, Partial<Profile> & { name: string }> = {
  deepseek: { name: 'DeepSeek', protocol: 'chat', baseURL: 'https://api.deepseek.com', model: 'deepseek-flash', reasoning: 'high' },
  qwen: { name: 'Qwen API', protocol: 'chat', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: '', billingMode: 'payg', webSearch: true },
  kimi: { name: 'Kimi API', protocol: 'chat', baseURL: 'https://api.moonshot.cn/v1', model: '', billingMode: 'payg', webSearch: true },
  glm: { name: 'GLM API', protocol: 'chat', baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: '', billingMode: 'payg', webSearch: true },
  minimax: { name: 'MiniMax API', protocol: 'anthropic', baseURL: 'https://api.minimax.cn/anthropic/v1', model: '', billingMode: 'payg', webSearch: true },
  openrouter: { name: 'OpenRouter', protocol: 'chat', baseURL: 'https://openrouter.ai/api/v1', model: 'openrouter/auto' },
  openai: { name: 'OpenAI API', protocol: 'responses', baseURL: 'https://api.openai.com/v1', model: '', tokenField: 'max_completion_tokens' },
  gemini: { name: 'Gemini API', protocol: 'gemini', baseURL: 'https://generativelanguage.googleapis.com/v1beta', model: '' },
  anthropic: { name: 'Anthropic API', protocol: 'anthropic', baseURL: 'https://api.anthropic.com/v1', model: '' },
  'codex-account': { name: 'ChatGPT 账户', protocol: 'codex-account', model: '', executable: '' },
  'antigravity-account': { name: 'Antigravity 账户', protocol: 'antigravity-account', model: '', executable: '' },
  custom: { name: '自定义连接', protocol: 'chat', baseURL: '', model: '' }
};
export function newProfile(preset = 'deepseek'): Profile {
  return { id: `p${Date.now()}${Math.random().toString(36).slice(2, 6)}`, preset, protocol: 'chat', baseURL: '', model: '', maxTokens: 4096, contextTokens: 200000, autoCompactPercent: 85, reasoning: '', tokenField: 'max_tokens', extra: '{}', headers: '{}', executable: '', args: '[]', ...presets[preset] };
}
