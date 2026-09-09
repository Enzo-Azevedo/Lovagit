import { describe, expect, it } from 'vitest';
import {
  linksWithoutTool,
  serverForPlatform,
  serverForPlatformInRepo,
} from '../platforms/access';
import type { McpServerConfig } from '../mcp/types';
import type { RepoPlatformLink } from '../platforms/types';

/**
 * A regra "existe vinculo E nenhum servidor MCP casa com o host" estava escrita
 * em dois lugares e ia virar tres. O jeito de divergir era o pior possivel: uma
 * tela dizendo que ha acesso enquanto o prompt diz ao modelo que nao ha.
 */

function servidor(patch: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id: 'srv1',
    label: 'Supabase',
    url: 'https://mcp.supabase.com/mcp',
    enabledRepoIds: ['acme/site'],
    tools: [],
    disabledTools: [],
    ...patch,
  };
}

const vinculo: RepoPlatformLink = {
  platformId: 'supabase',
  project: { ref: 'refdoprojeto', name: 'loja' },
};

describe('serverForPlatform', () => {
  it('acha o servidor do proprio servico', () => {
    expect(serverForPlatform('supabase', [servidor()])?.id).toBe('srv1');
  });

  it('nao casa por sufixo — dominio parecido e outra pessoa', () => {
    const impostor = servidor({ url: 'https://mcp.supabase.com.evil.test/mcp' });
    expect(serverForPlatform('supabase', [impostor])).toBeUndefined();
  });

  it('lista vazia nao acha nada', () => {
    expect(serverForPlatform('supabase', [])).toBeUndefined();
  });
});

describe('serverForPlatformInRepo', () => {
  it('servidor nao habilitado para o repositorio nao conta', () => {
    // Ele existe no cadastro e nao existe NESTA conversa — e e a conversa que
    // importa, porque e la que a pergunta vai ser feita.
    const outro = servidor({ enabledRepoIds: ['acme/outro'] });
    expect(serverForPlatformInRepo('supabase', 'acme/site', [outro])).toBeUndefined();
    expect(serverForPlatformInRepo('supabase', 'acme/outro', [outro])?.id).toBe('srv1');
  });
});

describe('linksWithoutTool', () => {
  it('aponta o vinculo que o modelo enxerga e nao consegue tocar', () => {
    // Era o estado que enganava: projeto configurado, prompt contando que ele
    // existe, e nenhuma ferramenta para chegar nele.
    expect(linksWithoutTool([vinculo], [])).toEqual([vinculo]);
  });

  it('com o servidor no lugar, nao sobra nada a avisar', () => {
    expect(linksWithoutTool([vinculo], [servidor()])).toEqual([]);
  });

  it('sem vinculo nenhum tambem nao ha o que avisar', () => {
    // Quem nao vinculou projeto nao configurou nada pela metade.
    expect(linksWithoutTool([], [])).toEqual([]);
  });
});
