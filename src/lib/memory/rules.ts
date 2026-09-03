/**
 * Regra dita pelo usuario, detectada sem ele pedir.
 *
 * A memoria tem duas portas. A principal e' o modelo chamando `remember` ao
 * perceber que o usuario definiu como as coisas funcionam por aqui. Esta e' a
 * segunda: um detector deterministico para quando o modelo nao chama nada — e
 * modelo pequeno ou gratuito frequentemente nao chama.
 *
 * Duas escolhas moldam o resto do arquivo:
 *
 * 1. **Precisao acima de cobertura.** Regra perdida o usuario repete; regra
 *    inventada entra no system prompt de TODAS as conversas seguintes daquele
 *    repositorio, mandando o modelo obedecer algo que ninguem combinou. Por
 *    isso o detector exige marca explicita de durabilidade — "sempre",
 *    "a partir de agora", "por padrao" — e ignora o resto. Pedido comum no
 *    imperativo ("ajuste o header") e' tarefa de hoje, nao regra, e fica de
 *    fora de proposito.
 * 2. **Guarda a frase, nao a mensagem.** Numa mensagem longa que termina com
 *    "e sempre use aspas simples", a regra e' a ultima frase. Guardar o texto
 *    inteiro colocaria o pedido do dia dentro de uma entrada que promete valer
 *    para sempre.
 */

/** Acento nao muda a regra: o usuario escreve "padrão" e "padrao" no mesmo dia. */
function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/**
 * Marcas que sozinhas ja fazem a frase ser regra: elas nao descrevem um caso,
 * elas estabelecem o caso geral.
 */
const MARCA_FORTE =
  /\b(?:a partir de agora|de agora em diante|daqui (?:pra|para) frente|por padrao|from now on|by default|as a rule)\b|(?:^|[\s(])(?:regra|convencao|padrao|rule|convention)\s*:|\b(?:prefira|priorize|evite|prefer|avoid)\b/;

/**
 * Marcas que sugerem durabilidade mas tambem aparecem em relato ("sempre que
 * eu clico da erro"). So valem acompanhadas de verbo de acao ou de obrigacao.
 */
const MARCA_FRACA = /\b(?:sempre|nunca|jamais|always|never)\b/;

/** Verbo de acao no imperativo/infinitivo — o que transforma a marca em ordem. */
const VERBO_DE_ACAO =
  /\b(?:use|usar|utilize|utilizar|faca|fazer|crie|criar|coloque|colocar|escreva|escrever|nomeie|nomear|chame|chamar|mantenha|manter|envie|enviar|commite|commitar|altere|alterar|mexa|mexer|adicione|adicionar|remova|remover|apague|apagar|rode|rodar|siga|seguir|deixe|deixar|gere|gerar|importe|importar|teste|testar|valide|validar|documente|documentar|responda|responder|pergunte|perguntar|pesquise|pesquisar|revise|revisar|formate|formatar|traduza|traduzir|write|create|name|call|keep|run|add|remove|delete|ask|format|commit|follow)\b/;

/** Obrigacao explicita: vale como ordem mesmo sem verbo de acao na frase. */
const OBRIGACAO =
  /\b(?:deve|devem|devera|deverao|tem que|tem de|precisa|precisam|nao pode|nao podem|so pode|must|should|has to|have to)\b/;

/**
 * Quebra em frases sem cortar caminho de arquivo nem numero de versao: o ponto
 * so encerra frase quando vem espaco ou fim de linha depois dele — `0.4.1` e
 * `src/lib/x.ts` continuam inteiros.
 */
function dividirFrases(texto: string): string[] {
  return texto
    .split(/\n+|(?<=[.;!?])\s+/)
    .map((frase) => frase.trim())
    .filter((frase) => frase.length > 0);
}

export function isRuleSentence(frase: string): boolean {
  const normal = normalizar(frase);
  if (MARCA_FORTE.test(normal)) return true;
  if (!MARCA_FRACA.test(normal)) return false;
  return VERBO_DE_ACAO.test(normal) || OBRIGACAO.test(normal);
}

/**
 * Devolve as frases da mensagem que estabelecem regra, ou `null` quando nao ha
 * nenhuma. O corte em 280 caracteres nao acontece aqui: `recordMemory` ja apara
 * todo resumo antes de gravar.
 */
export function extractRule(texto: string): string | null {
  const regras = dividirFrases(texto).filter(isRuleSentence);
  if (regras.length === 0) return null;
  return regras.join(' ').replace(/\s+/g, ' ').trim();
}
