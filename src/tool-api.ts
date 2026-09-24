import type { ImageInput, Profile, ToolCall, ToolDefinition, ToolOutput } from './types.ts';
import { imageTokens, imageURL } from './images.ts';
import { estimateTokens } from './context.ts';

const toolImages = new WeakMap<object, ImageInput>();
const imageBlock = (image: ImageInput, block: any) => { toolImages.set(block, image); return block; };
export function toolHistoryBudget(history: any[]) {
  const images: { block: any; image: ImageInput }[] = [];
  const text = JSON.stringify(history, (_key, value) => {
    const image = value && typeof value === 'object' ? toolImages.get(value) : undefined;
    if (image) { images.push({ block: value, image }); return undefined; }
    return value;
  });
  return { tokens: estimateTokens(text) + imageTokens(images.map(i => i.image)), bytes: images.reduce((n, i) => n + i.image.data.length, 0), images };
}
export function trimToolImages(history: any[], protocol: Profile['protocol'], tokens: number, bytes: number) {
  let budget = toolHistoryBudget(history), removed = 0;
  for (const { block } of budget.images) {
    if (budget.tokens <= tokens && budget.bytes <= bytes) break;
    for (const key of Object.keys(block)) delete block[key];
    Object.assign(block, { ...(protocol === 'gemini' ? {} : { type: protocol === 'responses' ? 'input_text' : 'text' }), text: '[此处原图因请求容量限制已退出上下文，仅保留工具返回的文字和图注；需要视觉细节时请重新读取。]' });
    toolImages.delete(block); removed++; budget = toolHistoryBudget(history);
  }
  return { ...budget, removed };
}

// Keep the provider's assistant blocks intact: reasoning signatures are part of
// the tool-call protocol, even though Folio never displays or persists them.
export class ToolTurn {
  private blocks: any[] = [];
  private chat: any = { role: 'assistant', content: '' };
  private arguments = new Map<number, string>();
  calls: ToolCall[] = [];
  protocol: Profile['protocol']; definitions: ToolDefinition[]; history: any[];
  constructor(protocol: Profile['protocol'], definitions: ToolDefinition[], history: any[] = []) { this.protocol=protocol; this.definitions=definitions; this.history=history; }
  configure(body: Record<string, any>) {
    if (this.protocol === 'chat') {
      body.tools = this.definitions.map(t => ({ type: 'function', function: t }));
      body.tool_choice = 'auto'; body.messages.push(...this.history);
    } else if (this.protocol === 'responses') {
      body.tools = this.definitions.map(t => ({ type: 'function', ...t, strict: false }));
      body.tool_choice = 'auto'; body.input.push(...this.history);
      body.include = [...new Set([...(body.include || []), 'reasoning.encrypted_content'])];
    } else if (this.protocol === 'anthropic') {
      body.tools = this.definitions.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      body.tool_choice = { type: 'auto' }; body.messages.push(...this.history);
    } else if (this.protocol === 'gemini') {
      body.tools = [{ functionDeclarations: this.definitions.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }; body.contents.push(...this.history);
    }
  }
  accept(data: any, streaming = true) {
    if (this.protocol === 'chat') {
      const delta = data.choices?.[0]?.[streaming ? 'delta' : 'message'];
      if (!delta) return;
      if (delta.content) this.chat.content += delta.content;
      if (delta.reasoning_content) this.chat.reasoning_content = (this.chat.reasoning_content || '') + delta.reasoning_content;
      if (delta.reasoning) this.chat.reasoning = (this.chat.reasoning || '') + delta.reasoning;
      if (delta.reasoning_details) {
        this.chat.reasoning_details ||= [];
        for (const detail of delta.reasoning_details) {
          const old = this.chat.reasoning_details.find((d: any) => d.index === detail.index && d.type === detail.type && d.id === detail.id);
          if (old && ['reasoning.text', 'reasoning.summary'].includes(detail.type)) {
            for (const field of ['text', 'summary', 'signature']) if (detail[field]) old[field] = (old[field] || '') + detail[field];
          } else this.chat.reasoning_details.push({ ...detail });
        }
      }
      for (const [i, call] of (delta.tool_calls || []).entries()) {
        const index = call.index ?? i;
        const part = this.blocks[index] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) part.id = call.id;
        if (call.function?.name) part.function.name += call.function.name;
        if (call.function?.arguments) part.function.arguments += call.function.arguments;
      }
    } else if (this.protocol === 'responses') {
      if (data.type === 'response.output_item.done') this.blocks[data.output_index] = data.item;
      if (data.response?.output) this.blocks = data.response.output;
      if (!streaming) this.blocks = data.output || [];
    } else if (this.protocol === 'anthropic') {
      if (!streaming) { this.blocks = data.content || []; return; }
      if (data.type === 'content_block_start') this.blocks[data.index] = { ...data.content_block };
      const block = this.blocks[data.index], delta = data.delta;
      if (data.type === 'content_block_delta' && block) {
        if (delta.type === 'input_json_delta') this.arguments.set(data.index, (this.arguments.get(data.index) || '') + delta.partial_json);
        if (delta.type === 'text_delta') block.text = (block.text || '') + delta.text;
        if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + delta.thinking;
        if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
      }
    } else if (this.protocol === 'gemini') {
      this.blocks.push(...(data.candidates?.[0]?.content?.parts || []));
    }
  }
  finish() {
    if (this.protocol === 'chat') this.calls = this.blocks.filter(Boolean).map(b => ({ id: b.id, name: b.function.name, arguments: JSON.parse(b.function.arguments) }));
    if (this.protocol === 'responses') this.calls = this.blocks.filter(b => b?.type === 'function_call').map(b => ({ id: b.call_id, name: b.name, arguments: JSON.parse(b.arguments) }));
    if (this.protocol === 'anthropic') {
      for (const [index, json] of this.arguments) this.blocks[index].input = JSON.parse(json);
      this.calls = this.blocks.filter(b => b?.type === 'tool_use').map(b => ({ id: b.id, name: b.name, arguments: b.input }));
    }
    if (this.protocol === 'gemini') this.calls = this.blocks.filter(b => b.functionCall).map((b, i) => ({ id: b.functionCall.id || `call_${i}`, name: b.functionCall.name, arguments: b.functionCall.args }));
    if (this.calls.length > 8 || this.calls.some(c => !c.id || !c.name) || new Set(this.calls.map(c => c.id)).size !== this.calls.length) throw new Error('服务返回了无效或过多的工具调用');
    return this.calls;
  }
  results(outputs: ToolOutput[]) {
    if (outputs.length !== this.calls.length) throw new Error('工具结果数量与请求不一致');
    if (this.protocol === 'chat') {
      this.history.push({ ...this.chat, tool_calls: this.blocks.filter(Boolean) });
      this.calls.forEach((c, i) => this.history.push({ role: 'tool', tool_call_id: c.id, content: outputs[i].text }));
      const images = outputs.flatMap(o => o.images || []);
      if (images.length) this.history.push({ role: 'user', content: [{ type: 'text', text: '以下按工具来源顺序排列图片或图片移除说明。视觉细节仅依据实际保留的图片，已移除图片只能依据文字和图注。' }, ...images.map(i => imageBlock(i, { type: 'image_url', image_url: { url: imageURL(i) } }))] });
    } else if (this.protocol === 'responses') {
      this.history.push(...this.blocks.filter(Boolean));
      this.calls.forEach((c, i) => this.history.push({ type: 'function_call_output', call_id: c.id, output: [{ type: 'input_text', text: outputs[i].text }, ...(outputs[i].images || []).map(image => imageBlock(image, { type: 'input_image', image_url: imageURL(image) }))] }));
    } else if (this.protocol === 'anthropic') {
      this.history.push({ role: 'assistant', content: this.blocks.filter(Boolean) }, { role: 'user', content: this.calls.map((c, i) => ({ type: 'tool_result', tool_use_id: c.id, content: [{ type: 'text', text: outputs[i].text }, ...(outputs[i].images || []).map(image => imageBlock(image, { type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }))] })) });
    } else if (this.protocol === 'gemini') {
      this.history.push({ role: 'model', parts: this.blocks }, { role: 'user', parts: this.calls.flatMap((c, i) => [{ functionResponse: { name: c.name, ...(this.blocks.find(b => b.functionCall?.id === c.id) ? { id: c.id } : {}), response: { result: outputs[i].text } } }, ...(outputs[i].images || []).map(image => imageBlock(image, { inlineData: { mimeType: image.mimeType, data: image.data } }))]) });
    }
    return this.history;
  }
}
