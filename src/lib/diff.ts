export interface DiffLine {
  type: 'add' | 'del' | 'ctx' | 'gap';
  text: string;
}

const MAX_LCS_CELLS = 4_000_000;

/** Diff de linhas por LCS. Arquivos muito grandes caem em "substituicao total"
 *  para nao travar a UI com uma matriz gigante. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');

  if (a.length * b.length > MAX_LCS_CELLS) {
    return [
      ...a.map<DiffLine>((text) => ({ type: 'del', text })),
      ...b.map<DiffLine>((text) => ({ type: 'add', text })),
    ];
  }

  // dp[i][j] = tamanho da LCS entre a[i..] e b[j..]
  const dp: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array<number>(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ type: 'ctx', text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ type: 'del', text: a[i] });
      i++;
    } else {
      out.push({ type: 'add', text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ type: 'del', text: a[i++] });
  while (j < b.length) out.push({ type: 'add', text: b[j++] });
  return out;
}

export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.type === 'add') added++;
    else if (line.type === 'del') removed++;
  }
  return { added, removed };
}

/** Mantem `context` linhas ao redor de cada mudanca e colapsa o resto. */
export function collapseContext(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  lines.forEach((line, index) => {
    if (line.type === 'add' || line.type === 'del') {
      for (let k = Math.max(0, index - context); k <= Math.min(lines.length - 1, index + context); k++) {
        keep[k] = true;
      }
    }
  });

  const out: DiffLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (keep[index]) {
      if (skipped > 0) {
        out.push({ type: 'gap', text: `... ${skipped} linha(s) sem alteracao` });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ type: 'gap', text: `... ${skipped} linha(s) sem alteracao` });
  return out;
}
