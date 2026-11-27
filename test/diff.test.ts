import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffFiles, diffLines, toUnified } from '../src/diff';

test('identical content has no hunks', () => {
  assert.equal(diffFiles('a\nb\n', 'a\nb\n').hunks.length, 0);
});

test('counts additions and removals', () => {
  const d = diffFiles('a\nb\nc\n', 'a\nB\nc\nd\n');
  assert.equal(d.added, 2);
  assert.equal(d.removed, 1);
});

test('creation and deletion of a whole file', () => {
  assert.equal(diffFiles(null, 'x\ny\n').added, 2);
  assert.equal(diffFiles('x\ny\n', null).removed, 2);
});

test('removals are listed before additions and line numbers are tracked', () => {
  const lines = diffLines('a\nb\nc', 'a\nB\nc');
  assert.deepEqual(lines.map((l) => l.type), ['ctx', 'del', 'add', 'ctx']);
  assert.equal(lines[1].oldNo, 2);
  assert.equal(lines[2].newNo, 2);
});

test('far-apart changes produce separate hunks; unified output', () => {
  const a = Array.from({ length: 30 }, (_, i) => `l${i}`).join('\n');
  const b = a.replace('l2\n', 'X\n').replace('l27', 'Y');
  const d = diffFiles(a, b);
  assert.equal(d.hunks.length, 2);
  const u = toUnified(d, 'f.txt');
  assert.match(u, /^--- a\/f\.txt/);
  assert.match(u, /\n-l2\n\+X\n/);
});
