import type { ProviderConfig, ProviderKind } from '../types';

export interface ProviderPreset {
  key: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  /** Vazio = o usuario precisa informar o identificador do modelo. */
  model: string;
  modelHint: string;
  docsUrl?: string;
  /** Campos extras exibidos no formulario (usado pelo preset OAuth). */
  needsOAuthFields?: boolean;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: 'anthropic',
    label: 'Claude (Anthropic)',
    kind: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-opus-5',
    modelHint: 'claude-opus-5 (padrao), claude-sonnet-5, claude-haiku-4-5',
    docsUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    key: 'openai',
    label: 'OpenAI',
    kind: 'openai-compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: '',
    modelHint: 'Cole o identificador exato do modelo da sua conta',
    docsUrl: 'https://platform.openai.com/api-keys',
  },
  {
    key: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai-compatible',
    baseUrl: 'https://openrouter.ai/api/v1',
    model: '',
    modelHint: 'Ex.: vendor/modelo, como aparece no catalogo do OpenRouter',
    docsUrl: 'https://openrouter.ai/keys',
  },
  {
    key: 'groq',
    label: 'Groq',
    kind: 'openai-compatible',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: '',
    modelHint: 'Identificador do modelo no console da Groq',
    docsUrl: 'https://console.groq.com/keys',
  },
  {
    key: 'custom',
    label: 'Endpoint compativel com OpenAI (self-hosted, gateway, LM Studio...)',
    kind: 'openai-compatible',
    baseUrl: '',
    model: '',
    modelHint: 'Identificador do modelo aceito pelo seu endpoint',
  },
  {
    // Anthropic e OpenAI nao oferecem OAuth para acesso a API por terceiros:
    // a Anthropic restringe o fluxo ao Claude Code e ao claude.ai, e o
    // "Sign in with ChatGPT" e identidade, nao acesso a API. Este preset serve
    // para provedores que de fato expoem OAuth para a propria API.
    key: 'oauth',
    label: 'Login OAuth (provedor que ofereca OAuth para a API)',
    kind: 'oauth',
    baseUrl: '',
    model: '',
    modelHint: 'Identificador do modelo aceito pelo provedor',
    needsOAuthFields: true,
  },
];

export function providerFromPreset(preset: ProviderPreset): ProviderConfig {
  const base = {
    id: `${preset.key}-${Date.now().toString(36)}`,
    label: preset.label,
    model: preset.model,
    maxTokens: 16000,
  };
  if (preset.kind === 'anthropic') {
    return { ...base, kind: 'anthropic', baseUrl: preset.baseUrl };
  }
  if (preset.kind === 'oauth') {
    return {
      ...base,
      kind: 'oauth',
      baseUrl: preset.baseUrl,
      authorizationUrl: '',
      tokenUrl: '',
      clientId: '',
      scopes: [],
    };
  }
  return { ...base, kind: 'openai-compatible', baseUrl: preset.baseUrl };
}
