// agent-dashcam UI — vanilla JS, no build step. All log content is rendered via text nodes (never innerHTML).
(() => {
  'use strict';
  const TOKEN = document.querySelector('meta[name="dashcam-token"]').content;
  const $ = (id) => document.getElementById(id);
  const ICONS = { file_edit: '✏️', file_create: '✨', file_delete: '🗑️', shell_cmd: '⌘', tool_call: '🔧', checkpoint: '📍' };
  const SEV = { low: 0, medium: 1, high: 2, critical: 3 };

  const state = { meta: null, session: undefined, events: [], cur: -1, playing: false, timer: null, filter: 'all', query: '' };

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === undefined || c === null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-dashcam-token': TOKEN, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
    return data;
  }

  function toast(msg, isError) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast' + (isError ? ' error' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => t.classList.add('hidden'), 4000);
  }

  const fmtTime = (ts) => {
    const d = new Date(ts);
    return isNaN(d) ? '--:--:--' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  };
  const fmtDate = (ts) => {
    const d = new Date(ts);
    return isNaN(d) ? '' : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };
  const topRisk = (ev) => ev.risks.reduce((a, r) => (!a || SEV[r.severity] > SEV[a.severity] ? r : a), null);
  const isRisky = (ev) => ev.risks.some((r) => SEV[r.severity] >= SEV.medium);

  // ---------- loading ----------
  async function init() {
    try {
      state.meta = await api('/api/meta');
    } catch (e) {
      $('detail').replaceChildren(h('div', { class: 'empty' }, 'Failed to connect to agent-dashcam: ' + e.message));
      return;
    }
    $('project').textContent = state.meta.root;
    $('project').title = state.meta.root;
    if (state.meta.demo) $('demoBadge').classList.remove('hidden');
    const sel = $('sessionSelect');
    sel.replaceChildren(
      ...state.meta.sessions.map((s) => h('option', { value: s.id }, `${s.startedAt ? fmtDate(s.startedAt) + ' · ' : ''}${s.title}`)),
      h('option', { value: 'none' }, 'Git history only'),
    );
    if (!state.meta.sessions.length) sel.value = 'none';
    state.session = sel.value;
    sel.addEventListener('change', () => {
      state.session = sel.value;
      load(true);
    });
    await load(true);
  }

  async function load(resetCursor) {
    const q = state.session ? '?session=' + encodeURIComponent(state.session) : '';
    const tl = await api('/api/timeline' + q);
    const prevId = state.events[state.cur]?.id;
    state.events = tl.events;
    const s = tl.stats;
    const fileOps = (s.byType.file_edit || 0) + (s.byType.file_create || 0) + (s.byType.file_delete || 0);
    $('stats').replaceChildren(
      h('span', { class: 'chip' }, `${s.total} events`),
      h('span', { class: 'chip' }, `${fileOps} file ops`),
      h('span', { class: 'chip' }, `${s.byType.shell_cmd || 0} commands`),
      h('span', { class: 'chip' + (s.risks ? ' red' : '') }, `⚠ ${s.risks} risks`),
    );
    if (resetCursor || state.cur < 0) {
      state.cur = state.events.length ? 0 : -1;
    } else {
      const i = state.events.findIndex((e) => e.id === prevId);
      state.cur = i >= 0 ? i : Math.min(state.cur, state.events.length - 1);
    }
    renderTrack();
    renderList();
    select(state.cur, false);
  }

  // ---------- scrubber ----------
  function pos(i) {
    const n = state.events.length;
    return n <= 1 ? 50 : (i / (n - 1)) * 100;
  }

  function renderTrack() {
    $('ticks').replaceChildren(
      ...state.events.map((ev, i) =>
        h('div', { class: `tick ${ev.type}${isRisky(ev) ? ' risk' : ''}`, style: `left:${pos(i)}%`, title: `#${i + 1} ${ev.title}` }),
      ),
    );
    const evs = state.events;
    $('tStart').textContent = evs.length ? fmtDate(evs[0].ts) : '';
    $('tEnd').textContent = evs.length ? fmtDate(evs[evs.length - 1].ts) : '';
  }

  function updateTrack() {
    $('playhead').style.left = `calc(${pos(Math.max(0, state.cur))}% - 1px)`;
    const ticks = $('ticks').children;
    for (let i = 0; i < ticks.length; i++) ticks[i].classList.toggle('past', i < state.cur);
    const ev = state.events[state.cur];
    $('clock').replaceChildren(ev ? h('b', {}, fmtTime(ev.ts)) : '--:--:--', ev ? `  ·  #${state.cur + 1} / ${state.events.length}` : '');
  }

  function scrubTo(clientX) {
    const r = $('track').getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - r.left) / r.width));
    select(Math.round(frac * (state.events.length - 1)));
  }

  let dragging = false;
  $('track').addEventListener('mousedown', (e) => {
    dragging = true;
    pause();
    scrubTo(e.clientX);
  });
  window.addEventListener('mousemove', (e) => dragging && scrubTo(e.clientX));
  window.addEventListener('mouseup', () => (dragging = false));

  // ---------- playback ----------
  function play() {
    if (!state.events.length) return;
    if (state.cur >= state.events.length - 1) select(0);
    state.playing = true;
    $('playBtn').textContent = '❚❚';
    tick();
  }
  function tick() {
    clearTimeout(state.timer);
    if (!state.playing) return;
    const speed = Number($('speed').value) || 1;
    // Linger on risky events so they are noticed.
    const delay = (isRisky(state.events[state.cur]) ? 2600 : 1200) / speed;
    state.timer = setTimeout(() => {
      if (state.cur >= state.events.length - 1) return pause();
      select(state.cur + 1);
      tick();
    }, delay);
  }
  function pause() {
    state.playing = false;
    clearTimeout(state.timer);
    $('playBtn').textContent = '▶';
  }
  $('playBtn').addEventListener('click', () => (state.playing ? pause() : play()));
  $('prevBtn').addEventListener('click', () => (pause(), select(Math.max(0, state.cur - 1))));
  $('nextBtn').addEventListener('click', () => (pause(), select(Math.min(state.events.length - 1, state.cur + 1))));
  $('nextRiskBtn').addEventListener('click', nextRisk);
  function nextRisk() {
    pause();
    const n = state.events.length;
    for (let k = 1; k <= n; k++) {
      const i = (state.cur + k) % n;
      if (isRisky(state.events[i])) return select(i);
    }
    toast('No risky events in this session 🎉');
  }

  document.addEventListener('keydown', (e) => {
    if (!$('modal').classList.contains('hidden')) {
      if (e.key === 'Escape') closeModal();
      return;
    }
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === ' ') {
      e.preventDefault();
      state.playing ? pause() : play();
    } else if (e.key === 'ArrowRight' || e.key === 'j') {
      e.preventDefault();
      pause();
      select(Math.min(state.events.length - 1, state.cur + 1));
    } else if (e.key === 'ArrowLeft' || e.key === 'k') {
      e.preventDefault();
      pause();
      select(Math.max(0, state.cur - 1));
    } else if (e.key === 'r') nextRisk();
  });

  // ---------- list ----------
  function matches(ev) {
    const f = state.filter;
    if (f === 'risk' && !ev.risks.length) return false;
    if (f === 'file' && !ev.type.startsWith('file_')) return false;
    if (f === 'shell' && ev.type !== 'shell_cmd') return false;
    if (f === 'checkpoint' && ev.type !== 'checkpoint') return false;
    if (state.query && !(ev.title + ' ' + (ev.path || '') + ' ' + (ev.command || '')).toLowerCase().includes(state.query)) return false;
    return true;
  }

  function renderList() {
    const items = [];
    state.events.forEach((ev, i) => {
      if (!matches(ev)) return;
      const r = topRisk(ev);
      items.push(
        h(
          'li',
          { class: `ev${isRisky(ev) ? ' has-risk' : ''}`, 'data-i': i, onclick: () => (pause(), select(i)) },
          h('span', { class: 'seq' }, `#${i + 1}`),
          h('span', { class: 'time' }, fmtTime(ev.ts)),
          h('span', { class: 'title' + (ev.type === 'shell_cmd' ? ' mono' : '') }, h('span', { class: 'icon' }, ICONS[ev.type] || '•'), ev.title),
          h(
            'span',
            {},
            ev.isError ? h('span', { class: 'badge err' }, 'ERR') : null,
            r ? h('span', { class: `badge risk ${r.severity}`, title: ev.risks.map((x) => x.message).join('\n') }, r.severity === 'critical' ? 'RISK!' : 'RISK') : null,
          ),
        ),
      );
    });
    $('events').replaceChildren(...(items.length ? items : [h('li', { class: 'empty' }, 'No events match.')]));
  }

  $('filters').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    state.filter = b.dataset.filter;
    [...$('filters').children].forEach((x) => x.classList.toggle('active', x === b));
    renderList();
    updateListSelection(true);
  });
  $('search').addEventListener('input', (e) => {
    state.query = e.target.value.toLowerCase();
    renderList();
    updateListSelection(false);
  });

  function updateListSelection(scroll) {
    for (const li of $('events').children) {
      const i = Number(li.dataset.i);
      li.classList.toggle('sel', i === state.cur);
      li.classList.toggle('future', i > state.cur);
      if (i === state.cur && scroll) li.scrollIntoView({ block: 'nearest' });
    }
  }

  function select(i, scroll = true) {
    if (i < 0 || i >= state.events.length) {
      updateTrack();
      return;
    }
    state.cur = i;
    updateTrack();
    updateListSelection(scroll);
    renderDetail(state.events[i]);
  }

  // ---------- detail ----------
  function renderDiff(diff) {
    if (!diff || !diff.hunks.length) return h('div', { class: 'empty' }, 'No content changes.');
    const rows = [];
    for (const hk of diff.hunks) {
      rows.push(h('div', { class: 'hunk-h' }, `@@ -${hk.oldStart} +${hk.newStart} @@`));
      for (const l of hk.lines) {
        rows.push(
          h(
            'div',
            { class: 'ln ' + l.type },
            h('span', { class: 'no' }, l.oldNo ?? ''),
            h('span', { class: 'no' }, l.newNo ?? ''),
            h('span', { class: 'sig' }, l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' '),
            h('span', {}, l.text),
          ),
        );
      }
    }
    return h('div', { class: 'code diff' }, rows);
  }

  function renderUnified(text) {
    const cls = (l) => (l.startsWith('+') && !l.startsWith('+++') ? 'u-add' : l.startsWith('-') && !l.startsWith('---') ? 'u-del' : l.startsWith('@@') ? 'u-hunk' : '');
    return h('pre', {}, text.split('\n').map((l) => h('span', { class: cls(l) }, l + '\n')));
  }

  function renderDetail(ev) {
    const sev = topRisk(ev);
    const body = [
      h(
        'div',
        { class: 'd-head' },
        h(
          'div',
          {},
          h('h1', { class: 'd-title' }, `${ICONS[ev.type] || ''} ${ev.title}`),
          h(
            'div',
            { class: 'd-meta' },
            h('span', { class: 'badge type' }, ev.type),
            ev.tool ? h('span', { class: 'badge type' }, ev.tool) : null,
            h('span', {}, `#${ev.seq + 1}`),
            h('span', {}, new Date(ev.ts).toLocaleString()),
            h('span', {}, `source: ${ev.source}`),
            ev.isError ? h('span', { class: 'badge err' }, 'TOOL ERROR') : null,
            sev ? h('span', { class: `badge risk ${sev.severity}` }, `RISK · ${sev.severity.toUpperCase()}`) : null,
          ),
        ),
        h(
          'div',
          { class: 'd-actions' },
          isRisky(ev) ? h('button', { class: 'rewind-before', onclick: () => openRewind(ev, 'before'), title: 'Restore files to the state right before this event' }, '⏪ Rewind to just before') : null,
          h('button', { class: 'rewind-btn', onclick: () => openRewind(ev, 'after'), title: 'Restore files to the state right after this event' }, '⏪ Rewind to here'),
        ),
      ),
    ];
    if (ev.risks.length) {
      body.push(
        h(
          'div',
          { class: 'risks' },
          h('h4', {}, '⚠ INCIDENT DETECTED'),
          h('ul', {}, ev.risks.map((r) => h('li', {}, h('b', {}, `[${r.severity}] `), r.message, h('span', { class: 'kbd' }, r.rule)))),
        ),
      );
    }
    if (ev.reasoning) body.push(h('div', { class: 'reasoning' }, `Agent: “${ev.reasoning}”`));

    if (ev.type === 'shell_cmd') {
      body.push(h('div', { class: 'section-title' }, 'Command'), h('pre', { class: 'cmd' }, ev.command || ''));
      body.push(h('div', { class: 'section-title' }, ev.isError ? 'Output (failed)' : 'Output'), h('pre', { class: 'out' + (ev.isError ? ' err' : '') }, ev.output || '(no output)'));
    } else if (ev.type === 'file_edit' || ev.type === 'file_create') {
      body.push(h('div', { class: 'section-title' }, ev.diff ? `Diff · +${ev.diff.added} −${ev.diff.removed}` : 'Change'));
      if (ev.diff) body.push(renderDiff(ev.diff));
      else if (ev.snippet) body.push(h('div', { class: 'section-title' }, 'Replaced'), h('pre', { class: 'out err' }, ev.snippet.old), h('div', { class: 'section-title' }, 'With'), h('pre', {}, ev.snippet.new));
      else if (typeof ev.after === 'string') body.push(h('pre', {}, ev.after));
      else body.push(h('div', { class: 'empty' }, 'Content not captured in the log.'));
      if (ev.output) body.push(h('div', { class: 'section-title' }, 'Tool output'), h('pre', { class: 'out err' }, ev.output));
    } else if (ev.type === 'file_delete') {
      if (ev.command) body.push(h('div', { class: 'section-title' }, 'Triggered by'), h('pre', { class: 'cmd' }, ev.command));
      const files = ev.deletedFiles && ev.deletedFiles.length ? ev.deletedFiles : [ev.path];
      body.push(h('div', { class: 'section-title' }, `Removed (${files.length})`), h('ul', { class: 'filelist' }, files.map((f) => h('li', {}, f))));
    } else if (ev.type === 'checkpoint') {
      if (ev.files && ev.files.length) body.push(h('div', { class: 'section-title' }, `Files (${ev.files.length})`), h('ul', { class: 'filelist' }, ev.files.map((f) => h('li', {}, `${f.status}  ${f.path}`))));
      if (ev.diffText) body.push(h('div', { class: 'section-title' }, 'Diff vs HEAD'), renderUnified(ev.diffText));
      else if (ev.output && !ev.files) body.push(h('div', { class: 'section-title' }, ev.source === 'claude' ? 'Prompt' : 'Details'), h('pre', { style: 'white-space:pre-wrap' }, ev.output));
    } else {
      if (ev.input) body.push(h('div', { class: 'section-title' }, 'Input'), h('pre', {}, JSON.stringify(ev.input, null, 2)));
      if (ev.output) body.push(h('div', { class: 'section-title' }, 'Result'), h('pre', { class: ev.isError ? 'out err' : '' }, ev.output));
    }
    $('detail').replaceChildren(...body);
    $('detail').scrollTop = 0;
  }

  // ---------- rewind ----------
  function closeModal() {
    $('modal').classList.add('hidden');
  }
  $('modalClose').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => e.target === $('modal') && closeModal());

  function actionRow(a) {
    const diff = a.diff
      ? renderDiff(a.diff)
      : h('div', { class: 'empty' }, a.binary ? 'Binary file' : a.action === 'skip' ? 'Will be left untouched.' : 'No content changes.');
    const small = (a.diff?.added || 0) + (a.diff?.removed || 0) < 80;
    return h(
      'details',
      { class: 'act', open: a.action !== 'skip' && small ? true : undefined },
      h(
        'summary',
        {},
        h('span', { class: `tag ${a.action}` }, a.action),
        h('span', { class: 'path' }, a.path),
        a.diff ? h('span', { class: 'chip' }, `+${a.diff.added} −${a.diff.removed}`) : null,
        h('span', { class: 'why' }, `${a.reason}${a.source !== 'none' ? ` · ${a.source}` : ''}`),
      ),
      diff,
    );
  }

  async function openRewind(ev, mode) {
    pause();
    $('modalTitle').textContent = `Dry-run: rewind ${mode === 'before' ? 'to just before' : 'to'} #${ev.seq + 1}`;
    $('modalBody').replaceChildren(h('div', { class: 'empty' }, 'Computing rewind plan…'));
    $('modalFoot').replaceChildren();
    $('modal').classList.remove('hidden');
    let plan;
    try {
      plan = await api('/api/rewind/preview', { session: state.session, eventId: ev.id, mode });
    } catch (e) {
      $('modalBody').replaceChildren(h('div', { class: 'warn' }, 'Preview failed: ' + e.message));
      return;
    }
    const s = plan.summary;
    const changes = s.restore + s.delete + s.recreate;
    const unchanged = plan.actions.filter((a) => a.action === 'unchanged');
    $('modalBody').replaceChildren(
      h('p', {}, 'Target: ', h('b', {}, plan.targetTitle), '. Nothing has been changed yet — this is a dry run.'),
      h(
        'div',
        { class: 'plan-summary' },
        h('span', { class: 'chip' }, `${s.restore} restore`),
        h('span', { class: 'chip' }, `${s.recreate} recreate`),
        h('span', { class: 'chip' + (s.delete ? ' red' : '') }, `${s.delete} delete`),
        h('span', { class: 'chip' }, `${s.unchanged} unchanged`),
        s.skip ? h('span', { class: 'chip' }, `${s.skip} skipped`) : null,
      ),
      ...plan.warnings.map((w) => h('div', { class: 'warn' }, '⚠ ' + w)),
      ...plan.actions.filter((a) => a.action !== 'unchanged').map(actionRow),
      unchanged.length ? h('details', {}, h('summary', { class: 'section-title' }, `${unchanged.length} file(s) already match`), h('ul', { class: 'filelist' }, unchanged.map((a) => h('li', {}, a.path)))) : null,
      plan.actions.length ? null : h('div', { class: 'empty' }, 'No file changes after this point — nothing to rewind.'),
    );

    const confirmBtn = h('button', { class: 'danger', disabled: changes === 0 ? true : undefined }, `⏪ Rewind ${changes} file(s)`);
    confirmBtn.addEventListener('click', async () => {
      confirmBtn.disabled = true;
      confirmBtn.textContent = 'Rewinding…';
      try {
        const r = await api('/api/rewind/apply', { session: state.session, eventId: ev.id, mode, token: plan.token });
        showResult(r);
        await load(false);
      } catch (e) {
        if (e.status === 409) {
          toast('Files changed since the preview — showing a fresh preview.', true);
          openRewind(ev, mode);
        } else {
          toast('Rewind failed: ' + e.message, true);
          confirmBtn.disabled = false;
        }
      }
    });
    $('modalFoot').replaceChildren(
      h('span', { class: 'note' }, 'Every touched file is backed up to .agent-dashcam/backups — you can undo.'),
      h('button', { onclick: closeModal }, 'Cancel'),
      confirmBtn,
    );
  }

  function showResult(r) {
    $('modalTitle').textContent = 'Rewind complete';
    $('modalBody').replaceChildren(
      h('p', { class: 'success' }, `✔ ${r.changed.length} file(s) rewound to "${r.plan.targetTitle}".`),
      h('ul', { class: 'filelist' }, r.changed.map((c) => h('li', {}, `${c.action.padEnd(9)} ${c.path}`))),
      h('p', { class: 'note' }, `Backup: ${r.backupId}`),
    );
    const undo = h('button', { class: 'rewind-before' }, '↩ Undo this rewind');
    undo.addEventListener('click', async () => {
      undo.disabled = true;
      try {
        const u = await api('/api/undo', { backupId: r.backupId });
        toast(`Undo complete: ${u.changed.length} file(s) restored.`);
        closeModal();
        await load(false);
      } catch (e) {
        toast('Undo failed: ' + e.message, true);
        undo.disabled = false;
      }
    });
    $('modalFoot').replaceChildren(undo, h('button', { class: 'rewind-btn', onclick: closeModal }, 'Done'));
    toast('Rewind complete ⏪');
  }

  init();
})();
