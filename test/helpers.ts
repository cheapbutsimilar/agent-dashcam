import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export function tmpDir(prefix = 'dashcam-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

let n = 0;
/** Build Claude Code JSONL lines for a tool use + its result. */
export function toolPair(
  name: string,
  input: object,
  result: string,
  rich?: object,
  opts: { ts?: string; isError?: boolean; cwd?: string; text?: string } = {},
): string[] {
  const id = `toolu_${++n}`;
  const ts = opts.ts ?? new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();
  return [
    JSON.stringify({
      type: 'assistant',
      timestamp: ts,
      cwd: opts.cwd,
      message: { role: 'assistant', content: [...(opts.text ? [{ type: 'text', text: opts.text }] : []), { type: 'tool_use', id, name, input }] },
    }),
    JSON.stringify({
      type: 'user',
      timestamp: ts,
      cwd: opts.cwd,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: opts.isError ?? false }] },
      toolUseResult: rich,
    }),
  ];
}

export function userPrompt(text: string, ts = '2026-01-01T00:00:00.000Z', cwd?: string): string {
  return JSON.stringify({ type: 'user', timestamp: ts, cwd, message: { role: 'user', content: text } });
}
