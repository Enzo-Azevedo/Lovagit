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

/**
 * O corpo cru do provedor entra inteiro na mensagem do erro, e a mensagem vai
 * para um repositorio de issues publico. O issue #17 saiu com o `user_id` da
 * conta OpenRouter de quem reportou.
 */
describe('redactText — identificador de conta de servico externo', () => {
  it('mascara o user_id que o OpenRouter devolve no corpo do erro', () => {
    const corpo =
      'OpenRouter respondeu 400: {"error":{"message":"ope is not a valid model ID","code":400},' +
      '"user_id":"user_3IpTNJLzcE9KmYOvoG8tpPyncoW"}';
    const out = redactText(corpo);
    expect(out).not.toContain('user_3IpTNJLzcE9KmYOvoG8tpPyncoW');
    expect(out).toContain('<id-conta>');
    // O resto da mensagem tem de sobreviver, senao o relatorio perde o valor.
    expect(out).toContain('is not a valid model ID');
    expect(out).toContain('400');
  });

  it('pega o campo com qualquer grafia e qualquer valor', () => {
    for (const campo of ['user_id', 'userId', 'account_id', 'org_id', 'organization_id']) {
      const out = redactText(`{"${campo}":"qualquer-coisa-aqui"}`);
      expect(out, campo).not.toContain('qualquer-coisa-aqui');
      expect(out, campo).toContain('<id-conta>');
    }
  });

  it('pega o identificador solto no meio da frase', () => {
    expect(redactText('pertence a user_3IpTNJLzcE9KmYOvoG8tpPyncoW')).toBe(
      'pertence a <id-conta>',
    );
    expect(redactText('conta org-AbCdEfGhIjKlMnOp')).toBe('conta <id-conta>');
  });

  it('nao come palavra comum que comeca com user_', () => {
    expect(redactText('campo user_name vazio')).toContain('user_name');
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
