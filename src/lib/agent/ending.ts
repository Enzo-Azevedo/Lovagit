/**
 * Por que o turno acabou.
 *
 * A regra desta extensao e' que nenhum encerramento pode ser silencioso: se o
 * agente parou de trabalhar, o usuario precisa saber por que e o que fazer em
 * seguida. Na tela, "acabou porque o modelo respondeu" e "acabou porque bateu
 * num teto" sao indistinguiveis — a conversa simplesmente para —, e essa
 * ambiguidade custa caro: quem nao sabe que houve corte reenvia a mesma coisa e
 * paga de novo pelo mesmo trabalho.
 *
 * As explicacoes ficam aqui, fora do laco, porque decidir o texto de cada
 * parada e' uma regra em si — e regra sem teste vira texto que ninguem confere.
 */

/**
 * Traduz o `finish_reason` do provedor. `null` = fim normal, nada a avisar.
 *
 * O laco so tratava `interrupted` (queda de conexao). Tudo mais passava como
 * fim normal, inclusive `length` — que e' resposta CORTADA no meio por estouro
 * do teto de tokens. Num modelo com raciocinio, e' a parada mais provavel de
 * todas: o pensamento consome o mesmo orcamento da resposta, e o que sobra e'
 * meia resposta com cara de resposta inteira.
 */
export function explainStopReason(stopReason: string): string | null {
  const motivo = stopReason.toLowerCase();

  if (motivo === 'length' || motivo === 'max_tokens') {
    return (
      'A resposta foi cortada pelo teto de tokens do provedor — o que esta acima esta ' +
      'incompleto. Aumente o "Maximo de tokens" nas configuracoes do provedor, ou peca ' +
      'a tarefa em partes menores. Em modelo com raciocinio o pensamento consome esse ' +
      'mesmo teto, entao ele acaba antes do que se espera.'
    );
  }

  if (motivo === 'content_filter') {
    return (
      'O provedor bloqueou a resposta por filtro de conteudo. Reformule o pedido ou ' +
      'use outro modelo.'
    );
  }

  return null;
}

/**
 * O teto de passos foi atingido.
 *
 * Aviso separado porque o estado e' diferente de todos os outros: o modelo NAO
 * terminou e nao houve erro nenhum — ele foi interrompido no meio de uma linha
 * de raciocinio que estava indo bem. Dizer isso muda o que o usuario faz em
 * seguida: em vez de repetir o pedido inteiro, ele pede a continuacao.
 */
export function explainStepCeiling(maxSteps: number): string {
  return (
    `O turno atingiu o teto de ${maxSteps} passos de ferramenta e parou aqui — o modelo ` +
    'nao tinha terminado. Isso acontece em tarefa que exige muita leitura. Peca para ' +
    'continuar de onde parou, ou divida o pedido: o que ja foi lido e alterado continua valendo.'
  );
}
