import { describe, expect, it } from 'vitest';
import {
  browserSignature,
  hashRepoId,
  redactPath,
  redactStack,
  redactText,
  redactUrl,
  shortHash,
} from '../telemetry/redact';

describe('redactText — credenciais', () => {
  it('mascara tokens do GitHub em qualquer formato', () => {
    const text = 'falhou com github_pat_11ABCDEFG0aBcDeFgHiJkL e ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ012345';
    const out = redactText(text);
    expect(out).not.toMatch(/github_pat_11ABCDEFG/);
    expect(out).not.toMatch(/ghp_aBcDeFg/);
    expect(out).toContain('<token-github>');
  });

  it('mascara chaves de provedor de IA e Authorization', () => {
    expect(redactText('key sk-ant-api03-AAAABBBBCCCCDDDD1234')).toContain('<chave-anthropic>');
    expect(redactText('Authorization: Bearer abcdefghijklmnop123')).toContain('<credencial>');
    expect(redactText('Authorization: Bearer abcdefghijklmnop123')).not.toContain('abcdefghijklmnop123');
  });

  it('mascara e-mail', () => {
    expect(redactText('conta pessoa@empresa.com.br')).toBe('conta <email>');
  });
});

describe('redactText — identificacao do trabalho do usuario', () => {
  it('troca nome de repositorio conectado por hash estavel', () => {
    const out = redactText('erro ao commitar em acme/site-secreto', ['acme/site-secreto']);
    expect(out).not.toContain('site-secreto');
    expect(out).toBe(`erro ao commitar em ${hashRepoId('acme/site-secreto')}`);
  });

  it('usa o mesmo hash entre chamadas — da para agrupar sem revelar', () => {
    expect(hashRepoId('acme/site')).toBe(hashRepoId('acme/site'));
    expect(hashRepoId('acme/site')).not.toBe(hashRepoId('acme/api'));
  });

  it('e insensivel a caixa ao trocar o repositorio', () => {
    expect(redactText('Erro em ACME/Site', ['acme/site'])).toContain(hashRepoId('acme/site'));
  });
});

describe('redactUrl', () => {
  it('tira owner/name das URLs da API e do site', () => {
    expect(redactUrl('https://api.github.com/repos/acme/site/git/refs/heads/main')).toBe(
      'https://api.github.com/repos/<repo>/git/refs/heads/main',
    );
    expect(redactUrl('https://github.com/acme/site/commit/abc')).toBe(
      'https://github.com/<repo>/commit/abc',
    );
  });

  it('descarta query string inteira', () => {
    expect(redactUrl('https://api.github.com/search/code?q=segredo+repo:acme/site')).toContain(
      '?<params>',
    );
  });

  it('anonimiza o id da extensao', () => {
    expect(redactUrl('chrome-extension://abcdefghijklmnopabcdefghijklmnop/assets/sidepanel.js')).toBe(
      'chrome-extension://<id>/assets/sidepanel.js',
    );
  });
});

describe('redactPath', () => {
  it('guarda so a extensao do arquivo', () => {
    expect(redactPath('src/components/Header.tsx')).toBe('<arquivo .tsx>');
    expect(redactPath('Dockerfile')).toBe('<arquivo>');
  });
});

describe('redactStack', () => {
  it('limita quadros e redige o caminho do bundle', () => {
    const stack = ['TypeError: x', ...Array.from({ length: 40 }, (_, i) => `    at f${i} (chrome-extension://abcdefghijklmnopabcdefghijklmnop/assets/sidepanel.js:1:1)`)].join('\n');
    const out = redactStack(stack, [], 5);
    expect(out.split('\n')).toHaveLength(6);
    expect(out).not.toMatch(/abcdefghijklmnop/);
  });

  it('nao quebra sem stack', () => {
    expect(redactStack(undefined)).toBe('(sem stack)');
  });
});

describe('browserSignature', () => {
  it('reduz a user agent ao motor e versao maior', () => {
    expect(
      browserSignature('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36'),
    ).toBe('Chrome 140');
    expect(browserSignature('... Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0')).toBe('Edg 140');
  });
});

describe('shortHash', () => {
  it('e deterministico e curto', () => {
    expect(shortHash('a')).toHaveLength(8);
    expect(shortHash('a')).toBe(shortHash('a'));
    expect(shortHash('a')).not.toBe(shortHash('b'));
  });
});
