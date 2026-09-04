import type { ProviderConfig } from '../types';
import { getSecret, SecretNames } from '../vault';
import { createAnthropicProvider } from './anthropic';
import { createOpenAICompatibleProvider } from './openai-compatible';
import { getValidAccessToken } from './oauth';
import { ProviderError, type AIProvider } from './types';

/**
 * Le a chave do cofre, tratando "so espacos" como ausente.
 *
 * Sem o `trim`, uma chave de espacos passava pela verificacao (string truthy) e
 * saia como `Bearer   ` — que o provedor recusa com um 401 falando de header
 * ausente, mandando o usuario procurar o problema no lugar errado.
 */
async function lerChave(config: ProviderConfig): Promise<string> {
  const apiKey = (await getSecret(SecretNames.providerApiKey(config.id)))?.trim();
  if (!apiKey) throw new ProviderError(`Configure a chave de API de ${config.label}.`, 'auth');
  return apiKey;
}

/** Instancia o provedor ativo. As credenciais saem do cofre so aqui. */
export async function createProvider(config: ProviderConfig): Promise<AIProvider> {
  switch (config.kind) {
    case 'anthropic': {
      const apiKey = await lerChave(config);
      return createAnthropicProvider(config, apiKey);
    }
    case 'openai-compatible': {
      const apiKey = await lerChave(config);
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
    case 'oauth':
      return createOpenAICompatibleProvider({
        id: config.id,
        label: config.label,
        model: config.model,
        maxTokens: config.maxTokens,
        temperature: config.temperature,
        baseUrl: config.baseUrl,
        getAuthToken: () => getValidAccessToken(config),
      });
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
