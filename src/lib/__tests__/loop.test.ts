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

describe('historyToTurns', () => {
  it('mapeia papeis para turnos de provedor', () => {
    const turns = historyToTurns([
      message({ role: 'user', content: 'oi' }),
      message({
        role: 'assistant',
        content: 'lendo',
        toolCalls: [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }],
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
});
