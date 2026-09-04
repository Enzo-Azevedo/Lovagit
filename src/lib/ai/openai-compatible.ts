import type { ToolCall } from '../types';
import {
  ProviderError,
  type AIProvider,
  type CompletionRequest,
  type CompletionResponse,
  type ProviderErrorKind,
} from './types';

/**
 * Cliente para qualquer endpoint no formato OpenAI (`POST /chat/completions`):
 * OpenAI, Groq, OpenRouter, Together, Gemini via camada compativel, LM Studio,
 * e tambem provedores autenticados por OAuth — a unica diferenca e' de onde vem
 * o Bearer token.
 */

/** Parte de uma mensagem multimodal. So aparece quando ha imagem: mandar texto
 *  sempre como array quebra endpoint compativel mais simples. */
type OpenAIContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export function toOpenAIMessages(request: CompletionRequest): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: 'system', content: request.system }];
  for (const turn of request.turns) {
    if (turn.role === 'user') {
      for (const result of turn.toolResults ?? []) {
        messages.push({
          role: 'tool',
          tool_call_id: result.toolCallId,
          content: result.isError ? `ERRO: ${result.content}` : result.content,
        });
      }
      const images = turn.images ?? [];
      if (images.length > 0) {
        messages.push({
          role: 'user',
          content: [
            ...(turn.text ? [{ type: 'text' as const, text: turn.text }] : []),
            ...images.map((image) => ({
              type: 'image_url' as const,
              image_url: { url: `data:${image.mediaType};base64,${image.dataBase64}` },
            })),
          ],
        });
      } else if (turn.text) {
        messages.push({ role: 'user', content: turn.text });
      }
      continue;
    }
    const toolCalls = turn.toolCalls ?? [];
    messages.push({
      role: 'assistant',
      content: turn.text ?? null,
      ...(toolCalls.length > 0
        ? {
            tool_calls: toolCalls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          }
        : {}),
    });
  }
  return messages;
}

interface StreamAccumulator {
  text: string;
  /** Raciocinio do modelo, quando ele separa isso do conteudo. */
  reasoning: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finishReason: string;
  usage: { inputTokens: number; outputTokens: number };
  /** Erro em banda: HTTP 200 com o problema dentro do proprio stream. */
  error?: { message: string; code?: number | string };
}

export interface StreamDelta {
  content?: string | null;
  /**
   * Modelos de raciocinio mandam a linha de pensamento aqui, e o nome do campo
   * varia por provedor. Ler so `content` faz a resposta chegar vazia quando o
   * modelo coloca tudo no raciocinio — e ai o turno termina sem nada na tela.
   */
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_text?: string | null;
  /**
   * O OpenRouter entrega o raciocinio tambem nesse formato, em array, um item
   * por bloco. Blocos cifrados (`reasoning.encrypted`) trazem `data` em vez de
   * texto e nao rendem nada legivel — ficam de fora.
   */
  reasoning_details?:
    | { type?: string; text?: string | null; summary?: string | null }[]
    | null;
  tool_calls?: {
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface StreamChunk {
  /**
   * Agregadores como o OpenRouter respondem HTTP 200 e reportam a falha DENTRO
   * do stream: um frame com `error` no topo e `choices` vazio. Ignorar esse
   * frame faz a resposta terminar vazia e parecer sucesso — o pior modo de
   * falha possivel, porque nao aparece erro nenhum para o usuario.
   */
  error?: { message?: string; code?: number | string };
  choices?: { delta?: StreamDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Le o raciocinio do delta, seja qual for o campo que o provedor usou. Sem
 * isso, um modelo que so fala pelo array `reasoning_details` chega aqui como
 * turno mudo.
 */
export function reasoningFromDelta(delta: StreamDelta | undefined): string {
  const direto = delta?.reasoning ?? delta?.reasoning_content ?? delta?.reasoning_text;
  if (direto) return direto;
  return (delta?.reasoning_details ?? [])
    .map((bloco) => bloco?.text ?? bloco?.summary ?? '')
    .join('');
}

/** Aplica um chunk SSE ao acumulador. Exportado para teste. */
export function applyChunk(
  acc: StreamAccumulator,
  chunk: StreamChunk,
  onText?: (t: string) => void,
  onReasoning?: (t: string) => void,
): void {
  if (chunk.error) {
    acc.error = {
      message: chunk.error.message ?? 'o provedor reportou um erro sem mensagem',
      code: chunk.error.code,
    };
  }
  const choice = chunk.choices?.[0];
  if (choice?.delta?.content) {
    acc.text += choice.delta.content;
    onText?.(choice.delta.content);
  }
  const raciocinio = reasoningFromDelta(choice?.delta);
  if (raciocinio) {
    acc.reasoning += raciocinio;
    onReasoning?.(raciocinio);
  }
  for (const delta of choice?.delta?.tool_calls ?? []) {
    const current = acc.toolCalls.get(delta.index) ?? { id: '', name: '', args: '' };
    if (delta.id) current.id = delta.id;
    if (delta.function?.name) current.name += delta.function.name;
    if (delta.function?.arguments) current.args += delta.function.arguments;
    acc.toolCalls.set(delta.index, current);
  }
  if (choice?.finish_reason) acc.finishReason = choice.finish_reason;
  if (chunk.usage) {
    acc.usage = {
      inputTokens: chunk.usage.prompt_tokens ?? 0,
      outputTokens: chunk.usage.completion_tokens ?? 0,
    };
  }
}

/**
 * Traduz o status HTTP do provedor em classificacao.
 *
 * 402 e 404 sao configuracao da conta, nao defeito: credito acabou, modelo nao
 * existe, ou a politica de dados da conta nao casa com nenhum provedor (o caso
 * dos modelos `:free` do OpenRouter). Tratar isso como bug enche o tracker de
 * problema que so o dono da conta resolve.
 */
export function providerKindForStatus(status: number): ProviderErrorKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 402 || status === 404) return 'unavailable';
  if (status === 408 || status === 429 || status >= 500) return 'rate-limit';
  return 'http';
}

/** Mapeia o codigo do erro em banda para a classificacao do modulo de erros. */
export function kindForStreamErrorCode(code: number | string | undefined): ProviderErrorKind {
  const numeric = typeof code === 'number' ? code : Number(code);
  if (!Number.isFinite(numeric)) return 'http';
  return providerKindForStatus(numeric);
}

export function finalizeToolCalls(acc: StreamAccumulator): ToolCall[] {
  return [...acc.toolCalls.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, call]) => {
      let input: Record<string, unknown> = {};
      try {
        input = call.args ? (JSON.parse(call.args) as Record<string, unknown>) : {};
      } catch {
        input = { __parseError: call.args };
      }
      return { id: call.id || `call_${index}`, name: call.name, input };
    });
}

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  model: string;
  maxTokens: number;
  temperature?: number;
  baseUrl: string;
  /** Resolve o Bearer na hora da chamada (permite refresh de token OAuth). */
  getAuthToken: () => Promise<string>;
  extraHeaders?: Record<string, string>;
}

/**
 * O parametro `reasoning` e do OpenRouter — a API da OpenAI recusa argumento
 * desconhecido com 400, entao ele so pode sair quando o destino e o OpenRouter
 * mesmo. Um gateway que apenas repasse para la nao e reconhecido aqui; nesse
 * caso vale o comportamento antigo, sem o parametro.
 */
export function acceptsReasoningParam(endpoint: string): boolean {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
}

export function createOpenAICompatibleProvider(options: OpenAICompatibleOptions): AIProvider {
  return {
    id: options.id,
    label: options.label,
    model: options.model,
    async complete(request: CompletionRequest): Promise<CompletionResponse> {
      // Credencial em branco NAO pode virar requisicao. `Bearer ` com token
      // vazio nao e' o mesmo que header ausente: o OpenRouter responde 401
      // "Missing Authentication header" — uma frase que manda o usuario procurar
      // um header que a extensao mandou. O erro tem que ser dito aqui, onde da
      // para dizer o que fazer.
      //
      // O `trim` importa: um `!token` nu deixa passar chave so de espacos, que
      // e' truthy e chega ao provedor exatamente como chave vazia.
      const token = (await options.getAuthToken())?.trim() ?? '';
      if (!token) {
        throw new ProviderError(
          `${options.label}: a chave de API esta vazia. Salve a chave em Configuracoes > ` +
            'Inteligencia artificial e clique em "Testar chave salva".',
          'auth',
        );
      }
      if (!options.model.trim()) {
        throw new ProviderError(
          `${options.label}: nenhum modelo informado. Cole o identificador do modelo ` +
            '(ex.: vendor/modelo) em Configuracoes > Inteligencia artificial.',
          'unavailable',
        );
      }

      const endpoint = normalizeBaseUrl(options.baseUrl);

      const enviar = async (pedirRaciocinio: boolean): Promise<Response> => {
        try {
          return await fetch(endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`,
              ...options.extraHeaders,
            },
            signal: request.signal,
            body: JSON.stringify({
              model: options.model,
              max_tokens: options.maxTokens,
              ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
              stream: true,
              stream_options: { include_usage: true },
              // Pedir o raciocinio mantem o stream com trafego durante a fase
              // de pensamento, que e quando o intermediario costuma desistir de
              // esperar o modelo. `enabled: true` e a unica forma segura:
              // `enabled: false` e recusado por modelos em que o raciocinio e
              // obrigatorio, e mandar `reasoning` junto de `reasoning_effort`
              // tambem e recusado.
              ...(pedirRaciocinio ? { reasoning: { enabled: true } } : {}),
              messages: toOpenAIMessages(request),
              ...(request.tools.length > 0
                ? {
                    tools: request.tools.map((tool) => ({
                      type: 'function',
                      function: {
                        name: tool.name,
                        description: tool.description,
                        parameters: tool.inputSchema,
                      },
                    })),
                  }
                : {}),
            }),
          });
        } catch (error) {
          // Numa extensao, a causa mais comum de a primeira requisicao nem sair e
          // a origem nao ter permissao de host — vale dizer isso em vez de
          // repassar o "Failed to fetch" seco.
          throw new ProviderError(
            `Nao foi possivel alcancar ${endpoint}. Verifique a conexao e se a extensao tem ` +
              'permissao para essa origem (a permissao e pedida ao salvar a chave nas configuracoes).',
            'network',
            error,
          );
        }
      };

      const pediuRaciocinio = acceptsReasoningParam(endpoint);
      let response = await enviar(pediuRaciocinio);
      let detail = response.ok ? '' : await response.text().catch(() => '');

      // Modelo que nao aceita o parametro de raciocinio: refaz a chamada sem
      // ele. Um extra nosso nunca pode ser o motivo de a conversa nao sair.
      if (pediuRaciocinio && response.status === 400 && /reasoning/i.test(detail)) {
        response = await enviar(false);
        detail = response.ok ? '' : await response.text().catch(() => '');
      }

      if (!response.ok || !response.body) {
        // O 401 do provedor costuma vir com texto proprio que nao diz o que
        // fazer; a dica encurta o caminho entre ler o erro e resolver.
        const dica =
          response.status === 401
            ? ' — a chave foi recusada. Confira em Configuracoes > Inteligencia artificial.'
            : '';
        throw new ProviderError(
          `${options.label} respondeu ${response.status}: ${detail.slice(0, 300) || response.statusText}${dica}`,
          providerKindForStatus(response.status),
        );
      }

      const acc: StreamAccumulator = {
        text: '',
        reasoning: '',
        toolCalls: new Map(),
        finishReason: 'stop',
        usage: { inputTokens: 0, outputTokens: 0 },
      };

      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      let interrupted = false;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += value;
          const events = buffer.split('\n\n');
          buffer = events.pop() ?? '';
          for (const event of events) {
            for (const line of event.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                applyChunk(
                  acc,
                  JSON.parse(payload) as StreamChunk,
                  request.onText,
                  request.onReasoning,
                );
              } catch {
                // Chunk malformado: ignora em vez de derrubar a conversa inteira.
              }
            }
          }
        }
      } catch (error) {
        // O Chrome rejeita a leitura com `TypeError: network error` quando a
        // conexao cai no meio do stream — algo que acontece de verdade com
        // agregadores em geracoes longas.
        if (request.signal?.aborted) throw error;

        // Um tool call pela metade NUNCA pode ser aproveitado: o JSON truncado
        // viraria, por exemplo, um write_file com o arquivo cortado. Sem texto
        // util ou com tool call em andamento, a queda e erro mesmo.
        if (acc.text === '' || acc.toolCalls.size > 0) {
          throw new ProviderError(
            `A conexao com ${options.label} caiu durante a resposta ` +
              `(${acc.text.length} caractere(s) recebidos). Tente enviar de novo.`,
            'network',
            error,
          );
        }

        // Com texto e sem tool call pendente, devolver o parcial e melhor do
        // que jogar fora o que ja chegou. O laco do agente encerra o turno.
        interrupted = true;
      }

      if (acc.error) {
        throw new ProviderError(
          `${options.label} interrompeu a geracao: ${acc.error.message}` +
            (acc.error.code === undefined ? '' : ` (codigo ${acc.error.code})`),
          kindForStreamErrorCode(acc.error.code),
        );
      }

      return {
        text: acc.text,
        reasoning: acc.reasoning || undefined,
        toolCalls: finalizeToolCalls(acc),
        stopReason: interrupted ? 'interrupted' : acc.finishReason,
        usage: acc.usage,
      };
    },
  };
}
