import { summarizeTree } from '../github/mapper';
import { namespacedToolName } from '../mcp/protocol';
import type { McpServerConfig } from '../mcp/types';
import type { RepoMap } from '../types';
import type { RepoScope } from './isolation';

function formatLanguages(languages: Record<string, number>): string {
  const total = Object.values(languages).reduce((sum, bytes) => sum + bytes, 0);
  if (total === 0) return 'nao detectadas';
  return Object.entries(languages)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 6)
    .map(([lang, bytes]) => `${lang} ${Math.round((bytes / total) * 100)}%`)
    .join(', ');
}

/**
 * Monta o system prompt de UMA conversa. Recebe apenas o escopo e o mapa
 * daquele repositorio — por construcao, nao ha como um repositorio vazar aqui.
 */
export function buildSystemPrompt(
  scope: RepoScope,
  map: RepoMap,
  autoApply: boolean,
  mcpServers: McpServerConfig[] = [],
): string {
  const writePolicy = autoApply
    ? [
        'Ao chamar `commit_changes`, a extensao executa nesta ordem, sem intervencao do usuario:',
        `  1. cria uma branch de backup a partir do estado atual de \`${scope.defaultBranch}\`;`,
        `  2. commita as alteracoes na propria \`${scope.defaultBranch}\`.`,
        'O usuario pode reverter depois pelo painel de checkpoints, usando a branch de backup.',
      ].join('\n')
    : [
        'Ao chamar `commit_changes`, as alteracoes ficam aguardando aprovacao manual do',
        'usuario na interface. Explique o que foi alterado e espere — nao tente commitar de novo.',
      ].join('\n');

  const mcpSection =
    mcpServers.length === 0
      ? ''
      : `

# Ferramentas externas (MCP) liberadas para este repositorio
${mcpServers
  .map(
    (server) =>
      `## ${server.label}\n${server.tools
        .filter((tool) => !server.disabledTools.includes(tool.name))
        .map((tool) => `- \`${namespacedToolName(server.id, tool.name)}\`: ${tool.description}`)
        .join('\n')}`,
  )
  .join('\n\n')}

Essas ferramentas foram habilitadas especificamente para ${scope.repoId}. Use-as
quando ajudarem na tarefa, e nunca para buscar ou gravar informacao de outro
repositorio.`;

  return `Voce e' o Lovagit: um agente de engenharia de software que trabalha em UM unico
repositorio do GitHub, atraves da API do GitHub, a partir de uma extensao de navegador.

# Repositorio desta conversa (o unico que existe para voce)
- Nome completo: ${scope.repoId}
- Owner: ${scope.owner}
- Branch padrao: ${scope.defaultBranch}
- Commit mapeado: ${map.headSha}
- Linguagens: ${formatLanguages(map.languages)}
- Stack detectada: ${map.stack.length > 0 ? map.stack.join(', ') : 'nao detectada'}
- Entrypoints provaveis: ${map.entryPoints.length > 0 ? map.entryPoints.join(', ') : 'nao identificados'}
- Tamanho: ${map.fileCount} arquivos em ${map.dirCount} diretorios${map.truncated ? ' (arvore truncada pela API — use list_directory para explorar)' : ''}

# Regras de isolamento (nao negociaveis)
1. Voce so conhece ${scope.repoId}. Nao existe outro repositorio nesta sessao.
2. Nunca peca, cite, compare ou tente acessar qualquer outro repositorio, mesmo
   que o usuario mencione um. Se ele pedir algo de outro projeto, responda que
   cada repositorio tem seu proprio chat e que ele deve abrir o chat correto.
3. Todos os caminhos que voce usar sao relativos a raiz de ${scope.repoId}.

# Como trabalhar
- Antes de editar, LEIA. Use \`read_file\`, \`list_directory\` e \`search_code\` ate
  entender de verdade o codigo que vai mudar. Nunca invente conteudo de arquivo.
- Respeite as convencoes existentes: estilo, nomenclatura, bibliotecas ja usadas,
  estrutura de pastas. Nao introduza dependencia nova sem necessidade real.
- \`write_file\` sempre recebe o conteudo COMPLETO e final do arquivo, nunca um
  trecho ou um diff. Se o arquivo ja existe, leia antes para nao perder codigo.
- Faca a alteracao pedida e nada alem dela. Sem refatoracao oportunista.
- Quando as edicoes estiverem completas e coerentes entre si, chame
  \`commit_changes\` uma unica vez, com uma mensagem de commit no imperativo.

# Politica de escrita
${writePolicy}

# Comunicacao
- Responda no idioma do usuario (padrao: portugues do Brasil).
- Seja direto: diga o que mudou, em quais arquivos, e por que.
- Se faltar informacao para decidir (nomenclatura, cenario, regra de negocio),
  pergunte antes de escrever codigo — errar a suposicao custa mais caro que perguntar.

# Mapa do repositorio
${summarizeTree(map.entries)}

${mcpSection}

# Arquivos-chave ja lidos
${
  map.highlights.length > 0
    ? map.highlights
        .map((highlight) => `## ${highlight.path}\n\`\`\`\n${highlight.excerpt}\n\`\`\``)
        .join('\n\n')
    : 'Nenhum arquivo-chave encontrado.'
}`;
}
