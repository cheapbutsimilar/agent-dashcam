import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeSession, parseRmTargets } from '../src/parsers/claude';
import { toolPair, userPrompt } from './helpers';

const root = '/proj';

test('user prompt becomes a checkpoint and the session title', () => {
  const s = parseClaudeSession(userPrompt('Fix the login bug', undefined, root), { root });
  assert.equal(s.events.length, 1);
  assert.equal(s.events[0].type, 'checkpoint');
  assert.equal(s.title, 'Fix the login bug');
});

test('meta / slash-command records are not treated as prompts', () => {
  const lines = [
    JSON.stringify({ type: 'user', isMeta: true, timestamp: 't', message: { role: 'user', content: 'Caveat: ...' } }),
    JSON.stringify({ type: 'user', timestamp: 't', message: { role: 'user', content: '<command-name>/clear</command-name>' } }),
  ];
  assert.equal(parseClaudeSession(lines.join('\n'), { root }).events.length, 0);
});

test('Edit with originalFile yields before/after content and reasoning', () => {
  const lines = toolPair('Edit', { file_path: '/proj/src/a.ts', old_string: 'foo', new_string: 'bar' }, 'ok', { originalFile: 'const foo = 1;\n' }, { cwd: root, text: 'Renaming foo.' });
  const [ev] = parseClaudeSession(lines.join('\n'), { root }).events;
  assert.equal(ev.type, 'file_edit');
  assert.equal(ev.path, 'src/a.ts');
  assert.equal(ev.before, 'const foo = 1;\n');
  assert.equal(ev.after, 'const bar = 1;\n');
  assert.equal(ev.reasoning, 'Renaming foo.');
});

test('MultiEdit applies all edits and honours replace_all', () => {
  const lines = toolPair(
    'MultiEdit',
    { file_path: 'b.txt', edits: [{ old_string: 'a', new_string: 'x', replace_all: true }, { old_string: 'c', new_string: 'z' }] },
    'ok',
    { originalFileContents: 'a b a c c' },
    { cwd: root },
  );
  const [ev] = parseClaudeSession(lines.join('\n'), { root }).events;
  assert.equal(ev.after, 'x b x z c');
});

test('Edit without originalFile keeps a snippet and unknown content', () => {
  const lines = toolPair('Edit', { file_path: '/proj/a.ts', old_string: 'x', new_string: 'y' }, 'ok', undefined, { cwd: root });
  const [ev] = parseClaudeSession(lines.join('\n'), { root }).events;
  assert.equal(ev.before, undefined);
  assert.equal(ev.after, undefined);
  assert.deepEqual(ev.snippet, { old: 'x', new: 'y' });
});

test('Write: create vs update', () => {
  const create = toolPair('Write', { file_path: '/proj/new.ts', content: 'hi' }, 'ok', { type: 'create', content: 'hi' }, { cwd: root });
  const update = toolPair('Write', { file_path: '/proj/old.ts', content: 'v2' }, 'ok', { type: 'update', content: 'v2', originalFile: 'v1' }, { cwd: root });
  const [c, u] = parseClaudeSession([...create, ...update].join('\n'), { root }).events;
  assert.equal(c.type, 'file_create');
  assert.equal(c.before, null);
  assert.equal(c.after, 'hi');
  assert.equal(u.type, 'file_edit');
  assert.equal(u.before, 'v1');
  assert.equal(u.after, 'v2');
});

test('failed Edit carries no content', () => {
  const lines = toolPair('Edit', { file_path: '/proj/a.ts', old_string: 'x', new_string: 'y' }, 'String not found', undefined, { cwd: root, isError: true });
  const [ev] = parseClaudeSession(lines.join('\n'), { root }).events;
  assert.equal(ev.isError, true);
  assert.equal(ev.after, undefined);
});

test('Bash becomes shell_cmd with output; rm targets become file_delete events', () => {
  const lines = toolPair('Bash', { command: 'rm -rf build && rm old.txt' }, '', { stdout: 'done', stderr: '' }, { cwd: root });
  const evs = parseClaudeSession(lines.join('\n'), { root }).events;
  assert.deepEqual(evs.map((e) => e.type), ['shell_cmd', 'file_delete', 'file_delete']);
  assert.equal(evs[0].output, 'done');
  assert.equal(evs[1].path, 'build');
  assert.equal(evs[1].recursive, true);
  assert.equal(evs[2].path, 'old.txt');
  assert.equal(evs[2].recursive, false);
});

test('deletes from a failed command are marked as errors', () => {
  const lines = toolPair('Bash', { command: 'rm missing.txt' }, 'No such file', { stdout: '', stderr: 'No such file' }, { cwd: root, isError: true });
  const evs = parseClaudeSession(lines.join('\n'), { root }).events;
  assert.equal(evs[1].isError, true);
});

test('a full Read is recorded as a snapshot, a partial Read is not', () => {
  const full = toolPair('Read', { file_path: '/proj/a.ts' }, '1→x', { type: 'text', file: { content: 'x\n', startLine: 1, numLines: 1, totalLines: 1 } }, { cwd: root });
  const part = toolPair('Read', { file_path: '/proj/b.ts', offset: 10 }, '...', { type: 'text', file: { content: 'y', startLine: 10, numLines: 5, totalLines: 100 } }, { cwd: root });
  const [a, b] = parseClaudeSession([...full, ...part].join('\n'), { root }).events;
  assert.equal(a.type, 'tool_call');
  assert.equal(a.after, 'x\n');
  assert.equal(b.after, undefined);
});

test('paths outside the root are flagged as such', () => {
  const lines = toolPair('Write', { file_path: '/etc/hosts', content: 'x' }, 'ok', { type: 'create' }, { cwd: root });
  const [ev] = parseClaudeSession(lines.join('\n'), { root }).events;
  assert.equal(ev.outsideRoot, true);
  assert.equal(ev.path, '/etc/hosts');
});

test('tolerates malformed lines', () => {
  const s = parseClaudeSession('not json\n{"type":"user"}\n' + userPrompt('hi'), { root });
  assert.equal(s.badLines, 1);
  assert.equal(s.events.length, 1);
});

test('parseRmTargets handles flags, sudo, quotes and skips globs', () => {
  assert.deepEqual(parseRmTargets('sudo rm -r -f "my dir/" ; rm *.log; rm -- -weird'), [
    { path: 'my dir', recursive: true },
    { path: '-weird', recursive: false },
  ]);
  assert.deepEqual(parseRmTargets('echo rm -rf /'), []);
});

test('rm inside a heredoc body is not a deletion', () => {
  assert.deepEqual(parseRmTargets("cat > t.sh <<'EOF'\nrm -rf /tmp/x\nEOF"), []);
});
