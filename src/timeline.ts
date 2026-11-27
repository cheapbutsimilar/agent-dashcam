import * as fs from 'node:fs';
import * as path from 'node:path';
import { collectGitEvents, commitAtOrBefore, isGitRepo, listTrackedFiles } from './collectors/git';
import { detectIncidents } from './detector';
import { parseClaudeSession } from './parsers/claude';
import { isUnder } from './paths';
import type { SessionInfo, Timeline, TimelineEvent } from './types';

export interface BuildOptions {
  root: string;
  sessionFile?: string;
  /** Include git commits / working tree. Default true. */
  git?: boolean;
}

/** Sort, number, expand recursive deletes and annotate risks. Mutates the events. */
export function finalizeEvents(events: TimelineEvent[], root: string, useGit = true): TimelineEvent[] {
  const sorted = events
    .map((e, i) => ({ e, i }))
    .sort((a, b) => a.e.ts.localeCompare(b.e.ts) || a.i - b.i)
    .map(({ e }) => e);
  sorted.forEach((e, i) => (e.seq = i));

  const gitOk = useGit && isGitRepo(root);
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    if (ev.type !== 'file_delete' || !ev.path || ev.outsideRoot || !ev.recursive) continue;
    const known = new Set<string>();
    // Files we know existed under the deleted directory from earlier events...
    for (let j = 0; j < i; j++) {
      const p = sorted[j].path;
      if (p && !sorted[j].outsideRoot && p !== ev.path && isUnder(p, ev.path)) {
        if (sorted[j].after === null) known.delete(p);
        else known.add(p);
      }
    }
    // ...and from git at that point in time.
    if (gitOk) {
      const c = commitAtOrBefore(root, ev.ts);
      if (c) for (const f of listTrackedFiles(root, c, ev.path)) known.add(f);
    }
    ev.deletedFiles = [...known].sort();
  }
  return detectIncidents(sorted);
}

function stats(events: TimelineEvent[]): Timeline['stats'] {
  const byType: Record<string, number> = {};
  let risks = 0;
  let critical = 0;
  for (const e of events) {
    byType[e.type] = (byType[e.type] ?? 0) + 1;
    if (e.risks.length) risks++;
    if (e.risks.some((r) => r.severity === 'critical')) critical++;
  }
  return { total: events.length, byType, risks, critical };
}

/** Rewinds performed by agent-dashcam itself, shown as checkpoints. */
export function loadRewindLog(root: string): TimelineEvent[] {
  const f = path.join(root, '.agent-dashcam', 'rewinds.jsonl');
  if (!fs.existsSync(f)) return [];
  const out: TimelineEvent[] = [];
  fs.readFileSync(f, 'utf8')
    .split('\n')
    .filter(Boolean)
    .forEach((l, i) => {
      try {
        const r = JSON.parse(l);
        out.push({
          id: `rewind-${i}`,
          seq: 0,
          ts: r.ts,
          type: 'checkpoint',
          source: 'dashcam',
          title: r.undo ? `Undo rewind (backup ${r.backupId})` : `Rewound ${r.files} file(s) to "${r.targetTitle}"`,
          output: JSON.stringify(r, null, 2),
          risks: [],
        });
      } catch {
        /* skip corrupt line */
      }
    });
  return out;
}

export function buildTimeline(opts: BuildOptions): Timeline {
  const root = path.resolve(opts.root);
  let events: TimelineEvent[] = [];
  let session: SessionInfo | null = null;
  if (opts.sessionFile) {
    const text = fs.readFileSync(opts.sessionFile, 'utf8');
    const id = path.basename(opts.sessionFile, '.jsonl');
    const parsed = parseClaudeSession(text, { root, sessionId: id });
    events = parsed.events;
    session = { id, file: opts.sessionFile, title: parsed.title, startedAt: parsed.startedAt, endedAt: parsed.endedAt, cwd: parsed.cwd };
  }
  if (opts.git !== false) {
    const since = session?.startedAt ? new Date(Date.parse(session.startedAt) - 6 * 3600_000).toISOString() : undefined;
    events.push(...collectGitEvents(root, { since, limit: session ? 100 : 30, includeWorkingTree: true }));
  }
  events.push(...loadRewindLog(root));
  const finalEvents = finalizeEvents(events, root, opts.git !== false);
  if (session) session.eventCount = finalEvents.length;
  return { root, session, events: finalEvents, stats: stats(finalEvents) };
}
