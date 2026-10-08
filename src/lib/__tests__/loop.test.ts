import { describe, expect, it } from 'vitest';
import { historyToTurns } from '../agent/loop';
import type { ChatMessage } from '../types';

function message(partial: Partial<ChatMessage>): ChatMessage {
  return {
    id: Math.random().toString(36),
    repoId: 'acme/site',
    role: 'user',
    content: '',
    createdAt: 0,
    ...partial,
  };
}

function toolCall(id: string) {
  return { id, name: 'read_file', input: { path: 'a.ts' } };
}

describe('historyToTurns', () => {
  it('mapeia papeis para turnos de provedor', () => {
    const turns = historyToTurns([
      message({ role: 'user', content: 'oi' }),
      message({
        role: 'assistant',
        content: 'lendo',
        toolCalls: [toolCall('c1')],
      }),
      message({
        role: 'tool',
        toolResults: [{ toolCallId: 'c1', name: 'read_file', content: 'x' }],
      }),
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
    expect(turns[1].toolCalls?.[0].id).toBe('c1');
    expect(turns[2].toolResults?.[0].toolCallId).toBe('c1');
  });

  it('descarta resultados de tool orfaos no inicio da janela', () => {
    const turns = historyToTurns([
      message({ role: 'tool', toolResults: [{ toolCallId: 'x', name: 'read_file', content: 'y' }] }),
      message({ role: 'user', content: 'oi' }),
    ]);
    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({ role: 'user', text: 'oi' });
  });

  it('remove assistant com tool_calls que nao tem resultados (turno abortado)', () => {
    const turns = historyToTurns([
      message({ role: 'user', content: 'oi' }),
      message({ role: 'assistant', content: '', toolCalls: [toolCall('c1')] }),
      message({ role: 'user', content: 'de novo' }),
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'user']);
    expect(turns[1]).toEqual({ role: 'user', text: 'de novo' });
  });

  it('mantem o texto da assistant orfa mas descarta os tool_calls e os resultados', () => {
    const turns = historyToTurns([
      message({ role: 'user', content: 'oi' }),
      message({
        role: 'assistant',
        content: 'vou ler dois arquivos',
        toolCalls: [toolCall('c1'), toolCall('c2')],
      }),
      message({
        role: 'tool',
        toolResults: [{ toolCallId: 'c1', name: 'read_file', content: 'x' }],
      }),
      message({ role: 'user', content: 'segue' }),
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user']);
    expect(turns[1]).toEqual({ role: 'assistant', text: 'vou ler dois arquivos' });
    expect(turns[2]).toEqual({ role: 'user', text: 'segue' });
  });

  it('mantem tool_calls quando todos os resultados estao presentes', () => {
    const turns = historyToTurns([
      message({ role: 'user', content: 'oi' }),
      message({
        role: 'assistant',
        content: '',
        toolCalls: [toolCall('c1'), toolCall('c2')],
      }),
      message({
        role: 'tool',
        toolResults: [
          { toolCallId: 'c1', name: 'read_file', content: 'x' },
          { toolCallId: 'c2', name: 'read_file', content: 'y' },
        ],
      }),
      message({ role: 'assistant', content: 'pronto' }),
    ]);

    expect(turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(turns[1].toolCalls?.map((call) => call.id)).toEqual(['c1', 'c2']);
    expect(turns[2].toolResults?.map((result) => result.toolCallId)).toEqual(['c1', 'c2']);
  });
});
