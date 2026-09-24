import type { FigureImage, SourceImage } from './types.ts';

export const figureAssetName = /^[a-f0-9]{64}\.(?:png|jpg|webp)$/;
export const safeAssetPath = (path: string) => !!path && !/[<>:"\\|?*\x00-\x1f]/.test(path) && path.split('/').every(p => !!p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
export function figureMetadata(image: FigureImage): FigureImage {
  return { asset: image.asset, mimeType: image.mimeType, width: image.width, height: image.height, ...(image.file ? { file: image.file } : {}) };
}
export async function originalFigure(bytes: Uint8Array, mimeType: FigureImage['mimeType'], width: number, height: number): Promise<FigureImage> {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  const asset = [...hash].map(n => n.toString(16).padStart(2, '0')).join('') + (mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/png' ? '.png' : '.webp');
  return { asset, mimeType, width, height, bytes };
}
export function figurePath(image: FigureImage, directory = image.directory): string {
  if (!directory || !figureAssetName.test(image.asset) || (image.file && !safeAssetPath(image.file))) throw new Error('文献图片引用无效，请重新读取文献');
  return PathUtils.join(directory, ...(image.file || image.asset).split('/'));
}
export async function figureBytes(image: SourceImage): Promise<Uint8Array> {
  if (image.bytes) return image.bytes;
  const path = figurePath(image);
  if (!await IOUtils.exists(path)) throw new Error('文献原图文件缺失，请新建对话并重新读取文献');
  return IOUtils.read(path);
}
export async function saveFigure(image: SourceImage, directory: string): Promise<FigureImage> {
  const path = figurePath({ ...image, file: undefined }, directory);
  if (!await IOUtils.exists(path)) {
    const bytes = await figureBytes(image);
    await IOUtils.makeDirectory(directory, { ignoreExisting: true, createAncestors: true });
    await IOUtils.write(path, bytes, { tmpPath: path + '.tmp' });
  }
  return { ...figureMetadata(image), file: undefined, directory };
}
