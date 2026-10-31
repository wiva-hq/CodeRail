// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { ERR } from '@coderail/protocol';
import { RpcError, STATE_DIR, userEnv } from './env';
import { browserRuntime } from './browser-runtime';
import { BROWSER_MCP_SOURCE } from './browser-mcp';

// Camofox runs locally behind an authenticated loopback API. Its CodeRail plugin supplies native
// Playwright input and JPEG frames; no site is embedded or rewritten by the hub. One browser per chat session, keyed
// by its id: its own Camofox profile (cookies, sign-ins), and the same screen for everyone who opens that chat.
const DIR = join(STATE_DIR, 'browser');
const IDLE = 5 * 60_000;
/** A chat's browser no one has watched for this long is closed (its profile, cookies and sign-ins, stay). */
const LEFT = 30 * 60_000;
type Size = { width?: number; height?: number; dpr?: number };
type Emit = (topic: string, data: any) => void;
interface Tab {
  id: string;
  remote?: string;
  navigation?: number;
  url: string;
  title: string;
  width: number;
  height: number;
  streaming: boolean;
  seen: number;
  /** When the last viewer went (frames turned off). */
  left?: number;
  status: string;
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
  dpr: number;
  stream?: AbortController;
  lastFrame?: any;
  pendingFrame?: any;
  flushTimer?: ReturnType<typeof setTimeout>;
  /** Settles once Camofox has the tab (or it failed). */
  ready?: Promise<void>;
  recheck?: ReturnType<typeof setTimeout>;
}

/** An MCP tool's answer. */
type ToolResult = { content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]; isError?: boolean };
/** An MCP server for ACP's session/new, session/load and session/resume. */
export type McpServer = { name: string; command: string; args: string[]; env: { name: string; value: string }[] };


export class Browsers {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private starting: Promise<void> | null = null;
  private address = '';
  private key = '';
  private tabs = new Map<string, Tab>();
  private idle: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;

  constructor(private emit: Emit, private writable: () => boolean = () => true) {}

  private event(t: Tab, data: any) { this.emit('browser:' + t.id, data); }
  private sweeper = setInterval(() => this.sweep(), 60_000);
  private status(message: string) {
    for (const t of this.tabs.values()) {
      if (t.remote || t.error) continue;
      t.status = message;
      this.event(t, { type: 'status', message });
    }
  }

  private start(): Promise<void> {
    if (this.address) return Promise.resolve();
    this.starting ??= this.launch().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async launch() {
    const runtime = await browserRuntime();
    if (this.stopped || !this.tabs.size) return;
    mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const env = { ...await userEnv() };
    for (const key of ['CAMOUFOX_EXECUTABLE', 'CAMOUFOX_EXECUTABLE_PATH', 'CAMOFOX_EXECUTABLE_PATH']) delete env[key];
    const pkg = join(runtime, 'node_modules/@askjo/camofox-browser');
    const port = await freePort();
    this.key = crypto.randomUUID();
    this.status('Starting Camofox on the computer…');
    const fd = openSync(join(DIR, 'camofox.log'), 'a', 0o600);
    let proc: ReturnType<typeof Bun.spawn>;
    try { proc = Bun.spawn([process.execPath, join(pkg, 'server.js')], {
      cwd: pkg,
      env: {
        ...env, BUN_BE_BUN: '1', CAMOUFOX_INSTALL_DIR: join(runtime, 'camoufox'), CAMOFOX_DISABLE_DEFAULT_ADDONS: '1', CAMOFOX_INTERACTIVE: 'off', CAMOFOX_PORT: String(port), CAMOFOX_BIND_HOST: '127.0.0.1', CAMOFOX_ACCESS_KEY: this.key,
        // Live capture must show fallback fonts immediately, rather than waiting for web fonts to finish.
        PW_TEST_SCREENSHOT_NO_FONTS_READY: '1', CAMOFOX_CRASH_REPORT_ENABLED: 'false', CAMOFOX_PROFILE_DIR: join(DIR, 'profiles'),
        // (Camofox would close a tab after 5 min without its own automation calls, which CodeRail's plugin never makes:
        // a browser in use, gone. The bridge closes what no one watches instead, see LEFT.)
        SESSION_TIMEOUT_MS: '0', BROWSER_IDLE_TIMEOUT_MS: '0', TAB_INACTIVITY_MS: String(365 * 86_400_000),
      },
      // Camofox logs requests to stdout; browser activity must not grow an unbounded log.
      stdout: 'ignore', stderr: fd,
    }); } finally { closeSync(fd); }
    this.proc = proc;
    void proc.exited.then(() => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.address = '';
      for (const t of this.tabs.values()) {
        if (t.remote) { t.remote = undefined; this.fail(t, 'Camofox stopped on the computer. Open the browser again.'); }
      }
    });
    const address = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 300 && !this.stopped && proc.exitCode === null; i++) {
      try {
        const r = await fetch(address + '/coderail/health', { headers: { authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(1000) });
        if (r.ok) { this.address = address; return; }
      } catch {}
      await Bun.sleep(100);
    }
    proc.kill();
    throw new Error(`Camofox did not start. See ${join(DIR, 'camofox.log')} on the computer.`);
  }

  private async request(path: string, body?: unknown, method = 'POST'): Promise<any> {
    if (!this.address) throw new RpcError(ERR.internal, 'Camofox is not running');
    const r = await fetch(this.address + path, {
      method, headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40_000),
    });
    const data: any = await r.json();
    if (!r.ok) throw new RpcError(r.status === 404 ? ERR.notFound : ERR.internal, data.error ?? 'Camofox could not complete the request');
    return data;
  }

  /** The Camofox user a chat's browser runs as: a profile of its own. */
  private user(t: Tab) { return 'coderail-' + t.id; }
  private get(id: string) {
    const t = this.tabs.get(id);
    if (!t) throw new RpcError(ERR.notFound, 'That browser tab is gone');
    return t;
  }
  private action(t: Tab, action: string, body: any = {}) {
    if (!t.remote) throw new RpcError(ERR.internal, t.error ?? t.status);
    return this.request(`/coderail/${encodeURIComponent(t.remote)}/${action}`, body);
  }
  private fail(t: Tab, message: string) {
    t.error = message;
    t.streaming = false;
    clearTimeout(t.timer); clearTimeout(t.flushTimer); t.flushTimer = undefined; t.pendingFrame = undefined; t.stream?.abort();
    this.event(t, { type: 'error', message });
  }
  private size(t: Tab, p: Size) {
    t.width = clamp(p.width, 200, 3000, t.width);
    t.height = clamp(p.height, 200, 3000, t.height);
    if (Number.isFinite(p.dpr)) t.dpr = Math.min(2, Math.max(1, Number(p.dpr)));
  }

  // Return immediately while the bundled browser starts.
  async open(p: { sessionId: string; url: string } & Size) {
    if (this.stopped) throw new RpcError(ERR.internal, 'The bridge stopped');
    if (typeof p.sessionId !== 'string' || !p.sessionId) throw new RpcError(ERR.invalid, 'A browser belongs to a session');
    // (The chat's browser is already open: it goes there instead. One that failed starts over.)
    const open = this.tabs.get(p.sessionId);
    if (open && !open.error) { await this.navigate(p); return { id: open.id, url: open.url }; }
    if (open) await this.close(p);
    const t: Tab = {
      id: p.sessionId, url: checkUrl(p.url), title: '', width: 1280, height: 800,
      streaming: true, seen: Date.now(), status: 'Starting Camofox on the computer…', dpr: 2,
    };
    this.size(t, p);
    this.tabs.set(t.id, t);
    if (this.idle) clearTimeout(this.idle);
    t.ready = this.create(t);
    return { id: t.id, url: t.url };
  }
  private async create(t: Tab) {
    try {
      await this.start();
      if (this.tabs.get(t.id) !== t) return;
      const r = await this.request('/tabs', { userId: this.user(t), sessionKey: t.id });
      t.remote = String(r.tabId);
      if (this.tabs.get(t.id) !== t) {
        await this.closeGroup(t);
        return;
      }
      await this.action(t, 'resize', { width: t.width, height: t.height, dpr: t.dpr });
      this.stream(t);
      await this.action(t, 'navigate', { url: t.url, sequence: 0 });
    } catch (e) {
      if (this.tabs.get(t.id) === t) this.fail(t, (e as Error).message);
    }
  }
  private present(t: Tab, frame: any) {
    t.lastFrame = frame;
    t.pendingFrame = frame;
    if (t.flushTimer) return;
    const flush = () => {
      t.flushTimer = undefined;
      if (!t.streaming || this.tabs.get(t.id) !== t) { t.pendingFrame = undefined; return; }
      if (this.writable()) {
        const frame = t.pendingFrame; t.pendingFrame = undefined;
        if (frame) this.event(t, frame);
      } else t.flushTimer = setTimeout(flush, 25);
    };
    flush();
  }

  private stream(t: Tab) {
    clearTimeout(t.timer);
    if (!t.streaming || !t.remote || t.stream || this.tabs.get(t.id) !== t) return;
    const controller = new AbortController();
    t.stream = controller;
    void (async () => {
      const timeout = setTimeout(() => controller.abort(), 5000);
      let response: Response;
      try {
        response = await fetch(`${this.address}/coderail/${encodeURIComponent(t.remote!)}/stream`, {
          headers: { authorization: `Bearer ${this.key}` }, signal: controller.signal,
        });
      } finally { clearTimeout(timeout); }
      if (!response.ok || !response.body) {
        if (response.status === 404) this.fail(t, 'This browser tab was closed on the computer.');
        throw new Error(`Browser stream disconnected (${response.status})`);
      }
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim() || !t.streaming || this.tabs.get(t.id) !== t) continue;
            const event = JSON.parse(line);
            if (event.type === 'frame') this.present(t, event);
            else if (event.type === 'nav' && event.url !== 'about:blank') {
              t.url = event.url; t.title = event.title ?? '';
              this.event(t, event);
            } else if (event.type === 'error') this.event(t, event);
            else if (event.type === 'closed') this.fail(t, 'This browser tab was closed on the computer.');
          }
        }
      } finally { reader.releaseLock(); }
    })().catch(() => {
      // Transient connection failures reconnect; the last frame remains visible during the retry.
    }).finally(() => {
      if (t.stream !== controller) return;
      t.stream = undefined;
      if (t.streaming && this.tabs.get(t.id) === t) t.timer = setTimeout(() => this.stream(t), 500);
    });
  }

  // ---- The agent's browser tools (see browser-mcp.ts) ---------------------------------------------------

  /** Each agent session's key to the tools: which chat's browser it drives (null until a new session has its id).
   *  A chat keeps its key, so loading it again hands the agent the same server. */
  private keys = new Map<string, string | null>();
  private bySession = new Map<string, { server: McpServer; key: string }>();
  private unbound = new Map<string, { server: McpServer; key: string }>();
  private endpoint: { url: string; token: string; server: ReturnType<typeof Bun.serve> } | null = null;
  private mcpScript = '';

  /** The browser MCP server for an agent session (a new one: bindKey once it has its id). */
  mcpServer(sessionId?: string): { server: McpServer; key: string } {
    const had = sessionId ? this.bySession.get(sessionId) : undefined;
    if (had) return had;
    const key = crypto.randomUUID();
    this.keys.set(key, sessionId ?? null);
    const api = this.toolEndpoint();
    if (!this.mcpScript) {
      this.mcpScript = join(STATE_DIR, `browser-mcp-${Bun.hash(BROWSER_MCP_SOURCE).toString(36)}.js`);
      if (!existsSync(this.mcpScript)) { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(this.mcpScript, BROWSER_MCP_SOURCE); }
    }
    const env = { BUN_BE_BUN: '1', CODERAIL_BROWSER_API: api.url, CODERAIL_BROWSER_TOKEN: api.token, CODERAIL_BROWSER_KEY: key };
    const out = { key, server: { name: 'browser', command: process.execPath, args: [this.mcpScript], env: Object.entries(env).map(([name, value]) => ({ name, value })) } };
    if (sessionId) this.bySession.set(sessionId, out); else this.unbound.set(key, out);
    return out;
  }
  /** Forgets a session's key (it closed), or a key whose session never started. */
  release(keyOrSession: string) {
    const s = this.bySession.get(keyOrSession);
    if (s) { this.bySession.delete(keyOrSession); this.keys.delete(s.key); return; }
    this.keys.delete(keyOrSession);
    this.unbound.delete(keyOrSession);
  }
  bindKey(key: string, sessionId: string) {
    if (!this.keys.has(key)) return;
    this.keys.set(key, sessionId);
    const out = this.unbound.get(key);
    if (out) { this.unbound.delete(key); this.bySession.set(sessionId, out); }
  }

  /** The loopback endpoint the MCP servers call: a random port, and a token only they are given. */
  private toolEndpoint() {
    if (this.endpoint) return this.endpoint;
    const token = crypto.randomUUID();
    const server = Bun.serve({
      hostname: '127.0.0.1', port: 0,
      fetch: async (req) => {
        if (req.method !== 'POST' || req.headers.get('authorization') !== `Bearer ${token}`) return new Response('no', { status: 403 });
        const b = (await req.json().catch(() => ({}))) as { key?: string; name?: string; args?: any };
        const sessionId = b.key ? this.keys.get(b.key) : undefined;
        if (!sessionId) return Response.json(toolError('This chat is still starting; try again in a moment.'));
        return Response.json(await this.tool(sessionId, String(b.name), b.args ?? {}).catch((e) => toolError((e as Error).message)));
      },
    });
    this.endpoint = { url: `http://127.0.0.1:${server.port}`, token, server };
    return this.endpoint;
  }

  /** One tool call on a chat's browser. */
  async tool(sessionId: string, name: string, args: any): Promise<ToolResult> {
    if (name === 'navigate') {
      const url = checkUrl(args.url);
      const open = this.tabs.get(sessionId);
      if (!open || open.error) {
        await this.open({ sessionId, url });
        // (The chat's Browser card opens on it, for anyone looking at the chat.)
        this.emit('machine', { type: 'browser', sessionId });
      } else await this.navigate({ sessionId, url });
      const t = await this.ready(sessionId);
      return this.snapshot(t);
    }
    const t = await this.ready(sessionId);
    const user = this.user(t);
    const tab = await this.shown(t);
    let out: ToolResult;
    switch (name) {
      case 'snapshot': out = await this.snapshot(t, Number(args.offset) || 0, tab); break;
      case 'click': await this.request(`/tabs/${tab}/click`, { userId: user, ref: args.ref, selector: args.selector }); out = await this.snapshot(t, 0, tab); break;
      case 'type': await this.request(`/tabs/${tab}/type`, { userId: user, ref: args.ref, selector: args.selector, text: String(args.text ?? ''), pressEnter: !!args.pressEnter }); out = await this.snapshot(t, 0, tab); break;
      case 'press': await this.request(`/tabs/${tab}/press`, { userId: user, key: String(args.key) }); out = await this.snapshot(t, 0, tab); break;
      case 'scroll': await this.request(`/tabs/${tab}/scroll`, { userId: user, direction: args.direction, amount: Number(args.amount) || 600 }); out = text('Scrolled.'); break;
      case 'back': await this.action(t, 'go', { delta: -1 }); out = await this.snapshot(t, 0, tab); break;
      case 'evaluate': out = text(JSON.stringify((await this.request(`/tabs/${tab}/evaluate`, { userId: user, expression: String(args.expression ?? '') })).result ?? null, null, 1)?.slice(0, 50_000) ?? 'undefined'); break;
      case 'screenshot': {
        const r = await fetch(`${this.address}/tabs/${tab}/screenshot?userId=${encodeURIComponent(user)}`, { headers: { authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(30_000) });
        if (!r.ok) throw new Error('The screenshot failed');
        out = { content: [{ type: 'image', data: Buffer.from(await r.arrayBuffer()).toString('base64'), mimeType: 'image/png' }] };
        break;
      }
      default: return toolError(`No tool ${name}`);
    }
    // (What the agent did shows at once in the card: the frames speed up as for a person's input.)
    await this.action(t, 'touch').catch(() => {});
    return out;
  }

  /** The chat's open browser, once Camofox has its tab. */
  private async ready(sessionId: string): Promise<Tab> {
    const t = this.tabs.get(sessionId);
    if (!t) throw new Error("This chat's browser isn't open: use navigate to open a page.");
    await t.ready;
    if (!t.remote || t.error) throw new Error(t.error ?? 'The browser could not start');
    return t;
  }

  /** Camofox's id for the page the chat's card shows: the tab's own, or a popup it opened. */
  private async shown(t: Tab): Promise<string> {
    const r = await fetch(`${this.address}/coderail/${encodeURIComponent(t.remote!)}/current`, { headers: { authorization: `Bearer ${this.key}` } }).catch(() => null);
    const j: any = r?.ok ? await r.json().catch(() => null) : null;
    return typeof j?.tabId === 'string' ? j.tabId : t.remote!;
  }

  private async snapshot(t: Tab, offset = 0, tab = t.remote): Promise<ToolResult> {
    const r = await this.request(`/tabs/${tab}/snapshot?${new URLSearchParams({ userId: this.user(t), offset: String(offset) })}`, undefined, 'GET');
    const more = r.hasMore ? `\n\n(More of the page: snapshot with offset ${r.nextOffset}.)` : '';
    return text(`${r.url}\n\n${r.snapshot ?? ''}${more}`);
  }

  async attach(p: { sessionId: string } & Size) {
    const t = this.get(p.sessionId);
    await this.resize(p);
    await this.watch({ sessionId: t.id, on: true });
    return { id: t.id, url: t.url, title: t.title };
  }
  async resize(p: { sessionId: string } & Size) {
    const t = this.get(p.sessionId);
    this.size(t, p);
    if (t.remote) await this.action(t, 'resize', { width: t.width, height: t.height, dpr: t.dpr });
    return { ok: true };
  }
  async watch(p: { sessionId: string; on: boolean }) {
    const t = this.get(p.sessionId);
    t.streaming = !!p.on && !t.error;
    if (p.on) {
      t.seen = Date.now();
      if (t.lastFrame) this.present(t, t.lastFrame);
      if (t.error) this.event(t, { type: 'error', message: t.error });
      else if (!t.remote) this.event(t, { type: 'status', message: t.status });
    }
    if (!t.streaming) { t.left = Date.now(); t.stream?.abort(); clearTimeout(t.flushTimer); t.flushTimer = undefined; t.pendingFrame = undefined; }
    else this.stream(t);
    return { ok: true };
  }
  quiet(id: string) {
    const t = this.tabs.get(id);
    if (!t) return;
    // (Too soon after someone asked for frames: look again then. A still page sends no frame to ask again with.)
    const wait = 5000 - (Date.now() - t.seen);
    if (wait > 0) { clearTimeout(t.recheck); t.recheck = setTimeout(() => this.quiet(id), wait + 50); return; }
    void this.watch({ sessionId: id, on: false });
  }
  /** Closes the browsers no one has watched for LEFT. */
  private sweep() {
    for (const t of [...this.tabs.values()]) {
      if (!t.streaming && Date.now() - (t.left ?? t.seen) > LEFT) void this.close({ sessionId: t.id }).catch(() => {});
    }
  }
  async navigate(p: { sessionId: string; url: string }) {
    const t = this.get(p.sessionId);
    const url = checkUrl(p.url);
    if (t.error && !t.remote) throw new RpcError(ERR.internal, t.error);
    t.error = undefined;
    t.url = url;
    t.streaming = true;
    const sequence = t.navigation = (t.navigation ?? 0) + 1;
    this.stream(t);
    if (t.remote) await this.action(t, 'navigate', { url, sequence });
    return { ok: true };
  }
  async go(p: { sessionId: string; delta: number }) {
    await this.action(this.get(p.sessionId), 'go', { delta: Number(p.delta) || 0 });
    return { ok: true };
  }
  async input(p: { sessionId: string; ev: any }) {
    await this.action(this.get(p.sessionId), 'input', { ev: p.ev });
    return { ok: true };
  }
  async close(p: { sessionId: string }) {
    const t = this.tabs.get(p.sessionId);
    if (!t) return { ok: true };
    this.tabs.delete(t.id);
    clearTimeout(t.timer); clearTimeout(t.flushTimer); t.stream?.abort();
    if (t.remote) await this.closeGroup(t).catch(() => {});
    this.event(t, { type: 'closed' });
    if (!this.tabs.size) this.idle = setTimeout(() => { if (!this.tabs.size) this.stopProcess(); }, IDLE);
    return { ok: true };
  }
  private closeGroup(t: Tab) {
    return this.request(`/tabs/group/${encodeURIComponent(t.id)}?userId=${encodeURIComponent(this.user(t))}`, undefined, 'DELETE');
  }
  private stopProcess() {
    this.address = '';
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
  }
  shutdown() {
    this.stopped = true;
    clearInterval(this.sweeper);
    this.endpoint?.server.stop(true);
    if (this.idle) clearTimeout(this.idle);
    for (const t of this.tabs.values()) { clearTimeout(t.timer); clearTimeout(t.flushTimer); t.stream?.abort(); this.event(t, { type: 'closed' }); }
    this.tabs.clear();
    this.stopProcess();
  }
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, no) => { server.once('error', no); server.listen(0, '127.0.0.1', ok); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((ok, no) => server.close((e) => e ? no(e) : ok()));
  return port;
}
function text(t: string): ToolResult { return { content: [{ type: 'text', text: t }] }; }
function toolError(t: string): ToolResult { return { content: [{ type: 'text', text: t }], isError: true }; }

function checkUrl(u: unknown): string {
  let url: URL;
  try { url = new URL(String(u)); } catch { throw new RpcError(ERR.invalid, 'Not an address'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new RpcError(ERR.invalid, 'Only http and https addresses');
  return url.href;
}
function clamp(n: unknown, lo: number, hi: number, fallback: number) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? Math.round(Math.min(hi, Math.max(lo, v))) : fallback;
}
