import { describe, expect, it } from 'vitest';
import {
  isUnknownModelError,
  kindForStreamErrorCode,
  providerKindForResponse,
} from '../ai/openai-compatible';
import { classifyError } from '../telemetry/classify';
import { ProviderError } from '../ai/types';

/**
 * Modelo digitado errado nas configuracoes nao e' defeito da extensao — e quem
 * abriu o issue #17 foi exatamente isso. O balde `unavailable` ja existia para
 * "modelo nao existe", mas so alcancava 402 e 404; o OpenRouter recusa um
 * identificador invalido com 400, e ai o erro caia em `http` -> `bug`.
 */

const CORPO_OPENROUTER =
  '{"error":{"message":"ope is not a valid model ID","code":400},"user_id":"user_abc"}';

describe('isUnknownModelError', () => {
  it('reconhece a recusa do OpenRouter', () => {
    expect(isUnknownModelError(CORPO_OPENROUTER)).toBe(true);
  });

  it('reconhece as outras frases usadas pelos compativeis com OpenAI', () => {
    const frases = [
      '{"error":{"message":"The model `gpt-9` does not exist","type":"invalid_request_error"}}',
      '{"error":{"code":"model_not_found","message":"model not found"}}',
      '{"error":{"message":"Unknown model: llama-99b"}}',
      '{"error":{"message":"No such model"}}',
    ];
    for (const frase of frases) {
      expect(isUnknownModelError(frase), frase).toBe(true);
    }
  });

  it('nao confunde com um payload que a extensao montou errado', () => {
    const frases = [
      '{"error":{"message":"Invalid value for \'temperature\': expected number"}}',
      '{"error":{"message":"messages: array too short"}}',
      '{"error":{"message":"tools[0].function.name is required"}}',
      '',
    ];
    for (const frase of frases) {
      expect(isUnknownModelError(frase), frase).toBe(false);
    }
  });
});

describe('providerKindForResponse', () => {
  it('rebaixa o 400 de modelo inexistente para configuracao do usuario', () => {
    expect(providerKindForResponse(400, CORPO_OPENROUTER)).toBe('unavailable');
  });

  it('mantem 400 generico como http — payload errado e defeito nosso', () => {
    expect(providerKindForResponse(400, '{"error":{"message":"messages is required"}}')).toBe(
      'http',
    );
  });

  it('nao mexe no que o status ja decidiu', () => {
    // Um 401 que por acaso cite modelo continua sendo credencial recusada.
    expect(providerKindForResponse(401, 'invalid model, and invalid key')).toBe('auth');
    expect(providerKindForResponse(429, 'unknown model')).toBe('rate-limit');
    expect(providerKindForResponse(500, 'unknown model')).toBe('rate-limit');
    expect(providerKindForResponse(404, 'qualquer coisa')).toBe('unavailable');
  });
});

describe('kindForStreamErrorCode com a mensagem em banda', () => {
  it('rebaixa o erro em banda de modelo inexistente', () => {
    expect(kindForStreamErrorCode(400, 'ope is not a valid model ID')).toBe('unavailable');
  });

  it('vale tambem quando o frame nao traz codigo', () => {
    expect(kindForStreamErrorCode(undefined, 'ope is not a valid model ID')).toBe('unavailable');
    expect(kindForStreamErrorCode(undefined, 'stream cortado')).toBe('http');
  });

  it('preserva o comportamento de quem so manda o codigo', () => {
    expect(kindForStreamErrorCode(404)).toBe('unavailable');
    expect(kindForStreamErrorCode(undefined)).toBe('http');
  });
});

describe('classificacao final — o issue #17 nao teria sido aberto', () => {
  it('modelo inexistente vira user-config e nao abre issue', () => {
    const classificacao = classifyError(
      new ProviderError(
        `OpenRouter respondeu 400: ${CORPO_OPENROUTER}`,
        providerKindForResponse(400, CORPO_OPENROUTER),
      ),
    );
    expect(classificacao.category).toBe('user-config');
    expect(classificacao.category).not.toBe('bug');
  });

  it('400 de payload continua virando issue — esse defeito e nosso', () => {
    const corpo = '{"error":{"message":"messages is required"}}';
    const classificacao = classifyError(
      new ProviderError(
        `OpenRouter respondeu 400: ${corpo}`,
        providerKindForResponse(400, corpo),
      ),
    );
    expect(classificacao.category).toBe('bug');
  });
});
