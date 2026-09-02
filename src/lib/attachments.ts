import type { ChatAttachment } from './types';

const MAX_IMAGE_DIM = 1280;
/** Teto de anexos por mensagem. Com `unlimitedStorage`, armazenamento nao e mais
 *  o gargalo; o limite existe so para controlar tokens e o tamanho do turno. */
const MAX_ATTACHMENTS_PER_MESSAGE = 3;

/** Converte um arquivo em anexo, redimensionando no cliente para controlar
 *  tokens. PNG fica PNG; o resto vira JPEG (menor para screenshots). */
export async function fileToAttachment(file: File): Promise<ChatAttachment> {
  const bitmap = await createImageBitmap(file);
  const image = bitmap as HTMLImageElement | ImageBitmap;
  const scale = Math.min(1, MAX_IMAGE_DIM / Math.max(image.width, image.height));

  if (scale < 1) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
    const mimeType = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    const quality = mimeType === 'image/png' ? undefined : 0.85;
    return finalize(canvas.toDataURL(mimeType, quality), file.name, mimeType);
  }

  // Imagem pequena demais para redimensionar: converte para base64 direto.
  const buffer = await file.arrayBuffer();
  let bin = '';
  for (const byte of new Uint8Array(buffer)) bin += String.fromCharCode(byte);
  const dataBase64 = btoa(bin);
  return { name: file.name, mimeType: file.type || 'image/png', dataBase64 };
}

function finalize(dataUrl: string, name: string, mimeType: string): ChatAttachment {
  const dataBase64 = dataUrl.slice(dataUrl.indexOf('base64,') + 'base64,'.length);
  return { name, mimeType, dataBase64 };
}

export function canAcceptMoreAttachments(current: ChatAttachment[]): boolean {
  return current.length < MAX_ATTACHMENTS_PER_MESSAGE;
}

export const MAX_ATTACHMENTS = MAX_ATTACHMENTS_PER_MESSAGE;
