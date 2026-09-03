import { classifyError } from '../telemetry/classify';

/** Espera entre a falha e o reenvio automatico. */
export const RETRY_DELAY_SECONDS = 5;

export interface RetryDecision {
  /** Opcao ligada pelo usuario. Desligada por padrao. */
  enabled: boolean;
  /** Erro que derrubou o turno. */
  error: unknown;
  /** O turno chegou a commitar alguma coisa antes de cair. */
  committed: boolean;
}

/**
 * Decide se o turno pode ser reenviado sozinho.
 *
 * **Nao existe teto de tentativas, e isso e' escolha.** Provedor gratuito fica
 * fora do ar por minutos seguidos; um reenvio que desiste na segunda tentativa
 * deixa o usuario olhando para uma tela parada exatamente quando a opcao existe
 * para ele nao precisar olhar. Quem liga isso quer que insista.
 *
 * O que impede o laco de correr solto nao e' contador:
 * - so falha passageira reenvia — chave invalida ou modelo inexistente dariam
 *   no mesmo na tentativa seguinte, e cancelamento do usuario nao e' falha;
 * - nunca depois de um commit, porque repetir o turno repetiria trabalho que ja
 *   esta gravado no repositorio;
 * - a contagem regressiva aparece na tela com botao de cancelar, e mandar outra
 *   mensagem tambem a interrompe. Quem manda continua sendo o usuario.
 */
export function shouldAutoRetry({ enabled, error, committed }: RetryDecision): boolean {
  if (!enabled || committed) return false;
  return classifyError(error).category === 'transient';
}
