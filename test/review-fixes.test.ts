/**
 * Regression tests for the post-merge review of PR #1:
 *  P1-1 binary files must be rewound byte-for-byte (no UTF-8 round trip)
 *  P1-2 `cd dir && rm file` must resolve `file` inside `dir`
 *  P2-3 git-history-only rewinds must include uncommitted working-tree paths
 *  P2-4 a path that git confirms is absent at the target commit must be deleted
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseClaudeSession, parseRmTargets } from '../src/parsers/claude';
import { applyRewind, planRewind, restoreBackup } from '../src/rewind';
import { buildTimeline, finalizeEvents } from '../src/timeline';
import type { TimelineEvent } from '../src/types';
import { tmpDir, toolPair } from './helpers';

const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/** Fresh git repo whose commits get deterministic, strictly increasing dates. */
function repo() {
  const root = tmpDir('dashcam-review-');
  let day = 1;
  const git = (...a: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...a], { cwd: root, stdio: 'ignore' });
  const commit = (msg: string) => {
    const date = `2025-01-${String(day++).padStart(2, '0')}T00:00:00Z`;
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'add', '-A'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', msg], {
      cwd: root,
      stdio: 'ignore',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
  };
  git('init', '-q');
  return { root, commit };
}

const put = (root: string, p: string, c: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
  fs.writeFileSync(path.join(root, p), c);
};
const get = (root: string, p: string) => (fs.existsSync(path.join(root, p)) ? fs.readFileSync(path.join(root, p)) : null);

let n = 0;
function ev(p: Partial<TimelineEvent>): TimelineEvent {
  n++;
  return { id: `r${n}`, seq: 0, ts: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(), type: 'tool_call', source: 'claude', title: `event ${n}`, risks: [], ...p };
}

// ---------------------------------------------------------------- P1-1

const BINARY = Buffer.from([0x00, 0xff, 0xfe, 0x01]);

test('P1-1: binary file restored from git is byte-identical', { skip: !hasGit }, () => {
  const { root, commit } = repo();
  put(root, 'assets/logo.bin', BINARY);
  commit('add binary');
  put(root, 'assets/logo.bin', Buffer.from([0x00, 0x00, 0x00]));

  // An agent edit whose previous content the log did not capture -> git fallback.
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_edit', path: 'assets/logo.bin' })], root, true);
  const plan = planRewind({ root, events, eventId: events[0].id });
  const a = plan.actions.find((x) => x.path === 'assets/logo.bin')!;
  assert.equal(a.action, 'restore');
  assert.equal(a.source, 'git');
  assert.equal(a.binary, true);
  assert.equal(a.diff, undefined);

  const res = applyRewind({ root, events, eventId: events[0].id, token: plan.token });
  assert.deepEqual(get(root, 'assets/logo.bin'), BINARY); // not 00 ef bf bd ef bf bd 01

  // Undo is byte-exact too.
  restoreBackup(root, res.backupId);
  assert.deepEqual(get(root, 'assets/logo.bin'), Buffer.from([0x00, 0x00, 0x00]));
});

test('P1-1: deleted binary file is recreated byte-identical from git', { skip: !hasGit }, () => {
  const { root, commit } = repo();
  put(root, 'img.png', BINARY);
  commit('add');
  fs.rmSync(path.join(root, 'img.png'));
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_delete', path: 'img.png' })], root, true);
  const plan = planRewind({ root, events, eventId: events[0].id });
  assert.equal(plan.actions[0].action, 'recreate');
  applyRewind({ root, events, eventId: events[0].id, token: plan.token });
  assert.deepEqual(get(root, 'img.png'), BINARY);
});

test('P1-1: content that cannot be reconstructed losslessly from the log is not restored', () => {
  const root = tmpDir();
  put(root, 'blob.dat', Buffer.from([0x01, 0x02]));
  // What a UTF-8 decoded binary looks like in a log: replacement characters.
  const lossy = '\u0000��\u0001';
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_edit', path: 'blob.dat', before: lossy, after: 'x' })], root, false);
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  assert.equal(plan.actions[0].action, 'skip');
  assert.match(plan.actions[0].reason, /losslessly/);
  applyRewind({ root, events, eventId: events[0].id, token: plan.token, git: null });
  assert.deepEqual(get(root, 'blob.dat'), Buffer.from([0x01, 0x02]));
});

test('P1-1: lone surrogates in log content are treated as lossy', () => {
  const root = tmpDir();
  put(root, 'a.txt', 'now');
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_edit', path: 'a.txt', before: 'bad \uD800 text', after: 'now' })], root, false);
  assert.equal(planRewind({ root, events, eventId: events[0].id, git: null }).actions[0].action, 'skip');
});

test('P1-1: text content from the log still restores exactly (incl. non-ASCII)', () => {
  const root = tmpDir();
  put(root, 'ko.txt', '변경됨\n');
  const events = finalizeEvents([ev({ type: 'checkpoint' }), ev({ type: 'file_edit', path: 'ko.txt', before: '안녕 🌙\n', after: '변경됨\n' })], root, false);
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  assert.equal(plan.actions[0].action, 'restore');
  assert.ok(plan.actions[0].diff);
  applyRewind({ root, events, eventId: events[0].id, token: plan.token, git: null });
  assert.equal(fs.readFileSync(path.join(root, 'ko.txt'), 'utf8'), '안녕 🌙\n');
});

// ---------------------------------------------------------------- P1-2

test('P1-2: rm after cd resolves inside the new directory', () => {
  assert.deepEqual(parseRmTargets('cd sub && rm a.txt'), [{ path: 'sub/a.txt', recursive: false }]);
  assert.deepEqual(parseRmTargets('cd sub; cd deeper && rm -rf build'), [{ path: 'sub/deeper/build', recursive: true }]);
  assert.deepEqual(parseRmTargets('cd sub/ && cd .. && rm x'), [{ path: 'x', recursive: false }]);
  assert.deepEqual(parseRmTargets('pushd lib && rm y'), [{ path: 'lib/y', recursive: false }]);
  assert.deepEqual(parseRmTargets('cd /srv/app && rm z'), [{ path: '/srv/app/z', recursive: false }]);
});

test('P1-2: subshell cd does not leak out of the parentheses', () => {
  assert.deepEqual(parseRmTargets('(cd sub && rm a) && rm b'), [
    { path: 'sub/a', recursive: false },
    { path: 'b', recursive: false },
  ]);
});

test('P1-2: unknown effective directory suppresses relative deletes, keeps absolute ones', () => {
  assert.deepEqual(parseRmTargets('cd "$TARGET" && rm a.txt'), []);
  assert.deepEqual(parseRmTargets('cd && rm a.txt'), []);
  assert.deepEqual(parseRmTargets('cd - && rm a.txt'), []);
  assert.deepEqual(parseRmTargets('cd $(mktemp -d) && rm a.txt && rm /tmp/abs.txt'), [{ path: '/tmp/abs.txt', recursive: false }]);
  assert.deepEqual(parseRmTargets('popd && rm q'), []);
});

test('P1-2: parser records the delete under the cd target, relative to the event cwd', () => {
  const root = '/proj';
  const evs = parseClaudeSession(toolPair('Bash', { command: 'cd sub && rm a.txt' }, '', { stdout: '' }, { cwd: '/proj' }).join('\n'), { root }).events;
  const del = evs.filter((e) => e.type === 'file_delete');
  assert.equal(del.length, 1);
  assert.equal(del[0].path, 'sub/a.txt');

  const fromSub = parseClaudeSession(toolPair('Bash', { command: 'cd .. && rm top.txt' }, '', { stdout: '' }, { cwd: '/proj/sub' }).join('\n'), { root }).events;
  assert.equal(fromSub.find((e) => e.type === 'file_delete')!.path, 'top.txt');

  const unknown = parseClaudeSession(toolPair('Bash', { command: 'cd "$X" && rm a.txt' }, '', { stdout: '' }, { cwd: '/proj' }).join('\n'), { root }).events;
  assert.equal(unknown.filter((e) => e.type === 'file_delete').length, 0);
});

test('P1-2: rewinding a `cd sub && rm a.txt` restores sub/a.txt, never the root a.txt', () => {
  const root = tmpDir();
  put(root, 'a.txt', 'root file (must stay untouched)\n');
  put(root, 'sub/.keep', '');
  const lines = [
    ...toolPair('Read', { file_path: path.join(root, 'sub/a.txt') }, 'x', { type: 'text', file: { content: 'sub file\n', startLine: 1, numLines: 1, totalLines: 1 } }, { cwd: root }),
    ...toolPair('Bash', { command: 'cd sub && rm a.txt' }, '', { stdout: '' }, { cwd: root }),
  ];
  const events = finalizeEvents(parseClaudeSession(lines.join('\n'), { root }).events, root, false);
  const plan = planRewind({ root, events, eventId: events[0].id, git: null });
  assert.deepEqual(plan.actions.map((a) => [a.path, a.action]), [['sub/a.txt', 'recreate']]);
  applyRewind({ root, events, eventId: events[0].id, token: plan.token, git: null });
  assert.equal(fs.readFileSync(path.join(root, 'sub/a.txt'), 'utf8'), 'sub file\n');
  assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'root file (must stay untouched)\n');
});

// ---------------------------------------------------------------- P2-3 / P2-4

test('P2-3: git-only rewind to a commit includes uncommitted working-tree changes', { skip: !hasGit }, () => {
  const { root, commit } = repo();
  put(root, 'f.txt', 'v1\n');
  commit('one');
  put(root, 'f.txt', 'v2\n');
  commit('two');
  put(root, 'f.txt', 'v3 uncommitted\n'); // modified, not committed
  put(root, 'g.txt', 'scratch\n'); // untracked

  const tl = buildTimeline({ root }); // no session: git history only
  const two = tl.events.find((e) => e.title.includes(': two'))!;
  assert.ok(tl.events.some((e) => e.id === 'git-worktree'));

  const plan = planRewind({ root, events: tl.events, eventId: two.id });
  const by = Object.fromEntries(plan.actions.map((a) => [a.path, a]));
  assert.equal(by['f.txt'].action, 'restore');
  assert.equal(by['f.txt'].source, 'git');
  assert.equal(by['g.txt'].action, 'delete');
  assert.ok(plan.summary.restore + plan.summary.delete > 0, 'must not report "nothing to rewind"');

  applyRewind({ root, events: tl.events, eventId: two.id, token: plan.token });
  assert.equal(get(root, 'f.txt')!.toString(), 'v2\n');
  assert.equal(get(root, 'g.txt'), null);
});

test('P2-3: rewinding to an older commit resolves against that exact commit', { skip: !hasGit }, () => {
  const { root, commit } = repo();
  put(root, 'f.txt', 'v1\n');
  commit('one');
  put(root, 'f.txt', 'v2\n');
  commit('two');
  put(root, 'f.txt', 'v3\n');
  const tl = buildTimeline({ root });
  const one = tl.events.find((e) => e.title.includes(': one'))!;
  const plan = planRewind({ root, events: tl.events, eventId: one.id });
  assert.match(plan.actions.find((a) => a.path === 'f.txt')!.reason, new RegExp(one.commit!.slice(0, 7)));
  applyRewind({ root, events: tl.events, eventId: one.id, token: plan.token });
  assert.equal(get(root, 'f.txt')!.toString(), 'v1\n');
});

test('P2-4: a file git confirms is absent at the target commit is deleted', { skip: !hasGit }, () => {
  const { root, commit } = repo();
  put(root, 'base.txt', 'base\n');
  commit('base');
  put(root, 'added.txt', 'added later\n');
  commit('add file');

  const tl = buildTimeline({ root });
  const base = tl.events.find((e) => e.title.includes(': base'))!;
  const plan = planRewind({ root, events: tl.events, eventId: base.id });
  const a = plan.actions.find((x) => x.path === 'added.txt')!;
  assert.equal(a.action, 'delete');
  assert.equal(a.source, 'git');
  assert.equal(a.targetExists, false);
  applyRewind({ root, events: tl.events, eventId: base.id, token: plan.token });
  assert.equal(get(root, 'added.txt'), null);
  assert.equal(get(root, 'base.txt')!.toString(), 'base\n');
});

test('P2-4: session flow — agent-created file unknown to the log is deleted via git', { skip: !hasGit }, () => {
  const { root, commit } = repo();
  put(root, 'keep.txt', 'k\n');
  commit('base');
  put(root, 'gen.txt', 'generated\n');
  // Edit without captured content (old log format) on a file git has never seen.
  const events = finalizeEvents([ev({ type: 'checkpoint', ts: '2026-02-01T00:00:00.000Z' }), ev({ type: 'file_edit', path: 'gen.txt', ts: '2026-02-01T00:01:00.000Z' })], root, true);
  const plan = planRewind({ root, events, eventId: events[0].id });
  assert.equal(plan.actions[0].action, 'delete');
  assert.equal(plan.actions[0].source, 'git');
});

test('P2-4: git-ignored files are never deleted just because git does not track them', { skip: !hasGit }, () => {
  const { root, commit } = repo();
  put(root, '.gitignore', '*.log\n');
  commit('base');
  put(root, 'debug.log', 'important local log\n');
  const events = finalizeEvents([ev({ type: 'checkpoint', ts: '2026-02-01T00:00:00.000Z' }), ev({ type: 'file_edit', path: 'debug.log', ts: '2026-02-01T00:01:00.000Z' })], root, true);
  const plan = planRewind({ root, events, eventId: events[0].id });
  assert.equal(plan.actions[0].action, 'skip');
  applyRewind({ root, events, eventId: events[0].id, token: plan.token });
  assert.equal(get(root, 'debug.log')!.toString(), 'important local log\n');
});
