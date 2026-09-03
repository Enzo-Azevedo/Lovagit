import { useCallback, useState } from 'react';
import {
  MAX_IMAGES_PER_MESSAGE,
  rejectionReason,
  SUPPORTED_IMAGE_TYPES,
} from '../lib/ai/vision';
import type { TurnImage } from '../lib/types';

export interface Attachment {
  id: string;
  name: string;
  mediaType: string;
  bytes: number;
  /** Base64 cru, sem o prefixo `data:`. */
  dataBase64: string;
}

/** `data:image/png;base64,AAA` -> `AAA`. */
export function stripDataUrlPrefix(dataUrl: string): string {
  const virgula = dataUrl.indexOf(',');
  return virgula === -1 ? dataUrl : dataUrl.slice(virgula + 1);
}

export function toPreviewUrl(attachment: Attachment): string {
  return `data:${attachment.mediaType};base64,${attachment.dataBase64}`;
}

export function toTurnImages(attachments: Attachment[]): TurnImage[] {
  return attachments.map((anexo) => ({
    mediaType: anexo.mediaType,
    dataBase64: anexo.dataBase64,
  }));
}

async function readAsBase64(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  // `btoa` sobre uma string gigante estoura a pilha; em blocos, nao.
  let binario = '';
  const bloco = 0x8000;
  for (let i = 0; i < bytes.length; i += bloco) {
    binario += String.fromCharCode(...bytes.subarray(i, i + bloco));
  }
  return btoa(binario);
}

let contador = 0;

/**
 * Anexos do turno que esta sendo escrito.
 *
 * Vivem so em memoria: nada aqui e' persistido, porque a imagem so acompanha o
 * turno em que foi anexada.
 */
export function useAttachments() {
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);

  const addFiles = useCallback(
    async (files: File[]) => {
      const recusas: string[] = [];
      const aceitos: Attachment[] = [];

      for (const file of files) {
        const motivo = rejectionReason(file);
        if (motivo) {
          recusas.push(motivo);
          continue;
        }
        contador += 1;
        aceitos.push({
          id: `anexo_${Date.now().toString(36)}_${contador}`,
          name: file.name || `imagem-${contador}`,
          mediaType: file.type,
          bytes: file.size,
          dataBase64: await readAsBase64(file),
        });
      }

      // O teto e' conferido AQUI, e nao dentro do `setAttachments`: um efeito
      // colateral dentro do atualizador roda duas vezes em StrictMode, e o
      // `setAttachError` logo abaixo leria a lista de recusas antes de ela ser
      // preenchida — o aviso de limite nunca apareceria.
      const espaco = Math.max(0, MAX_IMAGES_PER_MESSAGE - attachments.length);
      const entram = aceitos.slice(0, espaco);
      if (aceitos.length > espaco) {
        recusas.push(`Maximo de ${MAX_IMAGES_PER_MESSAGE} imagens por mensagem.`);
      }

      if (entram.length > 0) setAttachments((atuais) => [...atuais, ...entram]);
      setAttachError(recusas.length > 0 ? recusas.join(' ') : null);
    },
    [attachments.length],
  );

  const remove = useCallback((id: string) => {
    setAttachments((atuais) => atuais.filter((anexo) => anexo.id !== id));
    setAttachError(null);
  }, []);

  const clear = useCallback(() => {
    setAttachments([]);
    setAttachError(null);
  }, []);

  return { attachments, attachError, addFiles, remove, clear };
}

/**
 * Extrai as imagens do clipboard — SINCRONO, de proposito.
 *
 * `clipboardData` so e' valido enquanto o evento esta sendo despachado: ler os
 * itens depois de um `await` devolve lista vazia. E `preventDefault` depois do
 * evento nao previne nada, entao quem chama precisa decidir na hora.
 */
export function imageFilesFrom(items: DataTransferItemList | null): File[] {
  const arquivos: File[] = [];
  for (const item of Array.from(items ?? [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (file && SUPPORTED_IMAGE_TYPES.includes(file.type)) arquivos.push(file);
  }
  return arquivos;
}
