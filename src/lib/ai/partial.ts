/**
 * O que sobra de um turno interrompido, para nao pagar duas vezes pelo mesmo
 * trabalho.
 *
 * Quando o stream cai no meio, tudo que o modelo ja tinha gerado — raciocinio,
 * texto, a chamada de ferramenta pela metade — era descartado, e o reenvio
 * comecava do zero. Esses tokens ja foram cobrados: refazer do zero cobra de
 * novo, e num modelo de raciocinio a conta e' justamente a parte cara.
 *
 * O que NAO se aproveita, e por que:
 *
 * - **A chamada de ferramenta nao volta como chamada.** Argumento em JSON
 *   cortado ao meio nao pode ser executado — viraria um `write_file` com o
 *   arquivo truncado. Ela volta como TEXTO, dizendo o que estava sendo feito,
 *   para o modelo refazer a chamada inteira sabendo onde tinha chegado.
 * - **O raciocinio volta so pelo fim.** E' o trecho que diz para onde ele ia; o
 *   comeco, que arma o problema, o modelo reconstroi sozinho lendo o pedido.
 */

/** Teto de cada parte no texto de retomada. Aproveitar nao pode custar mais
 *  contexto do que economiza. */
const LIMITE_TEXTO = 4000;
const LIMITE_RACIOCINIO = 1500;
const LIMITE_ARGUMENTO = 400;

export interface PartialToolCall {
  name: string;
  /** Argumento cru, quase sempre JSON incompleto. Nunca executavel. */
  partialArguments: string;
}

export interface PartialGeneration {
  text: string;
  reasoning: string;
  toolCalls: PartialToolCall[];
}

/** Fim do texto: e' onde o raciocinio estava quando parou. */
function cauda(texto: string, limite: number): string {
  const limpo = texto.trim();
  return limpo.length <= limite ? limpo : `... ${limpo.slice(-limite)}`;
}

function cabeca(texto: string, limite: number): string {
  const limpo = texto.trim();
  return limpo.length <= limite ? limpo : `${limpo.slice(0, limite)} ...`;
}

/**
 * Vale a pena reenviar isto?
 *
 * Retomada vazia so gasta contexto e confunde o modelo com uma secao que nao
 * diz nada. Poucos caracteres tambem nao valem: reconstruir duas palavras e'
 * mais barato que explicar que elas existiram.
 */
export function isWorthResuming(partial: PartialGeneration | undefined): boolean {
  if (!partial) return false;
  return (
    partial.text.trim().length > 40 ||
    partial.reasoning.trim().length > 200 ||
    partial.toolCalls.length > 0
  );
}

/**
 * O bloco que acompanha o reenvio.
 *
 * Vai no turno do usuario, e nao como mensagem do assistente, de proposito: uma
 * resposta de assistente truncada com chamada de ferramenta pendurada quebra o
 * contrato de mensagens de varios provedores. Como texto, funciona em qualquer
 * endpoint.
 */
export function renderResumeHint(partial: PartialGeneration): string {
  const blocos: string[] = [
    '# Retomada de um turno interrompido',
    'A tentativa anterior caiu antes de terminar. O que voce ja tinha produzido esta',
    'abaixo: aproveite e continue de onde parou, em vez de refazer do zero. Refazer',
    'cobra de novo tokens que ja foram pagos.',
  ];

  if (partial.text.trim()) {
    blocos.push('', '## Resposta ja escrita', cabeca(partial.text, LIMITE_TEXTO));
  }
  if (partial.reasoning.trim()) {
    blocos.push('', '## Para onde o raciocinio ia', cauda(partial.reasoning, LIMITE_RACIOCINIO));
  }
  if (partial.toolCalls.length > 0) {
    blocos.push(
      '',
      '## Ferramenta que ficou pela metade',
      'O argumento abaixo esta CORTADO e nao foi executado. Refaca a chamada inteira;',
      'isto serve so para voce saber onde tinha chegado.',
      ...partial.toolCalls.map(
        (call) => `- \`${call.name}\`: ${cabeca(call.partialArguments, LIMITE_ARGUMENTO) || '(sem argumento ainda)'}`,
      ),
    );
  }

  return blocos.join('\n');
}
