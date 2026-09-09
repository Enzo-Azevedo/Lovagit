import { describe, expect, it } from 'vitest';
import { createScope } from '../agent/isolation';
import { renderPlatformSection } from '../platforms/prompt';
import type { McpServerConfig } from '../mcp/types';
import { parseMcpScope } from '../platforms/types';
import type { RepoRef } from '../types';

const repo: RepoRef = {
  id: 'acme/site',
  owner: 'acme',
  name: 'site',
  defaultBranch: 'main',
  private: false,
  htmlUrl: 'https://github.com/acme/site',
};
const escopo = createScope(repo);

function servidor(url: string, patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv1',
    label: 'Supabase',
    url,
    enabledRepoIds: ['acme/site'],
    tools: [
      { name: 'list_tables', description: '', inputSchema: { type: 'object', properties: {} } },
      { name: 'execute_sql', description: '', inputSchema: { type: 'object', properties: {} } },
    ],
    disabledTools: [],
    ...patch,
  };
}

const projeto = { ref: 'refdoprojeto', name: 'loja-producao' };
const vinculo = [{ platformId: 'supabase' as const, project: projeto }];

describe('secao das plataformas no prompt', () => {
  it('leva o ref junto do nome — o ref e o que as ferramentas usam', () => {
    const texto = renderPlatformSection(escopo, [
      {
        platformId: 'supabase',
        project: { ref: 'abcdefghijklmnop', name: 'loja-producao', region: 'sa-east-1' },
      },
    ]);

    expect(texto).toContain('loja-producao');
    expect(texto).toContain('abcdefghijklmnop');
    expect(texto).toContain('sa-east-1');
    expect(texto).toContain('acme/site');
  });

  it('manda usar o ref direto, em vez de listar e ir tentando', () => {
    // Era o desperdicio concreto: sem saber qual e' o projeto, o modelo lista
    // todos e testa um a um — cada tentativa e' um turno pago para descobrir
    // algo que o usuario ja tinha escolhido.
    const texto = renderPlatformSection(escopo, [
      { platformId: 'supabase', project: { ref: 'ref1', name: 'projeto' } },
    ]);
    expect(texto).toMatch(/nao liste projetos/i);
  });

  it('diz que os outros projetos da conta nao sao deste repositorio', () => {
    // O token alcanca a conta inteira; o recorte por repositorio e' o que
    // impede o chat de um projeto mexer no banco de outro.
    const texto = renderPlatformSection(escopo, [
      { platformId: 'supabase', project: { ref: 'ref1', name: 'projeto' } },
    ]);
    expect(texto).toMatch(/nao sao deste repositorio/i);
  });

  it('sem vinculo, a secao nao existe — nada de meia informacao', () => {
    // "Existe um Supabase, mas nao sei qual projeto" e' pior do que silencio:
    // convida exatamente a busca que se quer evitar.
    expect(renderPlatformSection(escopo, [])).toBe('');
  });
});

describe('o que o modelo fica sabendo que pode fazer', () => {
  it('sem servidor MCP, diz que nao ha como tocar o servico', async () => {
    // Saber que existe um banco sem ter ferramenta para alcanca-lo e' pior do
    // que nao saber: o modelo tenta, falha, e gasta um turno explicando algo
    // que a extensao ja sabia de antemao.
    const texto = renderPlatformSection(escopo, vinculo, []);

    expect(texto).toContain('Sem ferramenta para acessar');
    // O "nao tente por outro caminho" generico virou proibicao nomeada: o
    // desvio real tinha nome (`search_code`), e instrucao abstrata nao o cobria.
    expect(texto).toMatch(/Nao substitua por `search_code`/i);
  });

  it('lista as ferramentas que existem de fato, ja com o prefixo do servidor', () => {
    const texto = renderPlatformSection(escopo, vinculo, [
      servidor('https://mcp.supabase.com/mcp'),
    ]);

    expect(texto).toContain('list_tables');
    expect(texto).toContain('execute_sql');
  });

  it('ferramenta desabilitada pelo usuario nao e anunciada', () => {
    const texto = renderPlatformSection(escopo, vinculo, [
      servidor('https://mcp.supabase.com/mcp', { disabledTools: ['execute_sql'] }),
    ]);

    expect(texto).toContain('list_tables');
    expect(texto).not.toContain('execute_sql');
  });

  it('servidor em modo somente leitura e anunciado como tal', () => {
    // Esta e' a resposta a "a IA sabe que so consegue ler?". Ela sabe quando a
    // restricao e' declaravel — e no Supabase ela e', pela URL do servidor.
    const texto = renderPlatformSection(escopo, vinculo, [
      servidor('https://mcp.supabase.com/mcp?read_only=true'),
    ]);

    expect(texto).toContain('Somente leitura');
    expect(texto).toMatch(/qualquer escrita e recusada/i);
  });

  it('servidor sem project_ref avisa que alcanca a conta inteira', () => {
    // Sem `project_ref`, o recorte por repositorio e' so um pedido no prompt.
    const texto = renderPlatformSection(escopo, vinculo, [
      servidor('https://mcp.supabase.com/mcp'),
    ]);
    expect(texto).toContain('TODOS os projetos da conta');
  });

  it('projeto do servidor diferente do vinculado vira aviso, nao surpresa', () => {
    const texto = renderPlatformSection(escopo, vinculo, [
      servidor('https://mcp.supabase.com/mcp?project_ref=outroprojeto'),
    ]);

    expect(texto).toContain('outroprojeto');
    expect(texto).toMatch(/avise o usuario/i);
  });

  it('nunca afirma quais sao as permissoes do token — a extensao nao as le', () => {
    // O honesto e' dizer a regra: recusa e resposta, nao obstaculo. Inventar
    // "voce tem permissao de escrita" seria mentir com cara de certeza.
    // O texto do prompt e' quebrado em linhas; comparar sem as quebras evita um
    // teste que reprova por causa de onde a frase virou de linha.
    const texto = renderPlatformSection(escopo, vinculo, [
      servidor('https://mcp.supabase.com/mcp'),
    ]).replace(/\s+/g, ' ');

    expect(texto).toMatch(/a extensao nao tem como ler quais sao/i);
    expect(texto).toMatch(/recusa do servico e resposta, nao obstaculo/i);
  });
});

describe('escopo declarado na URL do servidor', () => {
  it('le `read_only` e `project_ref`', () => {
    expect(parseMcpScope('https://mcp.supabase.com/mcp?read_only=true&project_ref=abc')).toEqual({
      readOnly: true,
      projectRef: 'abc',
    });
  });

  it('sem parametros, nada e restrito', () => {
    expect(parseMcpScope('https://mcp.supabase.com/mcp')).toEqual({
      readOnly: false,
      projectRef: null,
    });
  });

  it('so `read_only=true` restringe — qualquer outro valor nao', () => {
    // Meio-termo aqui viraria uma promessa falsa de seguranca.
    expect(parseMcpScope('https://x/mcp?read_only=1').readOnly).toBe(false);
    expect(parseMcpScope('https://x/mcp?read_only=false').readOnly).toBe(false);
  });

  it('URL invalida nao quebra o prompt', () => {
    expect(parseMcpScope('nao e url')).toEqual({ readOnly: false, projectRef: null });
  });
});

describe('vinculo sem ferramenta nao pode virar busca em codigo', () => {
  it('proibe explicitamente o desvio por search_code', () => {
    // Foi o que aconteceu de verdade: sem servidor MCP, o modelo foi procurar
    // nomes de tabela no codigo com search_code e devolveu "nenhum resultado",
    // que o usuario leu como "o banco esta vazio".
    const texto = renderPlatformSection(escopo, vinculo, []).replace(/\s+/g, ' ');

    expect(texto).toContain('Nao substitua por `search_code`');
    expect(texto).toMatch(/nao diz nada sobre o que existe no banco/i);
    expect(texto).toMatch(/se parece com "o banco esta vazio"/i);
  });

  it('manda dizer ao usuario onde resolver, antes de tentar outra coisa', () => {
    const texto = renderPlatformSection(escopo, vinculo, []).replace(/\s+/g, ' ');
    expect(texto).toContain('Configuracoes > Conexoes');
    expect(texto).toMatch(/ANTES de tentar qualquer outra coisa/i);
  });

  it('mesmo COM ferramenta, pergunta de dados nao se responde lendo codigo', () => {
    // A confusao nao depende de faltar servidor: search_code acha onde a tabela
    // e' declarada, nunca o que ela contem.
    const texto = renderPlatformSection(escopo, vinculo, [
      servidor('https://mcp.supabase.com/mcp'),
    ]).replace(/\s+/g, ' ');

    expect(texto).toMatch(/Pergunta sobre DADOS nao se responde lendo codigo/i);
    expect(texto).toMatch(/nunca o que ela contem/i);
  });
});
