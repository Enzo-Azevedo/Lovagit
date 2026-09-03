import { describe, expect, it } from 'vitest';
import { toOpenAIMessages } from '../ai/openai-compatible';
import { assertNoForeignRepoLeak, createScope, leakCheckPayload } from '../agent/isolation';
import { historyToTurns, withAttachmentNote } from '../agent/loop';
import type { ChatMessage } from '../types';

const escopo = createScope({
  id: 'acme/site',
  owner: 'acme',
  name: 'site',
  defaultBranch: 'main',
  htmlUrl: 'https://github.com/acme/site',
  private: false,
});

const imagem = { mediaType: 'image/png', dataBase64: 'QUJD' };

describe('imagem no formato OpenAI', () => {
  it('manda texto puro como string — array quebra endpoint mais simples', () => {
    const messages = toOpenAIMessages({
      system: 's',
      tools: [],
      turns: [{ role: 'user', text: 'ajuste o header' }],
    });
    expect(messages[1].content).toBe('ajuste o header');
  });

  it('vira partes com data URL quando ha imagem', () => {
    const messages = toOpenAIMessages({
      system: 's',
      tools: [],
      turns: [{ role: 'user', text: 'o que ha de errado aqui?', images: [imagem] }],
    });

    expect(messages[1].content).toEqual([
      { type: 'text', text: 'o que ha de errado aqui?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });

  it('aceita imagem sem texto', () => {
    const messages = toOpenAIMessages({
      system: 's',
      tools: [],
      turns: [{ role: 'user', images: [imagem] }],
    });
    expect(messages[1].content).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
    ]);
  });
});

describe('leakCheckPayload', () => {
  it('troca o base64 por um marcador', () => {
    const texto = leakCheckPayload({ turns: [{ images: [{ dataBase64: 'AAAA' }] }] });
    expect(texto).not.toContain('AAAA');
    expect(texto).toContain('imagem: 4 caracteres');
  });

  it('impede que o alfabeto do base64 dispare um vazamento falso', () => {
    // O base64 usa `/`, entao uma imagem grande pode conter por acaso algo com
    // a forma `dono/projeto`. Sem a limpeza, o turno abortaria por um vazamento
    // que nunca existiu.
    const bytesComRepoPorAcaso = `xx${'acme/outro'}xx`;
    const payload = { system: 'nada suspeito', turns: [{ images: [{ dataBase64: bytesComRepoPorAcaso }] }] };

    expect(() =>
      assertNoForeignRepoLeak(escopo, JSON.stringify(payload), ['acme/site', 'acme/outro'], ''),
    ).toThrow();

    expect(() =>
      assertNoForeignRepoLeak(escopo, leakCheckPayload(payload), ['acme/site', 'acme/outro'], ''),
    ).not.toThrow();
  });

  it('continua pegando vazamento de verdade no texto', () => {
    const payload = { system: 'compare com acme/outro', turns: [] };
    expect(() =>
      assertNoForeignRepoLeak(escopo, leakCheckPayload(payload), ['acme/site', 'acme/outro'], ''),
    ).toThrow();
  });
});

describe('anexo no historico', () => {
  const comAnexo: ChatMessage = {
    id: '1',
    repoId: 'acme/site',
    role: 'user',
    content: 'o que ha de errado nesta tela?',
    attachments: [{ name: 'tela.png', mediaType: 'image/png', bytes: 1024 }],
    createdAt: 0,
  };

  it('marca no texto que houve imagem, ja que ela nao volta', () => {
    // Sem a marca, o modelo leria a pergunta sem tela nenhuma e responderia
    // com chute em vez de pedir a imagem de novo.
    const texto = withAttachmentNote(comAnexo);
    expect(texto).toContain('o que ha de errado nesta tela?');
    expect(texto).toContain('tela.png');
    expect(texto).toContain('nao estao mais visiveis');
  });

  it('nao mexe em mensagem sem anexo', () => {
    expect(withAttachmentNote({ ...comAnexo, attachments: undefined })).toBe(comAnexo.content);
  });

  it('o historico nunca reenvia imagem — so a marca', () => {
    const turnos = historyToTurns([comAnexo]);
    expect(turnos[0].images).toBeUndefined();
    expect(turnos[0].text).toContain('tela.png');
  });
});
