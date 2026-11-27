import * as path from 'node:path';
import { normalizePath } from '../paths';
import { stripHeredocs } from '../shell';
import type { TimelineEvent } from '../types';

/**
 * Parser for Claude Code session transcripts (~/.claude/projects/<project>/<session>.jsonl).
 *
 * Each line is a JSON record. We care about:
 *  - `type: "user"` records whose content is a plain prompt        -> checkpoint
 *  - `type: "assistant"` records containing `tool_use` blocks      -> file/shell/tool events
 *  - `type: "user"` records containing `tool_result` blocks        -> outputs, plus the
 *    sibling `toolUseResult` object which carries rich data (originalFile, stdout, ...).
 */

interface PendingTool {
  event: TimelineEvent;
  /** Additional events derived from the same tool use (e.g. file_delete from `rm`). */
  extra: TimelineEvent[];
  name: string;
  input: Record<string, any>;
}

export interface ParseOptions {
  root: string;
  sessionId?: string;
}

export interface ParsedSession {
  events: TimelineEvent[];
  title: string;
  startedAt?: string;
  endedAt?: string;
  cwd?: string;
  /** Number of lines that failed to parse. */
  badLines: number;
}

const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && 'text' in c ? String((c as any).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

function applyEdit(content: string, oldStr: string, newStr: string, replaceAll?: boolean): string | undefined {
  if (oldStr === '') return newStr + content;
  if (!content.includes(oldStr)) return undefined;
  return replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, () => newStr);
}

export interface RmTarget {
  /** Absolute, `~/`-relative, or relative to the cwd the command started in. */
  path: string;
  recursive: boolean;
}

const UNRESOLVABLE = /[*?$`{}[\]>~]/;

/**
 * Apply a `cd`/`pushd` to the tracked directory. Directories are relative to the command's
 * starting cwd ('' = unchanged); `null` means the effective directory can no longer be known.
 */
function changeDir(dir: string | null, args: string[]): string | null {
  const target = args.find((a) => !/^-[LPe@]+$/.test(a));
  if (target === undefined || target === '-') return null; // `cd` (home) / `cd -` (previous dir)
  const quotedSingle = /^'.*'$/.test(target);
  const t = target.replace(/^["']|["']$/g, '');
  if (!quotedSingle && UNRESOLVABLE.test(t)) return null; // $VAR, $(cmd), globs, ~
  if (t === '') return null;
  let next: string;
  if (path.posix.isAbsolute(t)) next = path.posix.normalize(t);
  else if (dir === null) return null;
  else next = path.posix.join(dir || '.', t);
  next = next.replace(/\/+$/, '');
  return next === '.' ? '' : next || '/';
}

/**
 * Extract the targets of `rm` invocations in a shell command, resolving relative operands
 * against directory changes made earlier in the same command (`cd sub && rm a.txt` -> sub/a.txt).
 * Relative operands are dropped when the effective directory cannot be determined.
 */
export function parseRmTargets(command: string): RmTarget[] {
  const out: RmTarget[] = [];
  let dir: string | null = '';
  const subshells: (string | null)[] = [];
  let substDepth = 0; // open $( … ) / <( … ) command substitutions

  for (const seg of stripHeredocs(command).split(/&&|\|\||;|\||\n/)) {
    const insideSubst = substDepth > 0;
    const tokens: string[] = [];
    let closes = 0;
    for (let tok of seg.trim().match(/"[^"]*"|'[^']*'|\S+/g) ?? []) {
      if (!/^["']/.test(tok)) {
        while (tok.startsWith('(')) {
          subshells.push(dir); // a subshell's cd does not leak out of it
          tok = tok.slice(1);
        }
        substDepth += (tok.match(/[$<>]\(/g) ?? []).length;
        let tokenCloses = 0;
        for (const ch of tok) {
          if (ch !== ')') continue;
          if (substDepth > 0) substDepth--;
          else tokenCloses++;
        }
        if (tokenCloses) tok = tok.replace(new RegExp(`\\){1,${tokenCloses}}$`), '');
        closes += tokenCloses;
      }
      if (tok) tokens.push(tok);
    }

    if (!insideSubst) {
      let i = 0;
      while (i < tokens.length && /^(sudo|command|builtin|\w+=\S*)$/.test(tokens[i])) i++;
      const cmd = tokens[i];
      const args = tokens.slice(i + 1);
      if (cmd === 'cd' || cmd === 'pushd') dir = changeDir(dir, args);
      else if (cmd === 'popd') dir = null;
      else if (cmd === 'rm') {
        let recursive = false;
        let endOfFlags = false;
        const operands: string[] = [];
        for (const raw of args) {
          if (!endOfFlags && raw === '--') {
            endOfFlags = true;
            continue;
          }
          if (!endOfFlags && raw.startsWith('-')) {
            if (/^-[a-zA-Z]*[rR]/.test(raw) || raw === '--recursive') recursive = true;
            continue;
          }
          const t = raw.replace(/^["']|["']$/g, '');
          if (t === '' || /[*?$`{}[\]>]/.test(t)) continue; // globs / expansions cannot be resolved statically
          operands.push(t.replace(/\/+$/, '') || '/');
        }
        for (const t of operands) {
          if (t.startsWith('/') || t.startsWith('~/')) out.push({ path: t, recursive });
          else if (dir !== null) out.push({ path: dir ? path.posix.join(dir, t) : t, recursive });
          // else: relative operand in an unknown directory — do not guess
        }
      }
    }
    for (let c = 0; c < closes && subshells.length; c++) dir = subshells.pop()!;
  }
  return out;
}

export function parseClaudeSession(text: string, opts: ParseOptions): ParsedSession {
  const events: TimelineEvent[] = [];
  const pending = new Map<string, PendingTool>();
  let title = '';
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  let cwd: string | undefined;
  let badLines = 0;
  let counter = 0;
  const sid = opts.sessionId ?? 'session';
  const nextId = () => `${sid.slice(0, 8)}-${++counter}`;

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      badLines++;
      continue;
    }
    if (!rec || typeof rec !== 'object') continue;
    const ts: string | undefined = rec.timestamp;
    if (ts) {
      if (!startedAt || ts < startedAt) startedAt = ts;
      if (!endedAt || ts > endedAt) endedAt = ts;
    }
    if (rec.cwd && !cwd) cwd = rec.cwd;
    const recCwd: string = rec.cwd ?? cwd ?? opts.root;
    const msg = rec.message;
    if (!msg) continue;

    if (rec.type === 'user') {
      const content = msg.content;
      const toolResults = Array.isArray(content) ? content.filter((c: any) => c?.type === 'tool_result') : [];
      if (toolResults.length === 0) {
        const prompt = textOf(content);
        if (!prompt.trim() || rec.isMeta || /^<(command-|local-command|system-reminder)/.test(prompt.trim())) continue;
        if (!title) title = truncate(prompt, 90);
        events.push({
          id: nextId(),
          seq: 0,
          ts: ts ?? new Date(0).toISOString(),
          type: 'checkpoint',
          source: 'claude',
          title: `User prompt: ${truncate(prompt, 80)}`,
          output: prompt,
          risks: [],
        });
        continue;
      }
      for (const tr of toolResults) {
        const p = pending.get(tr.tool_use_id);
        if (!p) continue;
        pending.delete(tr.tool_use_id);
        completeTool(p, tr, rec.toolUseResult);
      }
      continue;
    }

    if (rec.type === 'assistant' && Array.isArray(msg.content)) {
      let reasoning = '';
      for (const block of msg.content) {
        if (block?.type === 'text' && block.text) {
          reasoning = String(block.text);
          continue;
        }
        if (block?.type !== 'tool_use') continue;
        const input: Record<string, any> = block.input ?? {};
        const name: string = block.name ?? 'tool';
        const ev = startTool(name, input, ts ?? new Date(0).toISOString(), opts.root, recCwd, nextId);
        if (reasoning) ev.event.reasoning = truncate(reasoning, 400);
        reasoning = '';
        events.push(ev.event, ...ev.extra);
        pending.set(block.id, { ...ev, name, input });
      }
    }
  }
  return { events, title: title || 'Untitled session', startedAt, endedAt, cwd, badLines };
}

function startTool(
  name: string,
  input: Record<string, any>,
  ts: string,
  root: string,
  cwd: string,
  nextId: () => string,
): { event: TimelineEvent; extra: TimelineEvent[] } {
  const base = { id: nextId(), seq: 0, ts, source: 'claude' as const, tool: name, risks: [] };
  const extra: TimelineEvent[] = [];
  const filePath: string | undefined = input.file_path ?? input.notebook_path ?? input.path;

  if (name === 'Bash') {
    const command = String(input.command ?? '');
    for (const t of parseRmTargets(command)) {
      const np = normalizePath(t.path, root, cwd);
      extra.push({
        id: nextId(),
        seq: 0,
        ts,
        source: 'claude',
        tool: 'Bash',
        type: 'file_delete',
        title: `Delete ${np.path}${t.recursive ? ' (recursive)' : ''}`,
        path: np.path,
        outsideRoot: np.outsideRoot,
        recursive: t.recursive,
        before: undefined,
        after: null,
        command,
        risks: [],
      });
    }
    return {
      event: {
        ...base,
        type: 'shell_cmd',
        title: `$ ${truncate(command, 100)}`,
        command,
        input: input.description ? { description: input.description } : undefined,
      },
      extra,
    };
  }

  if (FILE_WRITE_TOOLS.has(name) && filePath) {
    const np = normalizePath(filePath, root, cwd);
    const ev: TimelineEvent = {
      ...base,
      type: name === 'Write' ? 'file_create' : 'file_edit',
      title: `${name === 'Write' ? 'Write' : 'Edit'} ${np.path}`,
      path: np.path,
      outsideRoot: np.outsideRoot,
    };
    if (name === 'Write') {
      ev.after = typeof input.content === 'string' ? input.content : undefined;
    } else if (name === 'Edit') {
      ev.snippet = { old: String(input.old_string ?? ''), new: String(input.new_string ?? '') };
    } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      ev.snippet = {
        old: input.edits.map((e: any) => e.old_string).join('\n…\n'),
        new: input.edits.map((e: any) => e.new_string).join('\n…\n'),
      };
    }
    return { event: ev, extra };
  }

  const label = filePath ? normalizePath(filePath, root, cwd) : undefined;
  const hint = label?.path ?? input.pattern ?? input.url ?? input.query ?? input.description ?? '';
  return {
    event: {
      ...base,
      type: 'tool_call',
      title: `${name}${hint ? ' ' + truncate(String(hint), 90) : ''}`,
      path: label?.path,
      outsideRoot: label?.outsideRoot,
      input,
    },
    extra,
  };
}

function completeTool(p: PendingTool, tr: any, rich: any): void {
  const ev = p.event;
  const isError = Boolean(tr.is_error);
  ev.isError = isError || undefined;
  const resultText = textOf(tr.content);
  const r = rich && typeof rich === 'object' ? rich : undefined;

  if (p.name === 'Bash') {
    const stdout = r?.stdout ?? '';
    const stderr = r?.stderr ?? '';
    ev.output = r ? [stdout, stderr].filter(Boolean).join('\n') || resultText : resultText;
    if (isError) {
      // A failed command most likely did not delete anything.
      for (const x of p.extra) {
        x.title += ' (command failed)';
        x.isError = true;
      }
    }
    return;
  }

  if (ev.type === 'file_create' || ev.type === 'file_edit') {
    if (isError) {
      ev.output = resultText;
      ev.title += ' (failed)';
      ev.before = undefined;
      ev.after = undefined;
      return;
    }
    const original: unknown = r?.originalFile ?? r?.originalFileContents;
    if (p.name === 'Write') {
      if (typeof original === 'string') {
        ev.before = original;
        ev.type = 'file_edit';
        ev.title = `Overwrite ${ev.path}`;
      } else if (r?.type === 'create') {
        ev.before = null;
      } else if (r?.type === 'update') {
        ev.type = 'file_edit';
        ev.title = `Overwrite ${ev.path}`;
      } else {
        ev.before = null; // Write without history: treat as creation
      }
      if (typeof r?.content === 'string') ev.after = r.content;
      return;
    }
    if (typeof original === 'string') {
      ev.before = original;
      let after: string | undefined = original;
      const edits: any[] =
        p.name === 'MultiEdit'
          ? (p.input.edits ?? [])
          : [{ old_string: p.input.old_string, new_string: p.input.new_string, replace_all: p.input.replace_all }];
      for (const e of edits) {
        if (after === undefined) break;
        after = applyEdit(after, String(e.old_string ?? ''), String(e.new_string ?? ''), e.replace_all);
      }
      ev.after = after;
    }
    return;
  }

  // Generic tool call. A full Read gives us a snapshot of the file at that moment.
  if (p.name === 'Read' && r?.file && typeof r.file.content === 'string') {
    const f = r.file;
    const full =
      (f.startLine ?? 1) === 1 && (f.totalLines === undefined || f.numLines === undefined || f.numLines >= f.totalLines);
    if (full && ev.path) {
      ev.before = f.content;
      ev.after = f.content;
    }
    ev.output = f.content;
    return;
  }
  ev.output = resultText;
}
