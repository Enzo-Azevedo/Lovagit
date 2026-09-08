import { describe, expect, it } from 'vitest';
import { createScope } from '../agent/isolation';
import { renderPlatformSection } from '../platforms/prompt';
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
