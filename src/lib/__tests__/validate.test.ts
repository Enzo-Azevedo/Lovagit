import { describe, expect, it } from 'vitest';
import {
  describeProblems,
  findChangeProblems,
  pathsAfterChanges,
  relativeImports,
  resolveRelative,
  stripComments,
} from '../agent/validate';
import type { PendingFileChange } from '../types';

/**
 * O que motivou tudo isto: commits do agente derrubavam o preview do Lovable
 * com "Preview has not been built yet" — uma mensagem que nao diz qual arquivo
 * nem qual linha. O erro ja era conhecido no momento do commit; so nao estava
 * sendo procurado.
 */

function escreve(path: string, content: string, previousContent: string | null = null): PendingFileChange {
  return { path, content, previousContent, action: previousContent === null ? 'create' : 'update' };
}

const ARVORE = ['src/App.tsx', 'src/components/Header.tsx', 'src/lib/utils.ts', 'package.json'];

describe('import relativo que nao existe', () => {
  it('barra o commit — e' + ' erro certo, nao palpite', () => {
    const problemas = findChangeProblems(
      [escreve('src/App.tsx', "import { Card } from './components/Card';\n")],
      ARVORE,
    );

    expect(problemas).toHaveLength(1);
    expect(problemas[0].level).toBe('blocking');
    expect(problemas[0].detail).toContain('./components/Card');
  });

  it('aceita arquivo criado no MESMO commit', () => {
    // Olhar so a arvore ja publicada acusaria os dois arquivos novos.
    const problemas = findChangeProblems(
      [
        escreve('src/App.tsx', "import { Card } from './components/Card';\n"),
        escreve('src/components/Card.tsx', 'export const Card = () => null;\n'),
      ],
      ARVORE,
    );
    expect(problemas).toEqual([]);
  });

  it('resolve extensao e index, como o bundler faz', () => {
    const problemas = findChangeProblems(
      [
        escreve(
          'src/App.tsx',
          "import { cn } from './lib/utils';\nimport { Header } from './components/Header';\n",
        ),
      ],
      ARVORE,
    );
    expect(problemas).toEqual([]);
  });

  it('acusa import que aponta para arquivo apagado neste commit', () => {
    const problemas = findChangeProblems(
      [
        { path: 'src/lib/utils.ts', content: null, previousContent: 'x', action: 'delete' },
        escreve('src/App.tsx', "import { cn } from './lib/utils';\n"),
      ],
      ARVORE,
    );
    expect(problemas[0]?.level).toBe('blocking');
  });

  it('nao opina sobre alias nem sobre pacote', () => {
    // `@/` depende do tsconfig e pacote depende do node_modules: nenhum dos
    // dois da para resolver com a arvore do repositorio, e chutar aqui barraria
    // commit correto.
    const problemas = findChangeProblems(
      [escreve('src/App.tsx', "import { Button } from '@/components/ui/button';\nimport React from 'react';\n")],
      ARVORE,
    );
    expect(problemas).toEqual([]);
  });

  it('import comentado nao conta', () => {
    // Comentar import e' o que se faz ao depurar; cobrar por ele barraria
    // commit legitimo.
    const problemas = findChangeProblems(
      [escreve('src/App.tsx', "// import { X } from './nao-existe';\n/* import './tambem-nao'; */\n")],
      ARVORE,
    );
    expect(problemas).toEqual([]);
  });
});

describe('JSON e marcador de conflito', () => {
  it('JSON quebrado barra o commit', () => {
    const problemas = findChangeProblems([escreve('package.json', '{ "name": }')], ARVORE);
    expect(problemas[0].level).toBe('blocking');
    expect(problemas[0].detail).toContain('JSON invalido');
  });

  it('marcador de conflito barra o commit', () => {
    const conteudo = 'const a = 1;\n<<<<<<< HEAD\nconst b = 2;\n=======\nconst b = 3;\n>>>>>>> outro\n';
    const problemas = findChangeProblems([escreve('src/App.tsx', conteudo)], ARVORE);
    expect(problemas.some((p) => p.level === 'blocking' && /conflito/.test(p.detail))).toBe(true);
  });
});

describe('encolhimento suspeito', () => {
  it('avisa sem barrar quando o arquivo encolhe demais', () => {
    // E' a assinatura de escrita truncada. Mas apagar codigo de verdade tambem
    // encolhe, e barrar seria impedir trabalho legitimo por um palpite.
    const antes = 'linha\n'.repeat(200);
    const problemas = findChangeProblems([escreve('src/App.tsx', 'linha\n', antes)], ARVORE);

    expect(problemas).toHaveLength(1);
    expect(problemas[0].level).toBe('suspicious');
    expect(describeProblems(problemas)).toContain('truncado');
  });

  it('arquivo pequeno nao dispara o aviso', () => {
    expect(findChangeProblems([escreve('src/App.tsx', 'a', 'abc')], ARVORE)).toEqual([]);
  });
});

describe('pecas', () => {
  it('stripComments preserva as quebras de linha', () => {
    expect(stripComments('a\n// x\nb').split('\n')).toHaveLength(3);
  });

  it('stripComments nao confunde barra dentro de string', () => {
    expect(stripComments('const url = "http://x/y"; // fim')).toContain('http://x/y');
  });

  it('relativeImports pega from, import() e require', () => {
    const fonte = "import a from './a';\nconst b = await import('../b');\nrequire('./c');";
    expect(relativeImports(fonte).sort()).toEqual(['../b', './a', './c']);
  });

  it('resolveRelative sobe diretorio com ..', () => {
    expect(resolveRelative('src/components/Header.tsx', '../lib/utils')).toBe('src/lib/utils');
    expect(resolveRelative('src/App.tsx', './x')).toBe('src/x');
  });

  it('pathsAfterChanges reflete o estado FINAL do commit', () => {
    const finais = pathsAfterChanges(['a.ts', 'b.ts'], [
      escreve('c.ts', 'x'),
      { path: 'a.ts', content: null, previousContent: 'x', action: 'delete' },
    ]);
    expect([...finais].sort()).toEqual(['b.ts', 'c.ts']);
  });

  it('sem problema, nao ha texto de aviso', () => {
    expect(describeProblems([])).toBe('');
  });
});
