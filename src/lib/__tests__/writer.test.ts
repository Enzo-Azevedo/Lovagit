import { describe, expect, it } from 'vitest';
import { backupBranchName, defaultCommitMessage, normalizeRepoPath } from '../github/writer';

describe('backupBranchName', () => {
  it('gera nome ordenavel com timestamp UTC', () => {
    const name = backupBranchName('main', new Date('2026-03-04T05:06:07.089Z'));
    expect(name).toBe('lovagit/backup/main/20260304T050607Z');
  });

  it('sanitiza caracteres invalidos em nome de branch', () => {
    expect(backupBranchName('feat/algo estranho~1', new Date(0))).toContain(
      'lovagit/backup/feat/algo-estranho-1/',
    );
  });
});

describe('normalizeRepoPath', () => {
  it('normaliza prefixos redundantes', () => {
    expect(normalizeRepoPath('./src/App.tsx')).toBe('src/App.tsx');
    expect(normalizeRepoPath('/src/App.tsx')).toBe('src/App.tsx');
    expect(normalizeRepoPath('  src/App.tsx  ')).toBe('src/App.tsx');
  });

  it('bloqueia travessia de diretorio e escrita no .git', () => {
    expect(() => normalizeRepoPath('../../etc/passwd')).toThrow(/\.\./);
    expect(() => normalizeRepoPath('src/../../fora.ts')).toThrow(/\.\./);
    expect(() => normalizeRepoPath('.git/config')).toThrow(/\.git/);
  });

  it('rejeita caminho vazio', () => {
    expect(() => normalizeRepoPath('   ')).toThrow(/vazio/);
  });
});

describe('defaultCommitMessage', () => {
  const arquivo = (path: string, action: 'create' | 'update' | 'delete') => ({
    path,
    content: action === 'delete' ? null : 'x',
    previousContent: null,
    action,
  });

  it('descreve uma alteracao unica pelo verbo certo', () => {
    expect(defaultCommitMessage([arquivo('src/a.ts', 'create')])).toBe('chore: adiciona src/a.ts');
    expect(defaultCommitMessage([arquivo('src/a.ts', 'update')])).toBe('chore: atualiza src/a.ts');
    expect(defaultCommitMessage([arquivo('src/a.ts', 'delete')])).toBe('chore: remove src/a.ts');
  });

  it('lista os arquivos no corpo quando sao varios', () => {
    const mensagem = defaultCommitMessage([
      arquivo('src/a.ts', 'update'),
      arquivo('src/b.ts', 'update'),
    ]);
    expect(mensagem.split('\n')[0]).toBe('chore: atualiza 2 arquivos');
    expect(mensagem).toContain('- src/a.ts');
    expect(mensagem).toContain('- src/b.ts');
  });

  it('usa "atualiza" quando as acoes se misturam', () => {
    const mensagem = defaultCommitMessage([
      arquivo('src/a.ts', 'create'),
      arquivo('src/b.ts', 'delete'),
    ]);
    expect(mensagem.split('\n')[0]).toBe('chore: atualiza 2 arquivos');
  });

  it('normaliza o caminho antes de escrever na mensagem', () => {
    expect(defaultCommitMessage([arquivo('./src/a.ts', 'update')])).toBe('chore: atualiza src/a.ts');
  });
});
