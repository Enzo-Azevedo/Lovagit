import { describe, expect, it } from 'vitest';
import { backupBranchName, normalizeRepoPath } from '../github/writer';

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
