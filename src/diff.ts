export type DiffLineType = 'ctx' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  hunks: DiffHunk[];
  added: number;
  removed: number;
}

function splitLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level edit script (LCS based, with common prefix/suffix trimming). */
export function diffLines(a: string, b: string): DiffLine[] {
  const A = splitLines(a);
  const B = splitLines(b);
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (
    suf < A.length - pre &&
    suf < B.length - pre &&
    A[A.length - 1 - suf] === B[B.length - 1 - suf]
  )
    suf++;

  const out: DiffLine[] = [];
  for (let i = 0; i < pre; i++) out.push({ type: 'ctx', text: A[i], oldNo: i + 1, newNo: i + 1 });

  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const n = a2.length;
  const m = b2.length;
  const middle: DiffLine[] = [];
  if (n * m > 4_000_000) {
    // Too large for the DP table: fall back to "replace block".
    a2.forEach((t) => middle.push({ type: 'del', text: t }));
    b2.forEach((t) => middle.push({ type: 'add', text: t }));
  } else {
    const dp: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a2[i] === b2[j]) {
        middle.push({ type: 'ctx', text: a2[i] });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
        middle.push({ type: 'del', text: a2[i] });
        i++;
      } else {
        middle.push({ type: 'add', text: b2[j] });
        j++;
      }
    }
  }
  let oldNo = pre;
  let newNo = pre;
  for (const l of middle) {
    if (l.type !== 'add') l.oldNo = ++oldNo;
    if (l.type !== 'del') l.newNo = ++newNo;
    out.push(l);
  }
  for (let k = A.length - suf; k < A.length; k++) {
    out.push({ type: 'ctx', text: A[k], oldNo: ++oldNo, newNo: ++newNo });
  }
  return out;
}

/** Diff grouped into hunks with `context` lines around each change. */
export function diffFiles(a: string | null | undefined, b: string | null | undefined, context = 3): FileDiff {
  const lines = diffLines(a ?? '', b ?? '');
  const added = lines.filter((l) => l.type === 'add').length;
  const removed = lines.filter((l) => l.type === 'del').length;
  const hunks: DiffHunk[] = [];
  const changeIdx = lines.map((l, i) => (l.type === 'ctx' ? -1 : i)).filter((i) => i >= 0);
  if (changeIdx.length === 0) return { hunks, added, removed };

  let start = Math.max(0, changeIdx[0] - context);
  let end = Math.min(lines.length - 1, changeIdx[0] + context);
  const flush = () => {
    const slice = lines.slice(start, end + 1);
    const first = slice[0];
    hunks.push({
      oldStart: first.oldNo ?? (slice.find((l) => l.oldNo)?.oldNo ?? 1),
      newStart: first.newNo ?? (slice.find((l) => l.newNo)?.newNo ?? 1),
      lines: slice,
    });
  };
  for (const idx of changeIdx.slice(1)) {
    if (idx - context <= end + 1) {
      end = Math.min(lines.length - 1, idx + context);
    } else {
      flush();
      start = Math.max(0, idx - context);
      end = Math.min(lines.length - 1, idx + context);
    }
  }
  flush();
  return { hunks, added, removed };
}

/** Render a FileDiff as unified diff text. */
export function toUnified(diff: FileDiff, path = 'file'): string {
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const h of diff.hunks) {
    const oldLen = h.lines.filter((l) => l.type !== 'add').length;
    const newLen = h.lines.filter((l) => l.type !== 'del').length;
    out.push(`@@ -${h.oldStart},${oldLen} +${h.newStart},${newLen} @@`);
    for (const l of h.lines) out.push((l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text);
  }
  return out.join('\n');
}
