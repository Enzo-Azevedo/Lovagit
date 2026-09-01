import type { RepoMap, RepoRef, TreeEntry } from '../types';
import { getBranchHeadSha, getFileContent, getLanguages, getTree } from './client';

/** Diretorios que nunca ajudam o modelo e so gastam contexto. */
const IGNORED_DIR_RE =
  /(^|\/)(node_modules|dist|build|out|coverage|\.git|\.next|\.turbo|\.cache|vendor|__pycache__|\.venv|target)(\/|$)/;

/** Binarios e artefatos: aparecem na contagem, mas nunca sao lidos. */
const BINARY_EXT_RE =
  /\.(png|jpe?g|gif|webp|avif|ico|svgz?|woff2?|ttf|eot|otf|mp[34]|mov|avi|zip|gz|tgz|rar|7z|pdf|jar|class|so|dylib|dll|exe|wasm|bin|lock|lockb)$/i;

/** Arquivos-manifesto lidos no mapeamento inicial para deduzir a stack. */
const MANIFEST_FILES = [
  'package.json',
  'tsconfig.json',
  'requirements.txt',
  'pyproject.toml',
  'go.mod',
  'Cargo.toml',
  'composer.json',
  'Gemfile',
  'pom.xml',
  'build.gradle',
  'Dockerfile',
  'docker-compose.yml',
  'supabase/config.toml',
  'vite.config.ts',
  'next.config.js',
  'next.config.mjs',
];

const README_CANDIDATES = ['README.md', 'readme.md', 'README.MD', 'Readme.md', 'README'];

const ENTRY_POINT_CANDIDATES = [
  'src/main.tsx',
  'src/main.ts',
  'src/index.tsx',
  'src/index.ts',
  'src/App.tsx',
  'src/app/page.tsx',
  'app/page.tsx',
  'pages/index.tsx',
  'index.html',
  'main.py',
  'app.py',
  'manage.py',
  'main.go',
  'src/main.rs',
  'src/index.js',
  'server.js',
  'index.js',
];

export function isIgnoredPath(path: string): boolean {
  return IGNORED_DIR_RE.test(path);
}

export function isReadablePath(path: string): boolean {
  return !isIgnoredPath(path) && !BINARY_EXT_RE.test(path);
}

/** Deduz frameworks/ferramentas a partir de paths e do conteudo dos manifestos. */
export function detectStack(paths: string[], manifests: Record<string, string>): string[] {
  const found = new Set<string>();
  const pathSet = new Set(paths);
  const pkg = manifests['package.json'] ?? '';
  const deps = (() => {
    try {
      const parsed = JSON.parse(pkg) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      return { ...parsed.dependencies, ...parsed.devDependencies };
    } catch {
      return {} as Record<string, string>;
    }
  })();

  const depMatchers: [string, string][] = [
    ['react', 'React'],
    ['next', 'Next.js'],
    ['vue', 'Vue'],
    ['svelte', 'Svelte'],
    ['@angular/core', 'Angular'],
    ['vite', 'Vite'],
    ['tailwindcss', 'Tailwind CSS'],
    ['typescript', 'TypeScript'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['@supabase/supabase-js', 'Supabase'],
    ['firebase', 'Firebase'],
    ['prisma', 'Prisma'],
    ['drizzle-orm', 'Drizzle ORM'],
    ['@tanstack/react-query', 'TanStack Query'],
    ['zustand', 'Zustand'],
    ['redux', 'Redux'],
    ['stripe', 'Stripe'],
    ['vitest', 'Vitest'],
    ['jest', 'Jest'],
    ['playwright', 'Playwright'],
  ];
  for (const [dep, label] of depMatchers) {
    if (deps[dep]) found.add(label);
  }
  if (pkg.includes('"shadcn') || paths.some((p) => p.startsWith('src/components/ui/'))) {
    found.add('shadcn/ui');
  }

  const fileMatchers: [string, string][] = [
    ['requirements.txt', 'Python'],
    ['pyproject.toml', 'Python'],
    ['manage.py', 'Django'],
    ['go.mod', 'Go'],
    ['Cargo.toml', 'Rust'],
    ['composer.json', 'PHP'],
    ['Gemfile', 'Ruby'],
    ['pom.xml', 'Java/Maven'],
    ['build.gradle', 'Java/Gradle'],
    ['Dockerfile', 'Docker'],
    ['docker-compose.yml', 'Docker Compose'],
    ['supabase/config.toml', 'Supabase'],
  ];
  for (const [file, label] of fileMatchers) {
    if (pathSet.has(file)) found.add(label);
  }
  if (paths.some((p) => p.startsWith('.github/workflows/'))) found.add('GitHub Actions');

  return [...found].sort();
}

export function pickEntryPoints(paths: string[]): string[] {
  const pathSet = new Set(paths);
  return ENTRY_POINT_CANDIDATES.filter((candidate) => pathSet.has(candidate));
}

/**
 * Resumo textual da arvore para o system prompt: agrupa por diretorio e corta
 * no limite de linhas, para o mapa nao dominar a janela de contexto.
 */
export function summarizeTree(entries: TreeEntry[], maxLines = 400): string {
  const files = entries
    .filter((e) => e.type === 'blob' && !isIgnoredPath(e.path))
    .map((e) => e.path)
    .sort();

  const byDir = new Map<string, string[]>();
  for (const path of files) {
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '.' : path.slice(0, slash);
    const file = slash === -1 ? path : path.slice(slash + 1);
    const bucket = byDir.get(dir);
    if (bucket) bucket.push(file);
    else byDir.set(dir, [file]);
  }

  const lines: string[] = [];
  let remaining = maxLines;
  for (const [dir, dirFiles] of [...byDir.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (remaining <= 1) {
      lines.push(`... (${byDir.size} diretorios no total; use list_directory para o resto)`);
      break;
    }
    lines.push(`${dir}/`);
    remaining--;
    const shown = dirFiles.slice(0, Math.max(1, Math.min(dirFiles.length, remaining)));
    for (const file of shown) lines.push(`  ${file}`);
    remaining -= shown.length;
    if (shown.length < dirFiles.length) {
      lines.push(`  ... +${dirFiles.length - shown.length} arquivos`);
      remaining--;
    }
  }
  return lines.join('\n');
}

export function excerpt(content: string, maxChars = 1200): string {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n... (truncado, use read_file para o conteudo completo)`;
}

export interface MapProgress {
  (step: string): void;
}

/**
 * Mapeia um repositorio: arvore completa + linguagens + manifestos + README.
 * O conteudo dos demais arquivos e' lido sob demanda pelas tools do agente.
 */
export async function buildRepoMap(
  repo: RepoRef,
  onProgress: MapProgress = () => {},
): Promise<RepoMap> {
  onProgress('Lendo a branch padrao...');
  const headSha = await getBranchHeadSha(repo.owner, repo.name, repo.defaultBranch);

  onProgress('Baixando a arvore de arquivos...');
  const { entries, truncated } = await getTree(repo.owner, repo.name, headSha);

  onProgress('Detectando linguagens...');
  const languages = await getLanguages(repo.owner, repo.name);

  const paths = entries.filter((e) => e.type === 'blob').map((e) => e.path);
  const pathSet = new Set(paths);

  onProgress('Lendo arquivos-chave...');
  const manifests: Record<string, string> = {};
  const highlights: RepoMap['highlights'] = [];

  const readme = README_CANDIDATES.find((candidate) => pathSet.has(candidate));
  const toRead = [...(readme ? [readme] : []), ...MANIFEST_FILES.filter((f) => pathSet.has(f))];

  for (const path of toRead.slice(0, 8)) {
    try {
      const file = await getFileContent(repo.owner, repo.name, path, headSha);
      if (path !== readme) manifests[path] = file.content;
      highlights.push({ path, excerpt: excerpt(file.content, path === readme ? 2000 : 1200) });
    } catch {
      // Arquivo ilegivel nao pode derrubar o mapeamento inteiro.
    }
  }

  return {
    repoId: repo.id,
    defaultBranch: repo.defaultBranch,
    headSha,
    generatedAt: Date.now(),
    entries,
    truncated,
    languages,
    stack: detectStack(paths, manifests),
    entryPoints: pickEntryPoints(paths),
    highlights,
    fileCount: paths.length,
    dirCount: entries.filter((e) => e.type === 'tree').length,
  };
}

/**
 * Atualiza o mapa em memoria apos um commit, sem refazer todas as chamadas de
 * API: aplica as mudancas na arvore e avanca o headSha. Puro, testavel.
 */
export function applyChangesToMap(
  map: RepoMap,
  changes: { path: string; action: 'create' | 'update' | 'delete' }[],
  newHeadSha: string,
): RepoMap {
  const entries = new Map(map.entries.map((entry) => [entry.path, entry]));
  for (const change of changes) {
    if (change.action === 'delete') {
      entries.delete(change.path);
      continue;
    }
    if (!entries.has(change.path)) {
      entries.set(change.path, { path: change.path, type: 'blob', sha: '' });
      // Garante que os diretorios do novo arquivo existam na arvore.
      const segments = change.path.split('/');
      for (let i = 1; i < segments.length; i++) {
        const dir = segments.slice(0, i).join('/');
        if (!entries.has(dir)) entries.set(dir, { path: dir, type: 'tree', sha: '' });
      }
    }
  }
  const nextEntries = [...entries.values()];
  return {
    ...map,
    headSha: newHeadSha,
    generatedAt: Date.now(),
    entries: nextEntries,
    fileCount: nextEntries.filter((entry) => entry.type === 'blob').length,
    dirCount: nextEntries.filter((entry) => entry.type === 'tree').length,
  };
}
