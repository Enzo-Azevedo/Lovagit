import type { RepoScope } from '../agent/isolation';
import { platformById, type PlatformId, type PlatformProject } from './types';

/**
 * A parte das plataformas no system prompt.
 *
 * Conectar o Supabase nas configuracoes e nao contar ao modelo nao adianta
 * nada: ele continuaria sem saber que existe um banco, ou — pior — sabendo que
 * existe e sem saber qual. E' esta secao que fecha o circuito.
 *
 * Ela e' curta de proposito. O que o modelo precisa saber cabe em duas linhas:
 * qual e' o projeto deste repositorio, e que os outros nao sao dele.
 */

export interface RepoPlatformLink {
  platformId: PlatformId;
  project: PlatformProject;
}

/**
 * Monta a secao a partir dos vinculos DESTE repositorio.
 *
 * Recebe apenas o que ja foi resolvido para este escopo. Um vinculo de outro
 * repositorio chegando aqui e' defeito de isolamento e para com excecao, do
 * mesmo jeito que a memoria — o prompt e' o ultimo lugar onde ainda da para
 * impedir o cruzamento, e falhar alto e' melhor do que vazar baixo.
 */
export function renderPlatformSection(
  scope: RepoScope,
  links: RepoPlatformLink[],
): string {
  if (links.length === 0) return '';

  const linhas = links.map(({ platformId, project }) => {
    const definicao = platformById(platformId);
    const regiao = project.region ? `, regiao ${project.region}` : '';
    return `- **${definicao?.label ?? platformId}**: projeto \`${project.name}\` (ref \`${project.ref}\`${regiao})`;
  });

  return `
# Servicos ligados a ${scope.repoId}
${linhas.join('\n')}

Duas regras sobre isto:
- **Use o ref acima direto.** Ele ja foi escolhido pelo usuario para este
  repositorio. Nao liste projetos para descobrir qual e', nao tente adivinhar
  pelo nome e nao pergunte qual usar — listar e ir tentando gasta um turno pago
  para achar algo que ja esta escrito aqui.
- **Os outros projetos da conta nao sao deste repositorio.** O token alcanca a
  conta inteira; o recorte e' este. Se a tarefa parecer exigir outro projeto,
  diga isso ao usuario em vez de procurar por conta propria.
`;
}
