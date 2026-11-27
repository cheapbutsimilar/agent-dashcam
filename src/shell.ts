/**
 * Remove heredoc bodies from a shell command so that file contents written with
 * `cat > f <<'EOF' ... EOF` are not mistaken for commands that were executed.
 */
export function stripHeredocs(command: string): string {
  const lines = command.split('\n');
  const out: string[] = [];
  const pending: { delim: string; tabs: boolean }[] = [];
  for (const line of lines) {
    if (pending.length) {
      const cur = pending[0];
      const cmp = cur.tabs ? line.replace(/^\t+/, '') : line;
      if (cmp.trim() === cur.delim) pending.shift();
      continue;
    }
    out.push(line);
    const re = /<<(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(line))) pending.push({ delim: m[3], tabs: m[1] === '-' });
  }
  return out.join('\n');
}
