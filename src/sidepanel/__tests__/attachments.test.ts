import { describe, expect, it } from 'vitest';
import { imageFilesFrom, stripDataUrlPrefix, toPreviewUrl, toTurnImages } from '../useAttachments';

function item(kind: string, file: { type: string; name: string } | null): DataTransferItem {
  return { kind, getAsFile: () => file } as unknown as DataTransferItem;
}

function lista(itens: DataTransferItem[]): DataTransferItemList {
  return itens as unknown as DataTransferItemList;
}

describe('imageFilesFrom', () => {
  it('pega so as imagens de formato aceito', () => {
    const arquivos = imageFilesFrom(
      lista([
        item('file', { type: 'image/png', name: 'tela.png' }),
        item('file', { type: 'application/pdf', name: 'doc.pdf' }),
        item('string', null),
        item('file', { type: 'image/webp', name: 'foto.webp' }),
      ]),
    );

    expect(arquivos.map((f) => f.name)).toEqual(['tela.png', 'foto.webp']);
  });

  it('nao quebra sem clipboard', () => {
    expect(imageFilesFrom(null)).toEqual([]);
    expect(imageFilesFrom(lista([]))).toEqual([]);
  });

  it('ignora item que se diz arquivo mas nao entrega nenhum', () => {
    expect(imageFilesFrom(lista([item('file', null)]))).toEqual([]);
  });
});

describe('conversao de anexo', () => {
  const anexo = {
    id: 'a1',
    name: 'tela.png',
    mediaType: 'image/png',
    bytes: 3,
    dataBase64: 'QUJD',
  };

  it('monta a data URL da previa', () => {
    expect(toPreviewUrl(anexo)).toBe('data:image/png;base64,QUJD');
  });

  it('manda ao modelo so o tipo e o base64 cru', () => {
    expect(toTurnImages([anexo])).toEqual([{ mediaType: 'image/png', dataBase64: 'QUJD' }]);
  });

  it('tira o prefixo data: sem estragar base64 que ja vem cru', () => {
    expect(stripDataUrlPrefix('data:image/png;base64,QUJD')).toBe('QUJD');
    expect(stripDataUrlPrefix('QUJD')).toBe('QUJD');
  });
});
