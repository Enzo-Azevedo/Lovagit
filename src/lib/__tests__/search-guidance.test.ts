import { describe, expect, it } from 'vitest';
import { GitHubError } from '../github/client';
import { describeEmptySearch, explainSearchError, validateSearchQuery } from '../agent/search';

/**
 * Dois defeitos que apareceram juntos na tela: o erro cru
 * `ERROR_TYPE_QUERY_PARSING_FATAL unable to parse query!` subindo sem traducao,
 * e "Nenhum resultado." sendo lido como prova de que algo nao existe.
 */

describe('validateSearchQuery', () => {
  it('recusa qualificador sozinho, que foi o 422 real', () => {
    // `path:"/admin"` diz ONDE procurar, mas nao O QUE procurar.
    const problema = validateSearchQuery('path:"/admin"');
    expect(problema).not.toBeNull();
    expect(problema).toMatch(/pelo menos um termo/i);
  });

  it('ensina a forma certa em vez de so recusar', () => {
    expect(validateSearchQuery('language:ts')).toContain('createUser path:src/api');
  });

  it('aponta a barra inicial no caminho', () => {
    const problema = validateSearchQuery('vagas path:"/admin"');
    expect(problema).toMatch(/nao comeca com barra/i);
  });

  it('deixa passar consulta valida', () => {
    // Regra demais aqui recusaria busca legitima, o que e pior do que deixar a
    // API responder.
    expect(validateSearchQuery('createUser')).toBeNull();
    expect(validateSearchQuery('createUser path:src/api')).toBeNull();
    expect(validateSearchQuery('supabase language:ts filename:client')).toBeNull();
  });

  it('consulta vazia continua recusada', () => {
    expect(validateSearchQuery('   ')).toBe('Informe um termo de busca.');
  });
});

describe('explainSearchError', () => {
  it('traduz o 422 em vez de repassar o erro cru', () => {
    const aviso = explainSearchError(
      new GitHubError('ERROR_TYPE_QUERY_PARSING_FATAL unable to parse query!', 422, '/search/code'),
    );
    expect(aviso).toMatch(/sintaxe invalida/i);
    expect(aviso).toContain('path:');
    // O texto da API continua ali: e o que identifica o caso quando for outro.
    expect(aviso).toContain('unable to parse query');
  });

  it('separa limite de requisicoes, que exige acao diferente', () => {
    const aviso = explainSearchError(new GitHubError('rate limit', 403, '/search/code'));
    expect(aviso).toMatch(/limite de requisicoes/i);
    expect(aviso).toMatch(/list_directory/);
  });

  it('erro desconhecido nao vira diagnostico inventado', () => {
    expect(explainSearchError(new Error('caiu a rede'))).toContain('caiu a rede');
  });
});

describe('describeEmptySearch', () => {
  it('vazio significa "nao achei", nunca "nao ha"', () => {
    // Era o defeito de leitura: o modelo concluia ausencia a partir do indice.
    const texto = describeEmptySearch('vagas', []);
    expect(texto).toMatch(/NAO prova/);
    expect(texto).toMatch(/list_directory e read_file/);
  });

  it('avisa que o indice do GitHub e parcial e atrasado', () => {
    const texto = describeEmptySearch('vagas', []);
    expect(texto).toMatch(/cobre so parte/i);
    expect(texto).toMatch(/recem-commitado/i);
  });

  it('mostra os caminhos parecidos quando existem', () => {
    const texto = describeEmptySearch('vagas', ['src/pages/vagas.tsx']);
    expect(texto).toContain('src/pages/vagas.tsx');
  });
});
