import { describe, expect, it } from 'vitest';
import {
  buildStatus,
  formatBytes,
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

describe('buildStatus', () => {
  it('aponta novidade quando a versao publicada difere da instalada', () => {
    expect(buildStatus(build({ version: '0.4.1' }), '0.4.0')).toBe('nova');
  });

  it('diz "atual" quando a versao e a mesma', () => {
    // A release `latest` reaponta a cada push na main sem mudar a versao;
    // tratar isso como novidade acenderia o alerta para sempre.
    expect(buildStatus(build({ version: '0.4.0' }), '0.4.0')).toBe('atual');
  });

  it('separa "nao da para saber" de "esta atualizado"', () => {
    // Colapsar os dois num booleano mostraria um selo verde de "atualizado"
    // para um build que nem diz qual versao carrega.
    expect(buildStatus(build({ version: null }), '0.4.0')).toBe('desconhecida');
  });
});

describe('formatBytes', () => {
  it('escolhe a unidade legivel', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(165135)).toBe('161 KB');
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB');
  });
});
