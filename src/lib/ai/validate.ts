import Anthropic from '@anthropic-ai/sdk';
import type { ProviderConfig } from '../types';

/**
 * Valida a credencial na hora de salvar e ja traz os modelos que a conta
 * enxerga. Sem isso o usuario so descobre que errou a chave na primeira
 * mensagem do chat — e sem saber se o problema e a chave, o modelo ou a URL.
 */

export interface ValidationResult {
  ok: boolean;
  message: string;
  /** Identificadores de modelo disponiveis, para o seletor. */
  models: string[];
}

async function validateAnthropic(baseUrl: string, apiKey: string): Promise<ValidationResult> {
  const client = new Anthropic({
    apiKey,
    baseURL: baseUrl || undefined,
    dangerouslyAllowBrowser: true,
    maxRetries: 1,
  });
  try {
    const page = await client.models.list({ limit: 50 });
    const models = page.data.map((model) => model.id);
    return {
      ok: true,
      message: `Chave valida — ${models.length} modelo(s) disponiveis nesta conta.`,
      models,
    };
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, message: 'Chave recusada pela Anthropic (401).', models: [] };
    }
    if (error instanceof Anthropic.APIError) {
      return { ok: false, message: `Anthropic respondeu ${error.status}: ${error.message}`, models: [] };
    }
    return {
      ok: false,
      message:
        error instanceof Error
          ? `Falha ao contatar a Anthropic: ${error.message}`
          : 'Falha desconhecida ao contatar a Anthropic.',
      models: [],
    };
  }
}

async function validateOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  label: string,
): Promise<ValidationResult> {
  const url = `${baseUrl.replace(/\/+$/, '')}/models`;
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        message: `${label} respondeu ${response.status}: ${detail.slice(0, 200) || response.statusText}`,
        models: [],
      };
    }
    const payload = (await response.json()) as { data?: { id?: string }[] };
    const models = (payload.data ?? [])
      .map((model) => model.id)
      .filter((id): id is string => typeof id === 'string')
      .sort();
    return {
      ok: true,
      message:
        models.length > 0
          ? `Chave valida — ${models.length} modelo(s) disponiveis.`
          : 'Chave aceita, mas o endpoint nao listou modelos. Informe o identificador a mao.',
      models,
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error
          ? `Nao foi possivel alcancar ${url}: ${error.message}`
          : `Nao foi possivel alcancar ${url}.`,
      models: [],
    };
  }
}

export async function validateProviderKey(
  config: ProviderConfig,
  apiKey: string,
): Promise<ValidationResult> {
  if (!apiKey.trim()) return { ok: false, message: 'Informe a chave.', models: [] };
  if (config.kind === 'anthropic') return validateAnthropic(config.baseUrl, apiKey.trim());
  if (!config.baseUrl.trim()) {
    return { ok: false, message: 'Informe a URL base do endpoint.', models: [] };
  }
  return validateOpenAICompatible(config.baseUrl, apiKey.trim(), config.label);
}
