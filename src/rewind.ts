import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { commitAtOrBefore, isGitRepo, showFile } from './collectors/git';
import { diffFiles, type FileDiff } from './diff';
import { isUnder, safeJoin } from './paths';
import type { TimelineEvent } from './types';

export type RewindMode = 'after' | 'before';
export type ActionKind = 'restore' | 'delete' | 'recreate' | 'unchanged' | 'skip';

export interface RewindAction {
  path: string;
  action: ActionKind;
  /** Where the target content came from. */
  source: 'log' | 'git' | 'none';
  reason: string;
  currentExists: boolean;
  targetExists: boolean;
  /** Diff from the current file to the target (what the rewind will do). */
  diff?: FileDiff;
  binary?: boolean;
}

export interface RewindPlan {
  targetEventId: string;
  targetSeq: number;
  targetTitle: string;
  mode: RewindMode;
  actions: RewindAction[];
  warnings: string[];
  summary: Record<ActionKind, number>;
  /** Hash of the exact plan; apply refuses to run if the disk changed since the preview. */
  token: string;
}

export interface GitResolver {
  commitAt(ts: string): string | undefined;
  show(commit: string, relPath: string): string | null | undefined;
}

export function gitResolver(root: string): GitResolver | undefined {
  if (!isGitRepo(root)) return undefined;
  return { commitAt: (ts) => commitAtOrBefore(root, ts), show: (c, p) => showFile(root, c, p) };
}

export class RewindConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RewindConflictError';
  }
}

const WRITE_TYPES = new Set(['file_edit', 'file_create', 'file_delete']);
const READONLY_CMD =
  /^\s*(?:cd\s+\S+\s*&&\s*)?(?:ls|cat|head|tail|grep|rg|find(?![^\n]*-delete)|pwd|echo|wc|which|tree|git\s+(?:status|log|diff|show|branch(?!\s+-D))|npm\s+(?:test|run\s+test|ls)|node\s+-v|npx\s+tsc\s+--noEmit)\b/;

const emptySummary = (): Record<ActionKind, number> => ({ restore: 0, delete: 0, recreate: 0, unchanged: 0, skip: 0 });

function sha(s: string | null | undefined): string {
  if (s === undefined) return 'unknown';
  if (s === null) return 'absent';
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Does `ev` change (or observe a full snapshot of) project-relative path `p`? */
function touches(ev: TimelineEvent, p: string): boolean {
  if (ev.isError || ev.outsideRoot || !ev.path) return false;
  if (ev.type === 'file_delete' && ev.recursive) return isUnder(p, ev.path);
  if (ev.path !== p) return false;
  if (WRITE_TYPES.has(ev.type)) return true;
  return ev.type === 'tool_call' && typeof ev.after === 'string'; // full-file Read snapshot
}

function stateBefore(ev: TimelineEvent, p: string): string | null | undefined {
  if (ev.type === 'file_delete' && ev.recursive && ev.path !== p) return undefined;
  return ev.before;
}

function stateAfter(ev: TimelineEvent, p: string): string | null | undefined {
  if (ev.type === 'file_delete') return null;
  return ev.path === p ? ev.after : undefined;
}

export interface Target {
  content: string | null | undefined;
  source: RewindAction['source'];
  reason: string;
}

/**
 * State of file `p` right after event index `k` (k = -1: before the first event).
 *  1. "before" content of the first later event touching it (captured from disk at that moment)
 *  2. "after" content of the last earlier event touching it
 *  3. the file in the latest git commit at that time
 */
export function resolveTarget(events: TimelineEvent[], k: number, p: string, git?: GitResolver): Target {
  const label = (e: TimelineEvent) => `#${e.seq + 1} ${e.tool ?? e.type}`;
  for (let j = k + 1; j < events.length; j++) {
    const e = events[j];
    if (!touches(e, p)) continue;
    const s = stateBefore(e, p);
    if (s !== undefined) return { content: s, source: 'log', reason: s === null ? `did not exist before ${label(e)}` : `content captured right before ${label(e)}` };
    break;
  }
  for (let j = k; j >= 0; j--) {
    const e = events[j];
    if (!touches(e, p)) continue;
    const s = stateAfter(e, p);
    if (s !== undefined) return { content: s, source: 'log', reason: s === null ? `deleted by ${label(e)}` : `content as left by ${label(e)}` };
    break;
  }
  if (git) {
    const ts = k >= 0 ? events[k].ts : new Date(Date.parse(events[0]?.ts ?? new Date().toISOString()) - 1).toISOString();
    const commit = git.commitAt(ts);
    if (commit) {
      const c = git.show(commit, p);
      if (typeof c === 'string') return { content: c, source: 'git', reason: `from git commit ${commit.slice(0, 7)}` };
    }
  }
  return { content: undefined, source: 'none', reason: 'no snapshot of this file at that point (not in the log or git)' };
}

function readCurrent(root: string, rel: string): { content: string | null; isDir: boolean; binary: boolean } {
  const abs = safeJoin(root, rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    return { content: null, isDir: false, binary: false };
  }
  if (st.isDirectory()) return { content: null, isDir: true, binary: false };
  const buf = fs.readFileSync(abs);
  return { content: buf.toString('utf8'), isDir: false, binary: buf.includes(0) };
}

function readCurrentSafe(root: string, rel: string): string | null | undefined {
  try {
    return readCurrent(root, rel).content;
  } catch {
    return undefined;
  }
}

export interface PlanOptions {
  root: string;
  events: TimelineEvent[];
  eventId: string;
  mode?: RewindMode;
  /** Git fallback; `null` disables it, `undefined` auto-detects. */
  git?: GitResolver | null;
}

function compute(opts: PlanOptions): { plan: RewindPlan; targets: Map<string, string | null> } {
  const { root, events } = opts;
  const mode = opts.mode ?? 'after';
  const idx = events.findIndex((e) => e.id === opts.eventId);
  if (idx < 0) throw new Error(`Unknown event: ${opts.eventId}`);
  const k = mode === 'before' ? idx - 1 : idx;
  const git = opts.git === null ? undefined : (opts.git ?? gitResolver(root));

  const affected = new Set<string>();
  const warnings: string[] = [];
  let outside = 0;
  let shell = 0;
  for (let j = k + 1; j < events.length; j++) {
    const e = events[j];
    if (e.isError) continue;
    if (WRITE_TYPES.has(e.type) && e.path) {
      if (e.outsideRoot) {
        outside++;
        continue;
      }
      if (e.type === 'file_delete' && e.recursive) e.deletedFiles?.forEach((f) => affected.add(f));
      else affected.add(e.path);
    }
    if (e.type === 'checkpoint' && e.source === 'git' && e.commit && e.files) e.files.forEach((f) => affected.add(f.path));
    if (e.type === 'shell_cmd' && e.command && !READONLY_CMD.test(e.command)) shell++;
  }
  if (outside) warnings.push(`${outside} change(s) outside the project root cannot be rewound and were skipped.`);
  if (shell) warnings.push(`${shell} shell command(s) ran after this point. Side effects that are not visible in the log (npm install, sed -i, chmod, …) are not reverted.`);

  const actions: RewindAction[] = [];
  const targets = new Map<string, string | null>();
  for (const p of [...affected].sort()) {
    if (p === '.' || p.startsWith('.agent-dashcam/') || p === '.git' || p.startsWith('.git/')) continue;
    let cur: ReturnType<typeof readCurrent>;
    try {
      cur = readCurrent(root, p);
    } catch (err) {
      actions.push({ path: p, action: 'skip', source: 'none', reason: (err as Error).message, currentExists: false, targetExists: false });
      continue;
    }
    if (cur.isDir) {
      actions.push({ path: p, action: 'skip', source: 'none', reason: 'path is a directory now', currentExists: true, targetExists: false });
      continue;
    }
    const t = resolveTarget(events, k, p, git);
    const base = { path: p, source: t.source, reason: t.reason, currentExists: cur.content !== null };
    if (t.content === undefined) {
      if (cur.content === null) actions.push({ ...base, action: 'unchanged', reason: 'not present now and no record that it existed', targetExists: false });
      else actions.push({ ...base, action: 'skip', targetExists: false });
      continue;
    }
    let action: ActionKind;
    if (t.content === null) action = cur.content === null ? 'unchanged' : 'delete';
    else if (cur.content === null) action = 'recreate';
    else action = cur.content === t.content ? 'unchanged' : 'restore';
    const a: RewindAction = { ...base, action, targetExists: t.content !== null };
    if (action !== 'unchanged') {
      if (cur.binary) a.binary = true;
      else a.diff = diffFiles(cur.content, t.content);
      targets.set(p, t.content);
    }
    actions.push(a);
  }

  const summary = emptySummary();
  actions.forEach((a) => summary[a.action]++);
  const target = events[idx];
  const tokenSrc = JSON.stringify({
    id: target.id,
    mode,
    a: actions.map((a) => [a.path, a.action, sha(readCurrentSafe(root, a.path)), sha(targets.get(a.path))]),
  });
  return {
    plan: {
      targetEventId: target.id,
      targetSeq: target.seq,
      targetTitle: mode === 'before' ? `before: ${target.title}` : target.title,
      mode,
      actions,
      warnings,
      summary,
      token: createHash('sha256').update(tokenSrc).digest('hex').slice(0, 24),
    },
    targets,
  };
}

/** Dry-run: what would change if we rewound to this event. Touches nothing on disk. */
export function planRewind(opts: PlanOptions): RewindPlan {
  return compute(opts).plan;
}

export interface BackupManifest {
  id: string;
  createdAt: string;
  label: string;
  files: { path: string; existed: boolean; content?: string }[];
}

export interface BackupInfo {
  id: string;
  createdAt: string;
  label: string;
  fileCount: number;
}

export interface ApplyResult {
  backupId: string;
  changed: { path: string; action: ActionKind }[];
  plan: RewindPlan;
}

function dashcamDir(root: string): string {
  const d = path.join(root, '.agent-dashcam');
  fs.mkdirSync(d, { recursive: true });
  const gi = path.join(d, '.gitignore');
  if (!fs.existsSync(gi)) fs.writeFileSync(gi, '*\n');
  return d;
}

/** Refuse writes whose real parent directory resolves outside the project (symlink escapes). */
function assertWritable(root: string, rel: string): string {
  const abs = safeJoin(root, rel);
  const realRoot = fs.realpathSync(root);
  let dir = path.dirname(abs);
  while (!fs.existsSync(dir)) dir = path.dirname(dir);
  const realDir = fs.realpathSync(dir);
  if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
    throw new Error(`Refusing to write through a symlink that leaves the project: ${rel}`);
  }
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) throw new Error(`Refusing to overwrite symlink: ${rel}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return abs;
}

/** Snapshot the current state of `paths` so the operation can be undone. */
export function createBackup(root: string, paths: string[], label: string): BackupManifest {
  const id =
    new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').slice(0, 15) + '-' + randomBytes(3).toString('hex');
  const files = paths.map((p) => {
    const abs = safeJoin(root, p);
    if (!fs.existsSync(abs) || fs.lstatSync(abs).isDirectory()) return { path: p, existed: false };
    return { path: p, existed: true, content: fs.readFileSync(abs).toString('base64') };
  });
  const manifest: BackupManifest = { id, createdAt: new Date().toISOString(), label, files };
  const dir = path.join(dashcamDir(root), 'backups', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

function writeFile(root: string, rel: string, content: Buffer | string): void {
  const abs = assertWritable(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function removeFile(root: string, rel: string): void {
  fs.rmSync(assertWritable(root, rel), { force: true });
}

function logRewind(root: string, entry: Record<string, unknown>): void {
  fs.appendFileSync(path.join(dashcamDir(root), 'rewinds.jsonl'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
}

/**
 * Execute a rewind. `token` must come from a preview (planRewind) of the same target;
 * if the files changed in between, a RewindConflictError is thrown and nothing is touched.
 */
export function applyRewind(opts: PlanOptions & { token: string }): ApplyResult {
  const { plan, targets } = compute(opts);
  if (plan.token !== opts.token) {
    throw new RewindConflictError('Files changed since the dry-run preview. Please preview again before rewinding.');
  }
  const todo = plan.actions.filter((a) => a.action === 'restore' || a.action === 'delete' || a.action === 'recreate');
  // Validate everything before touching anything.
  todo.forEach((a) => assertWritable(opts.root, a.path));
  const backup = createBackup(opts.root, todo.map((a) => a.path), `before rewind to #${plan.targetSeq + 1} ${plan.targetTitle}`);
  for (const a of todo) {
    const t = targets.get(a.path);
    if (t === null || a.action === 'delete') removeFile(opts.root, a.path);
    else if (typeof t === 'string') writeFile(opts.root, a.path, t);
  }
  logRewind(opts.root, { targetEventId: plan.targetEventId, targetTitle: plan.targetTitle, mode: plan.mode, files: todo.length, backupId: backup.id });
  return { backupId: backup.id, changed: todo.map((a) => ({ path: a.path, action: a.action })), plan };
}

export function listBackups(root: string): BackupInfo[] {
  const dir = path.join(root, '.agent-dashcam', 'backups');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .sort()
    .reverse()
    .map((id) => {
      try {
        const m: BackupManifest = JSON.parse(fs.readFileSync(path.join(dir, id, 'manifest.json'), 'utf8'));
        return { id: m.id, createdAt: m.createdAt, label: m.label, fileCount: m.files.length };
      } catch {
        return undefined;
      }
    })
    .filter((x): x is BackupInfo => Boolean(x));
}

/** Undo a rewind by restoring a backup. The current state is itself backed up first. */
export function restoreBackup(root: string, backupId: string): ApplyResult {
  if (!/^[\w-]+$/.test(backupId)) throw new Error('Invalid backup id');
  const file = path.join(root, '.agent-dashcam', 'backups', backupId, 'manifest.json');
  if (!fs.existsSync(file)) throw new Error(`Backup not found: ${backupId}`);
  const m: BackupManifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  m.files.forEach((f) => assertWritable(root, f.path));
  const safety = createBackup(root, m.files.map((f) => f.path), `before undo of ${backupId}`);
  const changed: ApplyResult['changed'] = [];
  for (const f of m.files) {
    if (f.existed && f.content !== undefined) {
      writeFile(root, f.path, Buffer.from(f.content, 'base64'));
      changed.push({ path: f.path, action: 'restore' });
    } else {
      removeFile(root, f.path);
      changed.push({ path: f.path, action: 'delete' });
    }
  }
  logRewind(root, { undo: true, backupId, files: changed.length, safetyBackupId: safety.id });
  const summary = emptySummary();
  changed.forEach((c) => summary[c.action]++);
  return {
    backupId: safety.id,
    changed,
    plan: { targetEventId: '', targetSeq: -1, targetTitle: `undo ${backupId}`, mode: 'after', actions: [], warnings: [], summary, token: '' },
  };
}
