import { describe, expect, it } from 'vitest';
import { applyChunk, finalizeToolCalls, toOpenAIMessages } from '../ai/openai-compatible';

function emptyAcc() {
  return {
    text: '',
    reasoning: '',
    toolCalls: new Map<number, { id: string; name: string; args: string }>(),
    finishReason: 'stop',
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe('toOpenAIMessages', () => {
  it('converte turnos neutros preservando a ordem tool_call -> tool_result', () => {
    const messages = toOpenAIMessages({
      system: 'sistema',
      tools: [],
      turns: [
        { role: 'user', text: 'ajuste o header' },
        {
          role: 'assistant',
          text: 'vou ler o arquivo',
          toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'src/App.tsx' } }],
        },
        {
          role: 'user',
          toolResults: [{ toolCallId: 'call_1', name: 'read_file', content: 'conteudo' }],
        },
      ],
    });

    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(messages[2].tool_calls?.[0].function.arguments).toBe('{"path":"src/App.tsx"}');
    expect(messages[3].tool_call_id).toBe('call_1');
  });

  it('marca resultado com erro no conteudo da mensagem tool', () => {
    const messages = toOpenAIMessages({
      system: 's',
      tools: [],
      turns: [
        {
          role: 'user',
          toolResults: [{ toolCallId: 'c', name: 'read_file', content: 'sumiu', isError: true }],
        },
      ],
    });
    expect(messages[1].content).toBe('ERRO: sumiu');
  });
});

describe('streaming SSE — raciocinio', () => {
  // Modelos de raciocinio colocam a saida em campos que variam por provedor.
  // Ler so `content` fazia a resposta chegar vazia e o turno terminar sem nada.
  it.each(['reasoning', 'reasoning_content', 'reasoning_text'])(
    'acumula o raciocinio vindo em delta.%s',
    (campo) => {
      const acc = emptyAcc();
      applyChunk(acc, { choices: [{ delta: { [campo]: 'pensando...' } }] });
      expect(acc.reasoning).toBe('pensando...');
      expect(acc.text).toBe('');
    },
  );

  it('nao envia raciocinio pelo callback de texto da interface', () => {
    const acc = emptyAcc();
    const deltas: string[] = [];
    applyChunk(acc, { choices: [{ delta: { reasoning: 'pensando' } }] }, (t) => deltas.push(t));
    expect(deltas).toEqual([]);
  });

  it('mantem raciocinio e conteudo separados', () => {
    const acc = emptyAcc();
    applyChunk(acc, { choices: [{ delta: { reasoning: 'penso' } }] });
    applyChunk(acc, { choices: [{ delta: { content: 'respondo' } }] });
    expect(acc.reasoning).toBe('penso');
    expect(acc.text).toBe('respondo');
  });
});

describe('streaming SSE', () => {
  it('acumula texto e chama o callback incremental', () => {
    const acc = emptyAcc();
    const deltas: string[] = [];
    applyChunk(acc, { choices: [{ delta: { content: 'Oi' } }] }, (text) => deltas.push(text));
    applyChunk(acc, { choices: [{ delta: { content: ', mundo' } }] }, (text) => deltas.push(text));
    expect(acc.text).toBe('Oi, mundo');
    expect(deltas).toEqual(['Oi', ', mundo']);
  });

  it('remonta tool calls fragmentadas em varios chunks', () => {
    const acc = emptyAcc();
    applyChunk(acc, {
      choices: [
        { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'write_', arguments: '{"path"' } }] } },
      ],
    });
    applyChunk(acc, {
      choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: ':"a.ts"}' } }] } }],
    });
    applyChunk(acc, { choices: [{ finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 3 } });

    const calls = finalizeToolCalls(acc);
    expect(calls).toEqual([{ id: 'call_1', name: 'write_file', input: { path: 'a.ts' } }]);
    expect(acc.finishReason).toBe('tool_calls');
    expect(acc.usage).toEqual({ inputTokens: 10, outputTokens: 3 });
  });

  it('nao explode com arguments JSON invalido', () => {
    const acc = emptyAcc();
    applyChunk(acc, {
      choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'x', arguments: '{quebrado' } }] } }],
    });
    expect(finalizeToolCalls(acc)[0].input).toEqual({ __parseError: '{quebrado' });
  });
});
