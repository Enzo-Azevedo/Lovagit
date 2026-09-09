import type { RepoScope } from '../agent/isolation';
import { namespacedToolName } from '../mcp/protocol';
import type { McpServerConfig } from '../mcp/types';
import { serverForPlatform } from './access';
import {
  parseMcpScope,
  platformById,
  type PlatformId,
  type PlatformProject,
  type RepoPlatformLink,
} from './types';

export type { RepoPlatformLink };

/**
 * A parte das plataformas no system prompt.
 *
 * Conectar o Supabase nas configuracoes e nao contar ao modelo qual projeto e'
 * o deste repositorio deixaria a conexao inutil. Mas contar so isso tambem nao
 * basta, e essa foi a falha da primeira versao: o modelo ficava sabendo que
 * existe um banco sem saber se tem como toca-lo nem o que pode fazer nele.
 *
 * Saber de um servico sem ter ferramenta para alcanca-lo e' pior do que nao
 * saber: o modelo tenta, falha, e gasta turno explicando ao usuario uma coisa
 * que a extensao ja sabia de antemao.
 */

/** O caminho ate a plataforma, se e' que existe algum nesta conversa. */
function descreverAcesso(
  platformId: PlatformId,
  project: PlatformProject,
  mcpServers: McpServerConfig[],
): string[] {
  const servidor = serverForPlatform(platformId, mcpServers);

  if (!servidor) {
    const label = platformById(platformId)?.label ?? platformId;
    return [
      '  - **Sem ferramenta para acessar este servico nesta conversa.** Voce sabe que ele',
      '    existe e qual e o projeto, mas nao consegue ler nem escrever NADA nele.',
      `  - Se a tarefa depender disso, diga ao usuario, com estas palavras: falta cadastrar`,
      `    e habilitar o servidor MCP do ${label} para este repositorio, em Configuracoes >`,
      '    Conexoes. Diga isso ANTES de tentar qualquer outra coisa.',
      '  - **Nao substitua por `search_code`.** Procurar nome de tabela ou de coluna no',
      '    codigo responde outra pergunta: acha (ou nao acha) o nome escrito em algum',
      '    arquivo, e nao diz nada sobre o que existe no banco. Pior: voltar "nenhum',
      '    resultado" dessa busca se parece com "o banco esta vazio", e o usuario le como',
      '    integracao quebrada. Sem a ferramenta, a resposta honesta e dizer que nao tem acesso.',
    ];
  }

  const escopo = parseMcpScope(servidor.url);
  const ferramentas = servidor.tools
    .filter((tool) => !servidor.disabledTools.includes(tool.name))
    .map((tool) => `\`${namespacedToolName(servidor.id, tool.name)}\``);

  const linhas = [
    `  - Ferramentas disponiveis: ${
      ferramentas.length > 0 ? ferramentas.join(', ') : 'nenhuma descoberta ainda'
    }.`,
  ];

  if (escopo.readOnly) {
    linhas.push(
      '  - **Somente leitura.** O servidor executa como usuario Postgres somente-leitura:',
      '    consultar estrutura e dados funciona, qualquer escrita e recusada. Nao proponha',
      '    migracao nem alteracao de dados como se fossem executaveis daqui.',
    );
  }

  if (escopo.projectRef && escopo.projectRef !== project.ref) {
    // Divergencia real entre o que o usuario escolheu e o que o servidor
    // alcanca. Dizer e melhor do que deixar o modelo descobrir por erro.
    linhas.push(
      `  - Atencao: o servidor esta preso ao projeto \`${escopo.projectRef}\`, diferente do`,
      '    vinculado a este repositorio. Avise o usuario em vez de operar no projeto errado.',
    );
  } else if (!escopo.projectRef) {
    linhas.push(
      '  - O servidor alcanca TODOS os projetos da conta; o recorte acima e a unica',
      '    fronteira. Use o ref deste repositorio e nenhum outro.',
    );
  }

  return linhas;
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
  mcpServers: McpServerConfig[] = [],
): string {
  if (links.length === 0) return '';

  const blocos = links.map(({ platformId, project }) => {
    const definicao = platformById(platformId);
    const regiao = project.region ? `, regiao ${project.region}` : '';
    return [
      `- **${definicao?.label ?? platformId}**: projeto \`${project.name}\` (ref \`${project.ref}\`${regiao})`,
      ...descreverAcesso(platformId, project, mcpServers),
    ].join('\n');
  });

  return `
# Servicos ligados a ${scope.repoId}
${blocos.join('\n')}

Quatro regras sobre isto:
- **Use o ref acima direto.** Ele ja foi escolhido pelo usuario para este
  repositorio. Nao liste projetos para descobrir qual e', nao tente adivinhar
  pelo nome e nao pergunte qual usar — listar e ir tentando gasta um turno pago
  para achar algo que ja esta escrito aqui.
- **Os outros projetos da conta nao sao deste repositorio.** O token alcanca a
  conta inteira; o recorte e' este. Se a tarefa parecer exigir outro projeto,
  diga isso ao usuario em vez de procurar por conta propria.
- **Pergunta sobre DADOS nao se responde lendo codigo.** "Quantas vagas existem",
  "quais candidatos desistiram", "essa tabela tem registro" sao perguntas de banco.
  So as ferramentas listadas acima respondem isso. \`search_code\` e \`read_file\`
  procuram no CODIGO do repositorio: eles mostram onde a tabela e' declarada ou
  consultada, nunca o que ela contem. Usar um no lugar do outro produz uma
  resposta que parece certa e esta errada.
- **O que voce pode fazer e o que as ferramentas acima permitem — nada alem.**
  As permissoes efetivas sao as do token do usuario, e a extensao nao tem como
  ler quais sao. Uma recusa do servico e resposta, nao obstaculo: relate ao
  usuario o que foi negado, em vez de tentar outro caminho para conseguir o
  mesmo efeito.
`;
}
