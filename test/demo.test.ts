import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from '../src/cli';
import { createDemo } from '../src/demo';
import { applyRewind, planRewind, restoreBackup } from '../src/rewind';
import { createServer } from '../src/server';
import { buildTimeline } from '../src/timeline';
import { tmpDir } from './helpers';

test('demo end-to-end: parse → detect → rewind before rm -rf → undo', () => {
  const demo = createDemo(tmpDir());
  const tl = buildTimeline({ root: demo.root, sessionFile: demo.sessionFile });
  const types = new Set<string>(tl.events.map((e) => e.type));
  for (const t of ['file_edit', 'file_create', 'file_delete', 'shell_cmd', 'tool_call', 'checkpoint']) assert.ok(types.has(t), t);

  const rules = new Set(tl.events.flatMap((e) => e.risks.map((r) => r.rule)));
  for (const r of ['rm-rf', 'pipe-to-shell', 'chmod-777', 'sensitive-file', 'hardcoded-secret', 'mass-delete', 'git-force-push']) assert.ok(rules.has(r), r);

  const rm = tl.events.find((e) => e.type === 'shell_cmd' && e.command === 'rm -rf src/legacy')!;
  const legacy = path.join(demo.root, 'src/legacy/billing-hooks.ts');
  assert.equal(fs.existsSync(legacy), false);

  const plan = planRewind({ root: demo.root, events: tl.events, eventId: rm.id, mode: 'before' });
  assert.ok(plan.summary.recreate >= 6, JSON.stringify(plan.summary));
  const res = applyRewind({ root: demo.root, events: tl.events, eventId: rm.id, mode: 'before', token: plan.token });
  assert.equal(fs.existsSync(legacy), true);
  assert.match(fs.readFileSync(path.join(demo.root, '.env'), 'utf8'), /JWT_SECRET/);
  assert.match(fs.readFileSync(path.join(demo.root, 'src/index.ts'), 'utf8'), /sessionStore/);

  restoreBackup(demo.root, res.backupId);
  assert.equal(fs.existsSync(legacy), false);
});

test('server: token-protected API serves the timeline and previews', async () => {
  const demo = createDemo(tmpDir());
  const srv = await createServer({ root: demo.root, sessionFiles: [demo.sessionFile], demo: true, port: 0 });
  try {
    const html = await (await fetch(srv.url + '/')).text();
    assert.ok(html.includes(srv.token));
    assert.equal((await fetch(srv.url + '/api/meta')).status, 401);
    const headers = { 'x-dashcam-token': srv.token, 'content-type': 'application/json' };
    const tl = await (await fetch(srv.url + '/api/timeline', { headers })).json();
    assert.ok(tl.events.length > 20);
    assert.ok(tl.events.some((e: any) => e.diff));
    const first = tl.events[0];
    const res = await fetch(srv.url + '/api/rewind/preview', { method: 'POST', headers, body: JSON.stringify({ eventId: first.id }) });
    assert.equal(res.status, 200);
    assert.ok((await res.json()).token);
    const bad = await fetch(srv.url + '/api/rewind/apply', { method: 'POST', headers, body: JSON.stringify({ eventId: first.id, token: 'stale' }) });
    assert.equal(bad.status, 409);
  } finally {
    await srv.close();
  }
});

test('cli argument parsing', () => {
  const a = parseArgs(['--demo', '--no-open', '--port', '5000']);
  assert.ok(typeof a === 'object' && a.demo && !a.open && a.port === 5000);
  assert.equal(parseArgs(['--help']), 'help');
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
});
