import { classifyError } from '../telemetry/classify';

/** Espera entre a falha e o reenvio automatico. */
export const RETRY_DELAY_SECONDS = 5;

export interface RetryDecision {
  /** Opcao ligada pelo usuario. Desligada por padrao. */
  enabled: boolean;
  /** Erro que derrubou o turno. */
  error: unknown;
  /** O turno que falhou ja era, ele proprio, um reenvio automatico. */
  alreadyRetried: boolean;
  /** O turno chegou a commitar alguma coisa antes de cair. */
  committed: boolean;
}

/**
 * Decide se o turno pode ser reenviado sozinho.
 *
 * Tres barreiras, cada uma por um motivo diferente:
 * - so falha passageira, porque chave invalida ou modelo inexistente dariam
 *   exatamente no mesmo na segunda tentativa (e cancelamento do usuario nao e
 *   falha nenhuma);
 * - uma vez por mensagem, senao um provedor com problema persistente vira laco
 *   infinito queimando tokens;
 * - nunca depois de um commit, porque repetir o turno repetiria trabalho que ja
 *   esta gravado no repositorio.
 */
export function shouldAutoRetry({
  enabled,
  error,
  alreadyRetried,
  committed,
}: RetryDecision): boolean {
  if (!enabled || alreadyRetried || committed) return false;
  return classifyError(error).category === 'transient';
}
