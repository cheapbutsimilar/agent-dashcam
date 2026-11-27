import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { applyRewind, listBackups, planRewind, restoreBackup, RewindConflictError } from '../src/rewind';
import { finalizeEvents } from '../src/timeline';
import type { TimelineEvent } from '../src/types';
import { tmpDir } from './helpers';

let t = 0;
function ev(p: Partial<TimelineEvent>): TimelineEvent {
  t++;
  return { id: `e${t}`, seq: 0, ts: new Date(Date.UTC(2026, 0, 1, 0, t)).toISOString(), type: 'tool_call', source: 'claude', title: `event ${t}`, risks: [], ...p };
}

const read = (root: string, p: string) => (fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p), 'utf8') : null);
const write = (root: string, p: string, c: string) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), c);
};

/** Project where an agent edited a.txt twice, created b.txt and deleted c.txt (no git). */
function scenario() {
  const root = tmpDir();
  write(root, 'a.txt', 'v3\n');
  write(root, 'b.txt', 'new\n');
  write(root, 'keep.txt', 'untouched\n');
  const events = finalizeEvents(
    [
      ev({ type: 'checkpoint', title: 'prompt' }),
      ev({ type: 'file_edit', path: 'a.txt', before: 'v1\n', after: 'v2\n' }),
      ev({ type: 'file_create', path: 'b.txt', before: null, after: 'new\n' }),
      ev({ type: 'file_edit', path: 'a.txt', before: 'v2\n', after: 'v3\n' }),
      ev({ type: 'shell_cmd', command: 'rm c.txt' }),
      ev({ type: 'file_delete', path: 'c.txt' }),
    ],
    root,
    false,
  );
  return { root, events };
}

test('dry-run reports actions without touching the disk', () => {
  const { root, events } = scenario();
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  const by = Object.fromEntries(plan.actions.map((a) => [a.path, a]));
  assert.equal(by['a.txt'].action, 'restore');
  assert.equal(by['b.txt'].action, 'delete');
  assert.equal(by['c.txt'].action, 'unchanged'); // unknown content and not on disk -> nothing to do
  assert.equal(by['keep.txt'], undefined);
  assert.equal(by['a.txt'].diff!.removed, 1);
  assert.equal(read(root, 'a.txt'), 'v3\n');
  assert.equal(read(root, 'b.txt'), 'new\n');
  assert.ok(plan.warnings.some((w) => w.includes('shell command')));
});

test('rewind to the middle restores the intermediate state', () => {
  const { root, events } = scenario();
  const mid = events.find((e) => e.type === 'file_create')!;
  const plan = planRewind({ root, events, eventId: mid.id, git: null });
  applyRewind({ root, events, eventId: mid.id, token: plan.token, git: null });
  assert.equal(read(root, 'a.txt'), 'v2\n');
  assert.equal(read(root, 'b.txt'), 'new\n');
});

test('apply executes the plan, writes a backup, and undo restores it', () => {
  const { root, events } = scenario();
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  const res = applyRewind({ root, events, eventId: events[0].id, token: plan.token, git: null });
  assert.equal(read(root, 'a.txt'), 'v1\n');
  assert.equal(read(root, 'b.txt'), null);
  assert.equal(read(root, 'keep.txt'), 'untouched\n');
  assert.equal(listBackups(root).length, 1);
  assert.equal(read(root, '.agent-dashcam/.gitignore'), '*\n');

  restoreBackup(root, res.backupId);
  assert.equal(read(root, 'a.txt'), 'v3\n');
  assert.equal(read(root, 'b.txt'), 'new\n');
});

test('"before" mode rewinds to the state right before the event', () => {
  const { root, events } = scenario();
  const second = events.filter((e) => e.path === 'a.txt')[1];
  const plan = planRewind({ root, events, eventId: second.id, mode: 'before', git: null });
  applyRewind({ root, events, eventId: second.id, mode: 'before', token: plan.token, git: null });
  assert.equal(read(root, 'a.txt'), 'v2\n');
});

test('apply refuses when files changed after the preview', () => {
  const { root, events } = scenario();
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  write(root, 'a.txt', 'someone edited this\n');
  assert.throws(() => applyRewind({ root, events, eventId: events[0].id, token: plan.token, git: null }), RewindConflictError);
  assert.equal(read(root, 'a.txt'), 'someone edited this\n');
});

test('Read snapshots recover deleted untracked files (e.g. .env)', () => {
  const root = tmpDir();
  const events = finalizeEvents(
    [ev({ type: 'tool_call', tool: 'Read', path: '.env', before: 'SECRET=1\n', after: 'SECRET=1\n' }), ev({ type: 'file_delete', path: '.env' })],
    root,
    false,
  );
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  assert.equal(plan.actions[0].action, 'recreate');
  applyRewind({ root, events, eventId: events[0].id, token: plan.token, git: null });
  assert.equal(read(root, '.env'), 'SECRET=1\n');
});

test('files with no known prior state are skipped, never guessed', () => {
  const root = tmpDir();
  write(root, 'x.ts', 'current\n');
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_edit', path: 'x.ts', snippet: { old: 'a', new: 'b' } })], root, false);
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  assert.equal(plan.actions[0].action, 'skip');
  applyRewind({ root, events, eventId: events[0].id, token: plan.token, git: null });
  assert.equal(read(root, 'x.ts'), 'current\n');
});

test('failed tool calls are ignored by the planner', () => {
  const root = tmpDir();
  write(root, 'a.txt', 'same\n');
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_create', path: 'a.txt', before: null, after: 'x', isError: true })], root, false);
  assert.equal(planRewind({ root, events, eventId: events[0].id, git: null }).actions.length, 0);
});

test('outside-root changes are skipped with a warning', () => {
  const root = tmpDir();
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_create', path: '/etc/evil', outsideRoot: true, before: null, after: 'x' })], root, false);
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  assert.equal(plan.actions.length, 0);
  assert.ok(plan.warnings[0].includes('outside the project root'));
});

test('refuses to write through symlinks that leave the project', () => {
  const root = tmpDir();
  const outside = tmpDir('dashcam-outside-');
  fs.symlinkSync(outside, path.join(root, 'link'));
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_create', path: 'link/pwn.txt', before: 'original', after: 'x' })], root, false);
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  assert.throws(() => applyRewind({ root, events, eventId: events[0].id, token: plan.token, git: null }), /symlink/);
  assert.equal(fs.existsSync(path.join(outside, 'pwn.txt')), false);
});

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

test('git fallback restores files removed by rm -rf', { skip: !hasGit }, () => {
  const root = tmpDir();
  const g = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: '2025-12-31T00:00:00Z', GIT_COMMITTER_DATE: '2025-12-31T00:00:00Z' },
    });
  g('init', '-q');
  write(root, 'lib/one.ts', 'one\n');
  write(root, 'lib/two.ts', 'two\n');
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  fs.rmSync(path.join(root, 'lib'), { recursive: true });

  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'shell_cmd', command: 'rm -rf lib' }), ev({ type: 'file_delete', path: 'lib', recursive: true })], root, true);
  const del = events.find((e) => e.type === 'file_delete')!;
  assert.deepEqual(del.deletedFiles, ['lib/one.ts', 'lib/two.ts']);

  const plan = planRewind({ root, events, eventId: del.id, mode: 'before' });
  assert.deepEqual(
    plan.actions.map((a) => [a.path, a.action, a.source]),
    [
      ['lib/one.ts', 'recreate', 'git'],
      ['lib/two.ts', 'recreate', 'git'],
    ],
  );
  applyRewind({ root, events, eventId: del.id, mode: 'before', token: plan.token });
  assert.equal(read(root, 'lib/one.ts'), 'one\n');
  assert.equal(read(root, 'lib/two.ts'), 'two\n');
});
