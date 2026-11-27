import * as path from 'node:path';

/** Resolve `p` (absolute, or relative to `cwd`) and express it relative to `root` when inside it. */
export function normalizePath(p: string, root: string, cwd?: string): { path: string; outsideRoot: boolean } {
  const expanded = p.startsWith('~/') ? path.join(process.env.HOME ?? '~', p.slice(2)) : p;
  const abs = path.resolve(cwd ?? root, expanded);
  const rel = path.relative(path.resolve(root), abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { path: rel === '' ? '.' : abs, outsideRoot: rel !== '' };
  }
  return { path: rel.split(path.sep).join('/'), outsideRoot: false };
}

/** Absolute path for a project-relative path, refusing anything that escapes the root. */
export function safeJoin(root: string, rel: string): string {
  const r = path.resolve(root);
  const abs = path.resolve(r, rel);
  const back = path.relative(r, abs);
  if (back === '' || back.startsWith('..') || path.isAbsolute(back)) {
    throw new Error(`Refusing to touch path outside project root: ${rel}`);
  }
  return abs;
}

export function isUnder(p: string, dir: string): boolean {
  if (dir === '.' || dir === '') return true;
  const d = dir.replace(/\/+$/, '');
  return p === d || p.startsWith(d + '/');
}
