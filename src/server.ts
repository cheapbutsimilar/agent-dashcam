import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { discoverSessions, peekSession } from './collectors/discover';
import { diffFiles } from './diff';
import { applyRewind, listBackups, planRewind, restoreBackup, RewindConflictError, type RewindMode } from './rewind';
import { buildTimeline } from './timeline';
import type { SessionInfo } from './types';
import { VERSION } from './version';

export interface ServerOptions {
  root: string;
  /** Explicit session files (demo mode, --session). Otherwise discovered from ~/.claude. */
  sessionFiles?: string[];
  demo?: boolean;
  port?: number;
  host?: string;
  publicDir?: string;
}

export interface DashcamServer {
  server: http.Server;
  url: string;
  token: string;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function defaultPublicDir(): string {
  // dist/src/server.js -> ../../public
  const candidates = [path.join(__dirname, '..', '..', 'public'), path.join(__dirname, '..', 'public')];
  return candidates.find((c) => fs.existsSync(path.join(c, 'index.html'))) ?? candidates[0];
}

function readBody(req: http.IncomingMessage, limit = 1024 * 1024): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function createServer(opts: ServerOptions): Promise<DashcamServer> {
  const root = path.resolve(opts.root);
  const publicDir = opts.publicDir ?? defaultPublicDir();
  const token = randomBytes(18).toString('hex');
  const host = opts.host ?? '127.0.0.1';

  const sessions = (): SessionInfo[] => (opts.sessionFiles?.length ? opts.sessionFiles.map(peekSession) : discoverSessions(root));
  const sessionFile = (id?: string): string | undefined => {
    const list = sessions();
    if (!id) return list[0]?.file;
    if (id === 'none') return undefined;
    const s = list.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error(`Unknown session: ${id}`), { status: 404 });
    return s.file;
  };
  const timeline = (id?: string) => buildTimeline({ root, sessionFile: sessionFile(id) });
  const timelineForUi = (id?: string) => {
    const tl = timeline(id);
    for (const e of tl.events) {
      if ((e.type === 'file_edit' || e.type === 'file_create') && e.after !== undefined && e.before !== undefined) {
        e.diff = diffFiles(e.before, e.after);
      }
    }
    return tl;
  };

  const handler = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // DNS-rebinding guard: only answer to loopback host names.
    const hostHeader = (req.headers.host ?? '').replace(/:\d+$/, '');
    if (!['localhost', '127.0.0.1', '[::1]', host].includes(hostHeader)) {
      res.writeHead(403).end('Forbidden host');
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      // CSRF guard: every API call must carry the per-launch token embedded in the page.
      if (req.headers['x-dashcam-token'] !== token) return send(res, 401, { error: 'Missing or invalid dashcam token' });
      try {
        if (req.method === 'GET' && url.pathname === '/api/meta') {
          return send(res, 200, { root, demo: Boolean(opts.demo), sessions: sessions(), version: VERSION });
        }
        if (req.method === 'GET' && url.pathname === '/api/timeline') {
          return send(res, 200, timelineForUi(url.searchParams.get('session') ?? undefined));
        }
        if (req.method === 'GET' && url.pathname === '/api/backups') {
          return send(res, 200, listBackups(root));
        }
        if (req.method === 'POST') {
          const body = await readBody(req);
          const mode: RewindMode = body.mode === 'before' ? 'before' : 'after';
          if (url.pathname === '/api/rewind/preview') {
            const tl = timeline(body.session);
            return send(res, 200, planRewind({ root, events: tl.events, eventId: String(body.eventId), mode }));
          }
          if (url.pathname === '/api/rewind/apply') {
            const tl = timeline(body.session);
            return send(res, 200, applyRewind({ root, events: tl.events, eventId: String(body.eventId), mode, token: String(body.token ?? '') }));
          }
          if (url.pathname === '/api/undo') {
            return send(res, 200, restoreBackup(root, String(body.backupId ?? '')));
          }
        }
        return send(res, 404, { error: 'Not found' });
      } catch (err) {
        const e = err as Error & { status?: number };
        const status = e instanceof RewindConflictError ? 409 : (e.status ?? 400);
        return send(res, status, { error: e.message });
      }
    }

    if (req.method !== 'GET') {
      res.writeHead(405).end();
      return;
    }
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = path.resolve(publicDir, rel);
    if (!file.startsWith(path.resolve(publicDir) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end('Not found');
      return;
    }
    let content: string | Buffer = fs.readFileSync(file);
    if (rel === 'index.html') content = content.toString('utf8').replace('__DASHCAM_TOKEN__', token);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:",
    });
    res.end(content);
  };

  const server = http.createServer((req, res) => {
    handler(req, res).catch((e) => send(res, 500, { error: String(e?.message ?? e) }));
  });

  return new Promise((resolve, reject) => {
    let port = opts.port ?? 4317;
    const tries = opts.port === 0 ? 1 : 15;
    let attempt = 0;
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && ++attempt < tries) {
        port++;
        server.listen(port, host);
      } else reject(err);
    };
    server.on('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        token,
        url: `http://${host === '127.0.0.1' ? 'localhost' : host}:${actual}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
