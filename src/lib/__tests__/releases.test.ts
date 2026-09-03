import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  isNewerBuild,
  parseCommit,
  parseVersion,
  type LatestBuild,
} from '../github/releases';

const build = (extra: Partial<LatestBuild> = {}): LatestBuild => ({
  name: 'Build da main (a39f224)',
  commit: 'a39f224',
  version: '0.4.0',
  downloadUrl: 'https://github.com/o/r/releases/download/latest/lovagit-latest.zip',
  sizeBytes: 165135,
  publishedAt: '2026-09-03T15:17:29Z',
  htmlUrl: 'https://github.com/o/r/releases/tag/latest',
  fetchedAt: 0,
  ...extra,
});

describe('parseCommit', () => {
  it('le o commit do titulo da release', () => {
    expect(parseCommit({ name: 'Build da main (a39f224)' })).toBe('a39f224');
  });

  it('cai para as notas quando o titulo nao tem commit', () => {
    expect(parseCommit({ name: 'latest', body: 'Commit: a39f224ab7d629c091aa27d' })).toBe('a39f224');
  });

  it('devolve vazio em vez de inventar', () => {
    expect(parseCommit({ name: 'latest', body: 'sem sha aqui' })).toBe('');
    expect(parseCommit({})).toBe('');
  });
});

describe('parseVersion', () => {
  it('le a versao anunciada nas notas do build', () => {
    expect(parseVersion('Build automatico da main.\n\nVersao do manifest: 0.4.0\n')).toBe('0.4.0');
  });

  it('devolve null quando as notas nao dizem', () => {
    expect(parseVersion('Build automatico da main.')).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });
});

describe('isNewerBuild', () => {
  it('aponta novidade quando a versao publicada difere da instalada', () => {
    expect(isNewerBuild(build({ version: '0.4.1' }), '0.4.0')).toBe(true);
  });

  it('nao aponta novidade quando a versao e a mesma', () => {
    // A release `latest` reaponta a cada push na main sem mudar a versao;
    // tratar isso como novidade acenderia o alerta para sempre.
    expect(isNewerBuild(build({ version: '0.4.0' }), '0.4.0')).toBe(false);
  });

  it('nao inventa novidade quando a versao publicada e desconhecida', () => {
    expect(isNewerBuild(build({ version: null }), '0.4.0')).toBe(false);
  });
});

describe('formatBytes', () => {
  it('escolhe a unidade legivel', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(165135)).toBe('161 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
