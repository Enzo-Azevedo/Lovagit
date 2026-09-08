/**
 * Reconhecimento de falha de rede.
 *
 * Fica aqui, e nao no classificador de erros nem no provedor, porque os dois
 * precisam da MESMA resposta. Duas copias da regra divergem com o tempo, e a
 * divergencia aparece do pior jeito: um lado chamando de queda de rede o que o
 * outro chama de defeito da extensao.
 */

/**
 * `fetch` e a leitura de um stream rejeitam com TypeError quando a rede cai ou
 * a origem nao foi permitida. As mensagens variam por navegador e por momento
 * da falha — o Chrome usa "Failed to fetch" na requisicao e "network error"
 * quando o stream e' interrompido no meio.
 */
export function isNetworkFailure(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /failed to fetch|network\s*error|load failed|network request failed|connection closed/i.test(
      error.message,
    )
  );
}
