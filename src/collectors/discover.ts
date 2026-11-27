import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionInfo } from '../types';

export function claudeProjectsDir(): string {
  return (
    process.env.CLAUDE_PROJECTS_DIR ??
    path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects')
  );
}

/** Claude Code stores sessions under a directory named after the cwd with non-alphanumerics replaced by '-'. */
export function encodeProjectDir(root: string): string {
  return path.resolve(root).replace(/[^a-zA-Z0-9]/g, '-');
}

function readHead(file: string, bytes = 64 * 1024): string {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = fs.readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/** Cheap metadata from the first lines of a session file. */
export function peekSession(file: string): SessionInfo {
  const id = path.basename(file, '.jsonl');
  let title = '';
  let startedAt: string | undefined;
  let cwd: string | undefined;
  try {
    for (const line of readHead(file).split('\n')) {
      if (!line.trim()) continue;
      let rec: any;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      if (!startedAt && rec.timestamp) startedAt = rec.timestamp;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!title && rec.type === 'user' && rec.message && !rec.isMeta) {
        const c = rec.message.content;
        const t =
          typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === 'text' ? x.text : '')).join(' ') : '';
        if (t.trim() && !t.trim().startsWith('<')) title = t.replace(/\s+/g, ' ').trim().slice(0, 90);
      }
      if (title && startedAt && cwd) break;
    }
  } catch {
    /* unreadable */
  }
  let endedAt: string | undefined;
  try {
    endedAt = fs.statSync(file).mtime.toISOString();
  } catch {
    /* ignore */
  }
  return { id, file, title: title || id, startedAt, endedAt, cwd };
}

/** All Claude Code sessions recorded for `root`, newest first. */
export function discoverSessions(root: string, projectsDir = claudeProjectsDir()): SessionInfo[] {
  if (!fs.existsSync(projectsDir)) return [];
  const want = path.resolve(root);
  const files = new Set<string>();
  const listJsonl = (dir: string) => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  };
  listJsonl(path.join(projectsDir, encodeProjectDir(want))).forEach((f) => files.add(f));
  if (files.size === 0) {
    // Fallback: scan every project and match on the recorded cwd.
    for (const d of fs.readdirSync(projectsDir)) {
      for (const f of listJsonl(path.join(projectsDir, d))) {
        const info = peekSession(f);
        if (info.cwd && path.resolve(info.cwd) === want) files.add(f);
      }
    }
  }
  return [...files].map(peekSession).sort((a, b) => (b.endedAt ?? '').localeCompare(a.endedAt ?? ''));
}
