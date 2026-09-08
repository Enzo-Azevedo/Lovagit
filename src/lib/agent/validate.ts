import type { PendingFileChange } from '../types';

/**
 * Conferencia do que vai ser commitado.
 *
 * O agente escreve arquivo inteiro e commita direto na branch padrao. Quem
 * consome essa branch — o preview do Lovable, um deploy automatico, o proximo
 * `npm run dev` de quem clonou — descobre o erro DEPOIS, e a mensagem que chega
 * ("Preview has not been built yet") nao diz qual arquivo nem qual linha.
 *
 * Aqui nao ha compilador nem bundler: e' um navegador. Entao a regra e' so
 * conferir o que da para conferir com certeza, e separar por confianca:
 *
 * - **Impedimento**: erro que quebra a build de forma determinista. Barra o
 *   commit; o modelo recebe o motivo e conserta antes de tentar de novo.
 * - **Suspeita**: sinal forte de problema que nao da para provar sem compilar.
 *   Vai junto no aviso, sem barrar — barrar por heuristica cara caro no dia em
 *   que a heuristica erra.
 */

export interface ChangeProblem {
  path: string;
  detail: string;
  /** `blocking` impede o commit; `suspicious` so aparece no aviso. */
  level: 'blocking' | 'suspicious';
}

const CODIGO = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;

/** Extensoes tentadas quando o import nao traz uma. Ordem do resolvedor. */
const EXTENSOES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/**
 * Remove comentarios antes de procurar imports.
 *
 * Sem isto, um import comentado — coisa que se faz o tempo todo ao depurar —
 * seria cobrado como se estivesse valendo, e o commit legitimo seria barrado.
 */
export function stripComments(source: string): string {
  let out = '';
  let i = 0;
  let estado: 'codigo' | 'linha' | 'bloco' | 'aspas' = 'codigo';
  let aspa = '';

  while (i < source.length) {
    const dois = source.slice(i, i + 2);
    if (estado === 'codigo') {
      if (dois === '//') {
        estado = 'linha';
        i += 2;
        continue;
      }
      if (dois === '/*') {
        estado = 'bloco';
        i += 2;
        continue;
      }
      if (source[i] === '"' || source[i] === "'" || source[i] === '`') {
        estado = 'aspas';
        aspa = source[i];
      }
      out += source[i];
      i += 1;
      continue;
    }
    if (estado === 'linha') {
      if (source[i] === '\n') {
        estado = 'codigo';
        out += '\n';
      }
      i += 1;
      continue;
    }
    if (estado === 'bloco') {
      if (dois === '*/') {
        estado = 'codigo';
        i += 2;
      } else {
        // Preserva as quebras de linha para o numero da linha nao mudar.
        if (source[i] === '\n') out += '\n';
        i += 1;
      }
      continue;
    }
    // Dentro de string: `\` escapa o proximo caractere, inclusive a propria aspa.
    if (source[i] === '\\') {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (source[i] === aspa) estado = 'codigo';
    out += source[i];
    i += 1;
  }
  return out;
}

/** So imports RELATIVOS. Alias (`@/`) depende do tsconfig, e pacote, do
 *  node_modules — nenhum dos dois da para resolver so com a arvore do repo. */
export function relativeImports(source: string): string[] {
  const limpo = stripComments(source);
  const encontrados = new Set<string>();
  const padrao =
    /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"](\.[^'"]*)['"]/g;
  for (let m = padrao.exec(limpo); m !== null; m = padrao.exec(limpo)) {
    encontrados.add(m[1]);
  }
  return [...encontrados];
}

/** Junta o caminho do import com o do arquivo, resolvendo `.` e `..`. */
export function resolveRelative(fromPath: string, spec: string): string {
  const base = fromPath.split('/').slice(0, -1);
  const partes = spec.split('/');
  for (const parte of partes) {
    if (parte === '.' || parte === '') continue;
    if (parte === '..') base.pop();
    else base.push(parte);
  }
  return base.join('/');
}

function resolveExiste(alvo: string, existentes: Set<string>): boolean {
  if (existentes.has(alvo)) return true;
  if (EXTENSOES.some((ext) => existentes.has(alvo + ext))) return true;
  return EXTENSOES.some((ext) => existentes.has(`${alvo}/index${ext}`));
}

/**
 * Caminhos que existirao DEPOIS deste commit.
 *
 * Tem que ser o estado final, e nao o atual: um arquivo novo que importa outro
 * arquivo novo do mesmo commit e' correto, e olhar so a arvore ja publicada
 * acusaria os dois.
 */
export function pathsAfterChanges(
  repoPaths: Iterable<string>,
  changes: PendingFileChange[],
): Set<string> {
  const finais = new Set(repoPaths);
  for (const change of changes) {
    if (change.action === 'delete') finais.delete(change.path);
    else finais.add(change.path);
  }
  return finais;
}

const MARCADOR_CONFLITO = /^(?:<{7}|={7}|>{7})(?:\s|$)/m;

export function findChangeProblems(
  changes: PendingFileChange[],
  repoPaths: Iterable<string>,
): ChangeProblem[] {
  const finais = pathsAfterChanges(repoPaths, changes);
  const problemas: ChangeProblem[] = [];

  for (const change of changes) {
    // `content` e' nulo em remocao; o `continue` acima ja cobre o caso, mas o
    // tipo nao amarra as duas coisas — a guarda explicita e' o que garante.
    if (change.action === 'delete' || change.content === null) continue;
    const { path, content } = change;

    if (MARCADOR_CONFLITO.test(content)) {
      problemas.push({
        path,
        level: 'blocking',
        detail: 'O conteudo tem marcador de conflito de merge (<<<<<<< / ======= / >>>>>>>).',
      });
    }

    if (/\.json$/i.test(path)) {
      try {
        JSON.parse(content);
      } catch (erro) {
        problemas.push({
          path,
          level: 'blocking',
          detail: `JSON invalido: ${erro instanceof Error ? erro.message : String(erro)}`,
        });
      }
    }

    if (CODIGO.test(path)) {
      for (const spec of relativeImports(content)) {
        // O Vite usa sufixo de query para mudar como o arquivo e' carregado
        // (`./w?worker`, `./svg?raw`). O arquivo e' o que vem antes do `?`.
        const alvo = resolveRelative(path, spec.split('?')[0]);
        if (!resolveExiste(alvo, finais)) {
          problemas.push({
            path,
            level: 'blocking',
            detail:
              `Importa '${spec}', que nao existe no repositorio nem entre as alteracoes ` +
              'deste commit. Crie o arquivo ou corrija o caminho.',
          });
        }
      }
    }

    // Suspeita, nao impedimento: encolhimento brutal e' a assinatura de uma
    // escrita truncada — o modelo mandou meio arquivo achando que mandou
    // inteiro. Mas apagar codigo de verdade tambem encolhe, e barrar isso seria
    // impedir trabalho legitimo por um palpite.
    const antes = change.previousContent;
    if (antes !== null && antes.length > 400 && content.length < antes.length * 0.25) {
      problemas.push({
        path,
        level: 'suspicious',
        detail:
          `O arquivo tinha ${antes.length} caracteres e ficou com ${content.length}. ` +
          'Se a intencao nao era apagar quase tudo, o conteudo pode ter vindo truncado.',
      });
    }
  }

  return problemas;
}

/** Texto do impedimento para o modelo — vazio quando nada bloqueia. */
export function describeProblems(problemas: ChangeProblem[]): string {
  const bloqueiam = problemas.filter((p) => p.level === 'blocking');
  const suspeitas = problemas.filter((p) => p.level === 'suspicious');
  const linhas: string[] = [];

  if (bloqueiam.length > 0) {
    linhas.push(
      'Commit barrado: as alteracoes abaixo quebrariam a build de quem consome esta branch',
      '(preview do Lovable, deploy automatico, ou simplesmente o proximo `npm run dev`).',
      '',
      ...bloqueiam.map((p) => `- ${p.path}: ${p.detail}`),
    );
  }
  if (suspeitas.length > 0) {
    if (linhas.length > 0) linhas.push('');
    linhas.push('Vale conferir antes de seguir:', ...suspeitas.map((p) => `- ${p.path}: ${p.detail}`));
  }
  return linhas.join('\n');
}
