import { GitHubError } from '../github/client';

/**
 * Sintaxe da busca de codigo do GitHub.
 *
 * A busca do GitHub nao e' grep: ela tem gramatica propria, indexa so parte do
 * repositorio e recusa consulta que nao siga o formato. Nada disso estava dito
 * em lugar nenhum — nem na descricao da ferramenta, nem na resposta —, entao o
 * modelo tentava sintaxe de linha de comando e recebia de volta o erro cru da
 * API: `ERROR_TYPE_QUERY_PARSING_FATAL unable to parse query!`, que nao ensina
 * nada a ninguem.
 */

/** Qualificadores que a busca de codigo aceita. */
const QUALIFICADORES = /\b(?:path|language|filename|extension|repo|in|user|org|size):/i;

/**
 * A consulta tem algum termo livre, fora os qualificadores?
 *
 * A API exige pelo menos um: `path:"/admin"` sozinho e' justamente o 422 que
 * apareceu na tela. Qualificador diz ONDE procurar; sem termo, nao ha o que
 * procurar.
 */
function temTermoLivre(query: string): boolean {
  const semQualificadores = query
    .replace(/\b(?:path|language|filename|extension|repo|in|user|org|size):(?:"[^"]*"|\S*)/gi, ' ')
    .trim();
  return semQualificadores.length > 0;
}

/**
 * Problema na consulta, ou `null` se ela parece valida.
 *
 * Verifica so o que da para afirmar sem chamar a API. Regra demais aqui viraria
 * recusa de busca legitima, que e' pior do que deixar a API responder.
 */
export function validateSearchQuery(query: string): string | null {
  const limpo = query.trim();
  if (!limpo) return 'Informe um termo de busca.';

  if (QUALIFICADORES.test(limpo) && !temTermoLivre(limpo)) {
    return (
      'A busca do GitHub precisa de pelo menos um termo alem dos qualificadores: ' +
      `\`${limpo}\` diz onde procurar, mas nao o que procurar. Escreva \`termo ${limpo}\` ` +
      '(exemplo: `createUser path:src/api`). Para so listar arquivos por caminho, ' +
      'use list_directory.'
    );
  }

  const caminhoComBarra = /\bpath:"?\/+/i.exec(limpo);
  if (caminhoComBarra) {
    return (
      'Caminho na busca do GitHub e relativo a raiz e nao comeca com barra. Use ' +
      '`path:admin` em vez de `path:"/admin"`.'
    );
  }

  return null;
}

/**
 * Traduz a falha da busca.
 *
 * O erro cru da API subia direto para o modelo, que nao tem como saber se
 * `unable to parse query` e' problema da consulta dele ou defeito da extensao.
 */
export function explainSearchError(error: unknown): string {
  if (error instanceof GitHubError) {
    if (error.status === 422) {
      return (
        `A busca foi recusada pelo GitHub por sintaxe invalida (${error.message}). ` +
        'A busca de codigo aceita termos livres e qualificadores como `path:`, ' +
        '`language:` e `filename:`, e exige pelo menos um termo alem deles. Reescreva ' +
        'a consulta, ou use list_directory e read_file para chegar no arquivo.'
      );
    }
    if (error.status === 403) {
      return (
        'A busca do GitHub recusou por limite de requisicoes — ela tem cota propria, ' +
        'mais apertada que o resto da API. Espere um pouco ou use list_directory e ' +
        'read_file, que nao passam pela busca.'
      );
    }
  }
  return `A busca falhou: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * O que dizer quando a busca volta vazia.
 *
 * "Nenhum resultado." era lido como "isso nao existe", e o modelo seguia adiante
 * com uma conclusao que a busca nao sustenta: o indice do GitHub cobre so parte
 * do repositorio, demora a incluir codigo recem-commitado e nao alcanca
 * repositorio nunca indexado. Vazio aqui significa "nao achei", nunca "nao ha".
 */
export function describeEmptySearch(query: string, caminhosParecidos: string[]): string {
  const base =
    `Nenhum resultado para \`${query}\` no indice de busca do GitHub. Isso NAO prova ` +
    'que o termo nao existe: o indice cobre so parte do repositorio e demora a incluir ' +
    'codigo recem-commitado. Confirme com list_directory e read_file antes de concluir ' +
    'que algo nao existe.';

  if (caminhosParecidos.length === 0) return base;
  return `${base}\n\nArquivos cujo caminho casa com o termo:\n${caminhosParecidos.join('\n')}`;
}
