import type { ProviderConfig } from '../types';
import { getSecret, SecretNames } from '../vault';
import { createAnthropicProvider } from './anthropic';
import { createOpenAICompatibleProvider } from './openai-compatible';
import { ProviderError, type AIProvider } from './types';

/** Instancia o provedor ativo. As credenciais saem do cofre so aqui. */
export async function createProvider(config: ProviderConfig): Promise<AIProvider> {
  switch (config.kind) {
    case 'anthropic': {
      const apiKey = await getSecret(SecretNames.providerApiKey(config.id));
      if (!apiKey) throw new ProviderError(`Configure a chave de API de ${config.label}.`, 'auth');
      return createAnthropicProvider(config, apiKey);
    }
    case 'openai-compatible': {
      const apiKey = await getSecret(SecretNames.providerApiKey(config.id));
      if (!apiKey) throw new ProviderError(`Configure a chave de API de ${config.label}.`, 'auth');
      return createOpenAICompatibleProvider({
        id: config.id,
        label: config.label,
        model: config.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        baseUrl: config.baseUrl,
        getAuthToken: async () => apiKey,
      });
    }
    default: {
      const exhaustive: never = config;
      throw new ProviderError(`Tipo de provedor desconhecido: ${JSON.stringify(exhaustive)}`, 'protocol');
    }
  }
}

/** Origem que precisa de permissao de host antes da primeira chamada. */
export function providerOrigin(config: ProviderConfig): string | null {
  try {
    return `${new URL(config.baseUrl).origin}/*`;
  } catch {
    return null;
  }
}
