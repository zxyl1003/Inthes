import type { ChatInput, ImageInput, ModelOption, Profile, SourceImage, FigureImage } from './types.ts';
import { figureBytes, originalFigure } from './figure-assets.ts';

export const imageURL = (image: ImageInput) => `data:${image.mimeType};base64,${image.data}`;
export const imageGenerationUnsupported = '当前连接不支持图片生成，请切换到 ChatGPT 账户。';
// Image tokenization varies by provider. Reserve a conservative patch estimate, not base64 text tokens.
const requestSize = (image: SourceImage | ImageInput) => { const scale = 'asset' in image ? Math.min(1, 2048 / Math.max(image.width, image.height)) : 1; return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) }; };
export const imageTokens = (images: (SourceImage | ImageInput)[] = []) => images.reduce((n,i)=>{const size=requestSize(i);return n+Math.max(2048,Math.ceil(size.width/32)*Math.ceil(size.height/32)*2);},0);
export function discoveredVision(model: any): Pick<ModelOption,'vision'> {
  const modalities=model.architecture?.input_modalities??model.inputModalities??model.input_modalities;
  if(Array.isArray(modalities))return {vision:modalities.includes('image')};
  if(typeof model.capabilities?.image_input?.supported==='boolean')return {vision:model.capabilities.image_input.supported};
  return {};
}
export function supportsImages(p: Profile, models = p.models || []): boolean | undefined {
  if(p.protocol==='antigravity-account')return false;
  const reported=models.find(m=>m.id===p.model)?.vision;
  if(reported!==undefined)return reported;
  return p.visionOverrides?.[p.model];
}
export function imageModelError(p: Profile, models = p.models || []) {
  if(p.protocol==='antigravity-account')return 'Antigravity CLI 当前的流式接口仅支持文字，请切换支持图片的连接。';
  const supported=supportsImages(p,models);
  return supported===true?'':supported===false?'当前模型不支持图片，请切换支持图片的模型。':'尚未确认当前模型的图片能力。请刷新模型列表、切换支持图片的模型，或在连接的高级设置中确认图片能力。';
}
export async function documentImage(win: any, bytes: Uint8Array, name: string): Promise<FigureImage> {
  const mimeType = /\.png$/i.test(name) ? 'image/png' : /\.jpe?g$/i.test(name) ? 'image/jpeg' : /\.webp$/i.test(name) ? 'image/webp' : '';
  if (!mimeType) throw new Error('MinerU 返回了不支持的图片格式');
  const url = win.URL.createObjectURL(new win.Blob([bytes], { type: mimeType }));
  try {
    const image = new win.Image(); image.src = url; await image.decode();
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 64 * 1024 * 1024) throw new Error('文献图片尺寸过大或无法读取');
    return { ...await originalFigure(bytes, mimeType, image.naturalWidth, image.naturalHeight), file: name };
  } finally { win.URL.revokeObjectURL(url); }
}
export async function generatedFigure(win: any, data: string): Promise<FigureImage> {
  const encoded=data.replace(/^data:image\/png;base64,/, '');
  if(!encoded.length||encoded.length>32*1024*1024||!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))throw new Error('生成的图片数据无效或超过 24 MB');
  const bytes=Uint8Array.from(atob(encoded),c=>c.charCodeAt(0));
  if(![137,80,78,71,13,10,26,10].every((v,i)=>bytes[i]===v))throw new Error('组件返回的图片不是有效的 PNG');
  const image=await documentImage(win,bytes,'generated.png');delete image.file;return image;
}
export async function figureInput(win: any, image: SourceImage, signal: AbortSignal): Promise<ImageInput> {
  signal.throwIfAborted();
  const bytes = await figureBytes(image); signal.throwIfAborted();
  const size = requestSize(image);
  if (size.width === image.width && size.height === image.height) {
    const parts: string[] = [];
    for (let i = 0; i < bytes.length; i += 8192) parts.push(String.fromCharCode(...bytes.subarray(i, i + 8192)));
    return { ...size, mimeType: image.mimeType, data: btoa(parts.join('')) };
  }
  const url = win.URL.createObjectURL(new win.Blob([bytes], { type: image.mimeType }));
  try {
    const decoded = new win.Image(); decoded.src = url; await decoded.decode(); signal.throwIfAborted();
    const canvas = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas');
    canvas.width = size.width; canvas.height = size.height;
    const ctx = canvas.getContext('2d')!; ctx.drawImage(decoded, 0, 0, size.width, size.height);
    const data = canvas.toDataURL(image.mimeType, .95).split(',')[1];
    return { data, mimeType: image.mimeType, ...size };
  } finally { win.URL.revokeObjectURL(url); }
}
// Codex has a single prompt: keep image blocks beside their original message.
export function accountPrompt(input: ChatInput): any[] {
  return input.messages.flatMap(m=>[
    {type:'text',text:`${m.role==='user'?'用户':'助手'}：${m.content}`,text_elements:[]},
    ...(m.images||[]).map(i=>({type:'image',url:imageURL(i)}))
  ]);
}
