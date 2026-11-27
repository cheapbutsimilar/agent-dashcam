import { execFileSync } from 'node:child_process';
import type { TimelineEvent } from '../types';

function git(root: string, args: string[], maxBuffer = 64 * 1024 * 1024): string | undefined {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

export function isGitRepo(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

/** Path of `root` relative to the repository toplevel ("" at the top). */
function gitPrefix(root: string): string {
  return (git(root, ['rev-parse', '--show-prefix']) ?? '').trim();
}

/** Latest commit (reachable from HEAD) whose committer date is <= ts. */
export function commitAtOrBefore(root: string, ts: string): string | undefined {
  const t = Math.floor(Date.parse(ts) / 1000);
  if (!Number.isFinite(t)) return undefined;
  const out = git(root, ['rev-list', '-1', `--before=${t}`, 'HEAD']);
  return out?.trim() || undefined;
}

/** File content at a commit. `null` when the path is not a file there; undefined on error. */
export function showFile(root: string, commit: string, relPath: string): string | null | undefined {
  const entry = git(root, ['ls-tree', commit, '--', relPath]);
  if (entry === undefined) return undefined;
  if (!entry.trim()) return null;
  // "<mode> <type> <hash>\t<path>" — directories (tree) are not files
  if (entry.split(/\s+/)[1] !== 'blob') return null;
  // ./ makes the path relative to cwd (= project root) rather than the repo toplevel
  return git(root, ['show', `${commit}:./${relPath}`]);
}

/** Files tracked under a directory at a commit (project-relative). */
export function listTrackedFiles(root: string, commit: string, dir: string): string[] {
  const out = git(root, ['ls-tree', '-r', '--name-only', '--full-tree', commit, '--', dir === '.' ? '.' : dir]);
  if (!out) return [];
  const prefix = gitPrefix(root);
  return out
    .split('\n')
    .filter(Boolean)
    .map((p) => (prefix && p.startsWith(prefix) ? p.slice(prefix.length) : p));
}

export interface GitCollectOptions {
  /** Only include commits at or after this time. */
  since?: string;
  limit?: number;
  /** Add a checkpoint event describing uncommitted working tree changes. */
  includeWorkingTree?: boolean;
}

/** Commits as checkpoint events, plus an optional "working tree now" checkpoint. */
export function collectGitEvents(root: string, opts: GitCollectOptions = {}): TimelineEvent[] {
  if (!isGitRepo(root)) return [];
  const events: TimelineEvent[] = [];
  const args = ['log', `-n${opts.limit ?? 100}`, '--name-status', '--format=%x1e%H%x1f%cI%x1f%an%x1f%s', '--relative'];
  if (opts.since) args.push(`--since=${Math.floor(Date.parse(opts.since) / 1000)}`);
  const log = git(root, args) ?? '';
  for (const chunk of log.split('\x1e')) {
    if (!chunk.trim()) continue;
    const [header, ...rest] = chunk.split('\n');
    const [hash, date, author, subject] = header.split('\x1f');
    if (!hash) continue;
    const files = rest.filter(Boolean).map((l) => {
      const parts = l.split('\t');
      return { status: parts[0], path: parts[parts.length - 1] };
    });
    events.push({
      id: `git-${hash.slice(0, 10)}`,
      seq: 0,
      ts: new Date(date).toISOString(),
      type: 'checkpoint',
      source: 'git',
      title: `Commit ${hash.slice(0, 7)}: ${subject}`,
      commit: hash,
      files,
      output: `${author} — ${subject}\n\n${files.map((f) => `${f.status}\t${f.path}`).join('\n')}`,
      risks: [],
    });
  }

  if (opts.includeWorkingTree) {
    const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.']) ?? '';
    const prefix = gitPrefix(root);
    const files = status
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        let p = l.slice(3);
        if (p.includes(' -> ')) p = p.split(' -> ')[1];
        p = p.replace(/^"|"$/g, '');
        if (prefix && p.startsWith(prefix)) p = p.slice(prefix.length);
        return { status: l.slice(0, 2).trim() || '?', path: p };
      });
    if (files.length) {
      const diffText = git(root, ['diff', 'HEAD', '--relative', '--', '.']) ?? '';
      const deleted = files.filter((f) => f.status.includes('D')).map((f) => f.path);
      events.push({
        id: 'git-worktree',
        seq: 0,
        ts: new Date().toISOString(),
        type: 'checkpoint',
        source: 'git',
        title: `Working tree now: ${files.length} uncommitted change${files.length > 1 ? 's' : ''}`,
        files,
        deletedFiles: deleted.length ? deleted : undefined,
        diffText: diffText.length > 400_000 ? diffText.slice(0, 400_000) + '\n… (truncated)' : diffText,
        output: files.map((f) => `${f.status}\t${f.path}`).join('\n'),
        risks: [],
      });
    }
  }
  return events;
}
