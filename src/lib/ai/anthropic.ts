import Anthropic from '@anthropic-ai/sdk';
import type { AnthropicProviderConfig, ToolCall } from '../types';
import { ProviderError, type AIProvider, type CompletionRequest, type CompletionResponse } from './types';

/**
 * Provedor Claude via SDK oficial. `dangerouslyAllowBrowser` e' obrigatorio em
 * contexto de navegador — o SDK entao envia
 * `anthropic-dangerous-direct-browser-access: true`, que a API exige para
 * aceitar requisicoes com header Origin. A chave e' do proprio usuario (BYOK),
 * fica no cofre cifrado e nunca sai da maquina dele a nao ser para a Anthropic.
 */
export function createAnthropicProvider(
  config: AnthropicProviderConfig,
  apiKey: string,
): AIProvider {
  const client = new Anthropic({
    apiKey,
    baseURL: config.baseUrl || undefined,
    dangerouslyAllowBrowser: true,
    maxRetries: 2,
  });

  return {
    id: config.id,
    label: config.label,
    model: config.model,
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      const messages: Anthropic.MessageParam[] = request.turns.map((turn) => {
        if (turn.role === 'user') {
          const content: Anthropic.ContentBlockParam[] = [
            ...(turn.toolResults ?? []).map<Anthropic.ContentBlockParam>((result) => ({
              type: 'tool_result',
              tool_use_id: result.toolCallId,
              content: result.content,
              is_error: result.isError ?? false,
            })),
            ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          ];
          return { role: 'user', content };
        }
        const content: Anthropic.ContentBlockParam[] = [
          ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
          ...(turn.toolCalls ?? []).map<Anthropic.ContentBlockParam>((call) => ({
            type: 'tool_use',
            id: call.id,
            name: call.name,
            input: call.input,
          })),
        ];
        return { role: 'assistant', content };
      });

      try {
        const stream = client.messages.stream(
          {
            model: config.model,
            max_tokens: config.maxTokens,
            system: request.system,
            messages,
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
            })),
          },
          { signal: request.signal },
        );

        if (request.onText) stream.on('text', request.onText);
        const message = await stream.finalMessage();

        const text = message.content
          .filter((block): block is Anthropic.TextBlock => block.type === 'text')
          .map((block) => block.text)
          .join('');
        const toolCalls: ToolCall[] = message.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
          .map((block) => ({
            id: block.id,
            name: block.name,
            input: (block.input ?? {}) as Record<string, unknown>,
          }));

        return {
          text,
          toolCalls,
          stopReason: message.stop_reason ?? 'end_turn',
          usage: {
            inputTokens: message.usage.input_tokens,
            outputTokens: message.usage.output_tokens,
          },
        };
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          throw new ProviderError('Chave da Anthropic invalida ou sem permissao.', error);
        }
        if (error instanceof Anthropic.RateLimitError) {
          throw new ProviderError('Limite de uso da Anthropic atingido. Tente em instantes.', error);
        }
        if (error instanceof Anthropic.APIError) {
          throw new ProviderError(`Anthropic (${error.status}): ${error.message}`, error);
        }
        throw error;
      }
    },
  };
}
