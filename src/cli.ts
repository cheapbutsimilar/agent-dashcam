#!/usr/bin/env node
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverSessions } from './collectors/discover';
import { createDemo } from './demo';
import { createServer } from './server';
import { buildTimeline } from './timeline';
import { VERSION } from './version';

const HELP = `agent-dashcam — replay what your coding agent did. Rewind any mistake in 1 second.

Usage:
  agent-dashcam [project-dir] [options]

Options:
  --demo               Create a sandbox project with a sample incident session and open it
  --session <id|file>  Use a specific Claude Code session (id prefix or path to .jsonl)
  --port <n>           Port for the local UI (default 4317)
  --no-open            Do not open the browser
  --list               List Claude Code sessions recorded for the project
  --json               Print the timeline as JSON and exit (no server)
  -h, --help           Show help
  -v, --version        Show version
`;

export interface Args {
  dir: string;
  demo: boolean;
  session?: string;
  port?: number;
  open: boolean;
  list: boolean;
  json: boolean;
}

export function parseArgs(argv: string[]): Args | 'help' | 'version' {
  const a: Args = { dir: process.cwd(), demo: false, open: true, list: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '-h' || t === '--help') return 'help';
    if (t === '-v' || t === '--version') return 'version';
    if (t === '--demo') a.demo = true;
    else if (t === '--no-open') a.open = false;
    else if (t === '--list') a.list = true;
    else if (t === '--json') a.json = true;
    else if (t === '--session') a.session = argv[++i];
    else if (t.startsWith('--session=')) a.session = t.slice(10);
    else if (t === '--port') a.port = Number(argv[++i]);
    else if (t.startsWith('--port=')) a.port = Number(t.slice(7));
    else if (t.startsWith('-')) throw new Error(`Unknown option: ${t}`);
    else a.dir = path.resolve(t);
  }
  return a;
}

function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* no browser available: the URL is printed anyway */
  }
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message + '\n\n' + HELP);
    process.exit(2);
  }
  if (args === 'help') return void console.log(HELP);
  if (args === 'version') return void console.log(VERSION);

  let root = args.dir;
  let sessionFiles: string[] | undefined;
  if (args.demo) {
    const demo = createDemo();
    root = demo.root;
    sessionFiles = [demo.sessionFile];
    console.log(`🎬 Demo sandbox created at ${root}`);
  } else if (args.session) {
    if (fs.existsSync(args.session)) sessionFiles = [path.resolve(args.session)];
    else {
      const want = args.session;
      const s = discoverSessions(root).find((x) => x.id === want || x.id.startsWith(want));
      if (!s) throw new Error(`Session not found: ${want}`);
      sessionFiles = [s.file];
    }
  }
  if (!fs.existsSync(root)) throw new Error(`Project directory not found: ${root}`);

  if (args.list) {
    const list = discoverSessions(root);
    if (!list.length) console.log(`No Claude Code sessions found for ${root}`);
    for (const s of list) console.log(`${s.id}  ${s.startedAt ?? ''}  ${s.title}`);
    return;
  }

  if (args.json) {
    const file = sessionFiles?.[0] ?? discoverSessions(root)[0]?.file;
    console.log(JSON.stringify(buildTimeline({ root, sessionFile: file }), null, 2));
    return;
  }

  const found = sessionFiles ?? discoverSessions(root).map((s) => s.file);
  if (!found.length) {
    console.log(`⚠️  No Claude Code sessions found for ${root} (looked in ~/.claude/projects).`);
    console.log('   Showing git history only. Try `npx agent-dashcam --demo` for a guided sample.');
  }
  const srv = await createServer({ root, sessionFiles, demo: args.demo, port: args.port });
  console.log(`\n● REC  agent-dashcam is running at ${srv.url}`);
  console.log(`       project:  ${root}`);
  console.log(`       sessions: ${found.length}`);
  console.log('       Press Ctrl+C to stop.\n');
  if (args.open) openBrowser(srv.url);
  const stop = () => {
    srv.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`agent-dashcam: ${(e as Error).message}`);
    process.exit(1);
  });
}
