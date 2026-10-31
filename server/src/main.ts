// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The CodeRail server: one process for the web app, the API and every machine's hub (bridge and client sockets).
// Plain HTTP on PORT; HTTPS is whatever sits in front of it (Caddy, a tunnel, a load balancer). With TRUST_PROXY=1 the
// X-Forwarded-Proto, -Host and -For it sends are believed (never set it where clients can reach the port directly).
// Everything it keeps is under DATA_DIR.
//
// Environment: PORT (8080), DATA_DIR (./data), WEB_DIR (the built web app, ../web/dist), SETUP_TOKEN (to create
// the first admin at /setup), TRUST_PROXY, and for push notifications VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT.
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';
import { Db } from './db';
import { migrate } from './schema';
import { Hub, Upgrade } from './hub';
import type { SockData } from './machine';
import { site, trimAudit } from './index';
import { type Env, clientIp } from './util';

const PORT = Number(process.env.PORT) || 8080;
const DATA_DIR = resolve(process.env.DATA_DIR || './data');
const WEB_DIR = resolve(process.env.WEB_DIR || join(import.meta.dir, '../../web/dist'));
const TRUST_PROXY = /^(1|true|yes)$/i.test(process.env.TRUST_PROXY ?? '');

mkdirSync(DATA_DIR, { recursive: true });
const db = new Db(join(DATA_DIR, 'coderail.sqlite'));
migrate(db);
// (No bridge is connected to a server that just started: each comes back and says so.)
db.sqlite.exec('UPDATE machines SET online = 0');
const env: Env = {
  DB: db,
  SETUP_TOKEN: process.env.SETUP_TOKEN || undefined,
  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || undefined,
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || undefined,
  VAPID_SUBJECT: process.env.VAPID_SUBJECT || undefined,
};
const hub = new Hub(env, DATA_DIR);

// ---- The web app's files ---------------------------------------------------------------------------------

/** A built file, read once: its bytes, and compressed copies when it is text worth compressing. */
type Asset = { body: Uint8Array; type: string; br?: Uint8Array; gz?: Uint8Array };
const assets = new Map<string, Asset | null>();
const TEXT = /\.(html|js|mjs|css|json|svg|txt|map|webmanifest|xml)$/;

async function asset(path: string): Promise<Asset | null> {
  if (assets.has(path)) return assets.get(path)!;
  // (Only files that exist are kept: anyone can ask for any name.)
  const full = join(WEB_DIR, path);
  // (Only files under the web app's folder.)
  const file = full.startsWith(WEB_DIR + '/') ? Bun.file(full) : null;
  let a: Asset | null = null;
  if (file && (await file.exists())) {
    const body = new Uint8Array(await file.arrayBuffer());
    a = { body, type: file.type };
    if (TEXT.test(path) && body.length > 1024) {
      a.br = brotliCompressSync(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } });
      a.gz = gzipSync(body, { level: 9 });
    }
  }
  if (a) assets.set(path, a);
  return a;
}

async function serveFile(req: Request, url: URL): Promise<Response> {
  let path = decodeURIComponent(url.pathname);
  if (path.endsWith('/')) path += 'index.html';
  let a = await asset(path);
  // (An app route, not a file: the app itself, which reads the route.)
  if (!a && !/\.\w+$/.test(path)) (a = await asset('/index.html')), (path = '/index.html');
  if (!a) return new Response('Not found', { status: 404 });
  const accept = req.headers.get('accept-encoding') ?? '';
  // (Brotli only over https, as browsers take it; gzip otherwise.)
  const br = a.br && url.protocol === 'https:' && /\bbr\b/.test(accept);
  const [body, encoding] = br ? [a.br!, 'br'] : a.gz && /\bgzip\b/.test(accept) ? [a.gz, 'gzip'] : [a.body, null];
  const headers: Record<string, string> = {
    'content-type': a.type,
    // (Vite names built files by their content: they never change. Everything else is checked each time.)
    'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    vary: 'accept-encoding',
  };
  if (encoding) headers['content-encoding'] = encoding;
  return new Response(body as Uint8Array<ArrayBuffer>, { headers });
}

/** CodeRail's own pages are never shown inside another page (a site could frame them to trick a click). */
function noFraming(res: Response): Response {
  // (A computer's file sets its own: shown in the app's own frames, as a PDF is, and nowhere else.)
  if (res.headers.has('x-frame-options')) return res;
  res.headers.set('x-frame-options', 'DENY');
  res.headers.set('content-security-policy', "frame-ancestors 'none'");
  return res;
}

// ---- The server ------------------------------------------------------------------------------------------

/** The request as the browser made it: https and the public host when a trusted proxy in front says so. */
function publicRequest(req: Request): Request {
  if (!TRUST_PROXY) return req;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim();
  const host = req.headers.get('x-forwarded-host')?.split(',')[0].trim();
  if (!proto && !host) return req;
  const url = new URL(req.url);
  if (proto === 'https' || proto === 'http') url.protocol = proto + ':';
  if (host) url.host = host;
  return new Request(url, req);
}

const server = Bun.serve<SockData>({
  port: PORT,
  // (Agent history pages can be large; frames are capped near 1 MiB on the bridge's side.)
  maxRequestBodySize: 32 * 1024 * 1024,
  async fetch(raw, srv) {
    const req = publicRequest(raw);
    // (Behind a trusted proxy, the address it added: the last one. Anything before it, the client could have written.)
    const forwarded = TRUST_PROXY ? req.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim() : undefined;
    clientIp.set(req, forwarded || srv.requestIP(raw)?.address || 'unknown');
    const url = new URL(req.url);
    const out = await site(req, env, hub, url);
    if (out instanceof Upgrade) {
      if (srv.upgrade(raw, { data: out.data })) return undefined;
      return new Response('Expected a WebSocket', { status: 426 });
    }
    return noFraming(out ?? (await serveFile(req, url)));
  },
  websocket: {
    // (Frames are JPEG and JSON already: compressing them again costs CPU for little.)
    perMessageDeflate: false,
    // (A prompt carries its pictures: several of the composer's 5 MB each.)
    maxPayloadLength: 64 * 1024 * 1024,
    idleTimeout: 120,
    open: (ws) => ws.data.machine.open(ws),
    message: (ws, msg) => void ws.data.machine.webSocketMessage(ws, msg).catch((e) => console.error('socket message', e)),
    close: (ws) => void ws.data.machine.webSocketClose(ws).catch((e) => console.error('socket close', e)),
  },
});

// (A socket outlives nothing it was opened with: a sign-out, a password change or an expired session closes it.)
setInterval(() => void hub.sweepAuth().catch((e) => console.error('auth sweep', e)), 60_000);

// (The audit log's trim: at start, then daily.)
void trimAudit(env).catch((e) => console.error('audit trim', e));
setInterval(() => void trimAudit(env).catch((e) => console.error('audit trim', e)), 86_400_000);

console.log(`CodeRail server on :${server.port} (data in ${DATA_DIR}, web app from ${WEB_DIR})`);

// (Stopped by Docker: close every socket (a bridge's never ends by itself), then the databases.)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void server.stop(true).finally(() => {
      db.sqlite.close();
      process.exit(0);
    });
  });
}
