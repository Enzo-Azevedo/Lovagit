import { describe, expect, it } from 'vitest';
import {
  applyChangesToMap,
  detectStack,
  isReadablePath,
  pickEntryPoints,
  summarizeTree,
} from '../github/mapper';
import type { RepoMap, TreeEntry } from '../types';

describe('detectStack', () => {
  it('deduz a stack a partir do package.json', () => {
    const stack = detectStack(
      ['package.json', 'src/main.tsx', 'src/components/ui/button.tsx'],
      {
        'package.json': JSON.stringify({
          dependencies: { react: '19', '@supabase/supabase-js': '2' },
          devDependencies: { vite: '7', tailwindcss: '4' },
        }),
      },
    );
    expect(stack).toEqual(expect.arrayContaining(['React', 'Supabase', 'Vite', 'Tailwind CSS', 'shadcn/ui']));
  });

  it('deduz stack por arquivos-manifesto sem package.json', () => {
    expect(detectStack(['go.mod', 'Dockerfile'], {})).toEqual(['Docker', 'Go']);
  });

  it('ignora package.json invalido sem quebrar', () => {
    expect(() => detectStack(['package.json'], { 'package.json': '{ nao json' })).not.toThrow();
  });
});

describe('pickEntryPoints', () => {
  it('retorna apenas entrypoints existentes', () => {
    expect(pickEntryPoints(['src/main.tsx', 'README.md'])).toEqual(['src/main.tsx']);
  });
});

describe('isReadablePath', () => {
  it('exclui dependencias e binarios', () => {
    expect(isReadablePath('node_modules/react/index.js')).toBe(false);
    expect(isReadablePath('public/logo.png')).toBe(false);
    expect(isReadablePath('src/index.ts')).toBe(true);
  });
});

describe('summarizeTree', () => {
  const entries: TreeEntry[] = [
    { path: 'src', type: 'tree', sha: '1' },
    { path: 'src/main.tsx', type: 'blob', sha: '2' },
    { path: 'src/App.tsx', type: 'blob', sha: '3' },
    { path: 'node_modules/react/index.js', type: 'blob', sha: '4' },
  ];

  it('agrupa por diretorio e omite dependencias', () => {
    const summary = summarizeTree(entries);
    expect(summary).toContain('src/');
    expect(summary).toContain('  App.tsx');
    expect(summary).not.toContain('node_modules');
  });

  it('respeita o limite de linhas', () => {
    const many: TreeEntry[] = Array.from({ length: 500 }, (_, i) => ({
      path: `src/file-${i}.ts`,
      type: 'blob' as const,
      sha: String(i),
    }));
    expect(summarizeTree(many, 20).split('\n').length).toBeLessThanOrEqual(21);
  });
});

describe('applyChangesToMap', () => {
  const map: RepoMap = {
    repoId: 'acme/site',
    defaultBranch: 'main',
    headSha: 'old',
    generatedAt: 0,
    entries: [
      { path: 'src', type: 'tree', sha: '1' },
      { path: 'src/App.tsx', type: 'blob', sha: '2' },
      { path: 'legacy.ts', type: 'blob', sha: '3' },
    ],
    truncated: false,
    languages: {},
    stack: [],
    entryPoints: [],
    highlights: [],
    fileCount: 2,
    dirCount: 1,
  };

  it('adiciona, remove e avanca o head sem refazer o mapeamento', () => {
    const next = applyChangesToMap(
      map,
      [
        { path: 'src/components/Header.tsx', action: 'create' },
        { path: 'legacy.ts', action: 'delete' },
      ],
      'novo-sha',
    );
    const paths = next.entries.map((entry) => entry.path);
    expect(next.headSha).toBe('novo-sha');
    expect(paths).toContain('src/components/Header.tsx');
    expect(paths).toContain('src/components');
    expect(paths).not.toContain('legacy.ts');
    expect(next.fileCount).toBe(2);
  });
});
