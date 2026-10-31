// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Approval, type Caller, ERR, HARNESSES, type HarnessAuth, type HarnessInfo, type LocalSession } from '@coderail/protocol';
import { existsSync, statSync } from 'node:fs';
import { adapterPath } from './adapters';
import type { McpServer } from './browser';
import { RpcError, VERSION, log, run, userEnv } from './env';
import { checkPath } from './scope';

// Agents over ACP: one adapter process per harness, shared by all its sessions. The adapter runs the
// machine's own `claude` / `codex` with the machine's own login and config; CodeRail only relays.

type Emit = (topic: string, data: any) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

class AdapterProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private ready: Promise<any> | null = null;
  caps: any = {};
  loaded = new Set<string>();
  /** Sessions whose session/update notifications are being held back (a load replaying what CodeRail has). */
  quiet = new Set<string>();
  /** Sessions whose replayed updates are being collected (a load of a session CodeRail has not seen). */
  collecting = new Map<string, any[]>();

  constructor(
    readonly harness: string,
    private onRequest: (method: string, params: any) => Promise<any>,
    private onNotify: (method: string, params: any) => void,
    private onExit: () => void,
  ) {}

  async start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = (async () => {
      const env = await userEnv();
      const h = await detect(this.harness);
      if (!h.installed || !h.path) throw new RpcError(ERR.notFound, `${h.name} is not installed on this machine`);
      const childEnv: Record<string, string> = { ...env, BUN_BE_BUN: '1' };
      if (this.harness === 'claude-code') childEnv.CLAUDE_CODE_EXECUTABLE = h.path;
      if (this.harness === 'codex') childEnv.CODEX_PATH = h.path;
      const script = await adapterPath(this.harness);
      log(`starting ${this.harness} adapter`);
      this.proc = Bun.spawn([process.execPath, script], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: childEnv,
        cwd: env.HOME,
      });
      const proc = this.proc;
      this.readLines(this.proc.stdout as ReadableStream<Uint8Array>, (line) => this.onLine(line));
      this.readLines(this.proc.stderr as ReadableStream<Uint8Array>, (line) => {
        if (process.env.CODERAIL_DEBUG) log(`[${this.harness}] ${line}`);
      });
      this.proc.exited.then((code) => {
        log(`${this.harness} adapter exited (${code})`);
        // (One that failed to start and was replaced: the new one is not its to clear.)
        if (this.proc !== proc) return;
        this.proc = null;
        this.ready = null;
        this.loaded.clear();
        for (const p of this.pending.values()) p.reject(new RpcError(ERR.internal, `${this.harness} stopped`));
        this.pending.clear();
        this.onExit();
      });
      const init = await withTimeout(30_000, `${this.harness} did not start`, this.request('initialize', {
        protocolVersion: 1,
        // (On/off options as booleans, and the model and effort lists as the choices themselves, the recommended one
        // marked, rather than a "Default (recommended)" entry: the AIR extension claude-agent-acp reads.)
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false }, terminal: false,
          session: { configOptions: { boolean: {} } },
          // (asyncTasks: what an agent leaves running in the background comes as async_task_* updates.)
          _meta: { jetbrains: { air: { version: 1, capabilities: ['recommendedValue', 'asyncTasks'] } } },
        },
        clientInfo: { name: 'coderail', title: 'CodeRail', version: VERSION },
      }));
      this.caps = init?.agentCapabilities ?? {};
    })();
    try {
      await this.ready;
    } catch (e) {
      this.ready = null;
      this.proc?.kill();
      throw e;
    }
  }

  get running() {
    return !!this.proc;
  }

  stop() {
    this.proc?.kill();
  }

  private async readLines(stream: ReadableStream<Uint8Array>, onLine: (l: string) => void) {
    const dec = new TextDecoder();
    let buf = '';
    try {
      for await (const chunk of stream) {
        buf += dec.decode(chunk, { stream: true });
        let n: number;
        while ((n = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, n).trim();
          buf = buf.slice(n + 1);
          if (line) onLine(line);
        }
      }
    } catch {}
  }

  private write(msg: any) {
    const stdin = this.proc?.stdin as import('bun').FileSink | undefined;
    if (!stdin) throw new RpcError(ERR.internal, `${this.harness} is not running`);
    stdin.write(JSON.stringify(msg) + '\n');
    stdin.flush();
  }

  request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write({ jsonrpc: '2.0', id, method, params });
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  notify(method: string, params: any) {
    this.write({ jsonrpc: '2.0', method, params });
  }

  private onLine(line: string) {
    let m: any;
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    if (m.id !== undefined && m.method) {
      this.onRequest(m.method, m.params).then(
        (result) => this.write({ jsonrpc: '2.0', id: m.id, result }),
        (e: any) => this.write({ jsonrpc: '2.0', id: m.id, error: { code: e.code ?? ERR.internal, message: e.message ?? String(e) } }),
      );
    } else if (m.id !== undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new RpcError(m.error.code ?? ERR.internal, m.error.message ?? 'Error'));
      else p.resolve(m.result);
    } else if (m.method) {
      if (m.method === 'session/update') {
        const sid = m.params?.sessionId;
        if (this.quiet.has(sid)) return;
        const c = this.collecting.get(sid);
        if (c) return void c.push(m.params.update);
      }
      this.onNotify(m.method, m.params);
    }
  }
}

interface PendingApproval {
  approval: Approval;
  resolve: (outcome: any) => void;
}

export class Agents {
  private procs = new Map<string, AdapterProcess>();
  private approvals = new Map<string, PendingApproval>();
  private busy = new Map<string, number>(); // sessionId -> prompts in flight
  private sessionHarness = new Map<string, string>();
  private nextApproval = 1;

  /** browser: the chat's browser as an MCP server for each session (Browsers.mcpServer, bindKey). */
  constructor(private emit: Emit, private browser?: { mcpServer(sessionId?: string): { server: McpServer; key: string }; bindKey(key: string, sessionId: string): void; release(key: string): void }) {}

  /** The MCP servers a session gets: its chat's browser. */
  private mcp(sessionId: string): McpServer[] {
    return this.browser ? [this.browser.mcpServer(sessionId).server] : [];
  }

  live() {
    return {
      sessions: [...this.sessionHarness].map(([sessionId, harness]) => ({ sessionId, harness, busy: (this.busy.get(sessionId) ?? 0) > 0 })),
      approvals: [...this.approvals.values()].map((a) => a.approval),
      tasks: [...this.tasks.values()].map(({ sessionId, update }) => ({ sessionId, update })),
    };
  }

  /** What the agents left running in the background, by task id: its session and its updates so far, merged. */
  private tasks = new Map<string, { sessionId: string; harness: string; update: any }>();
  private trackTask(harness: string, sessionId: string, u: any) {
    const id = u?.asyncTaskId;
    if (typeof id !== 'string') return;
    if (u.sessionUpdate === 'async_task_state_update' && ['completed', 'failed', 'stopped'].includes(u.state)) { this.tasks.delete(id); return; }
    const had = this.tasks.get(id);
    if (!had && u.sessionUpdate !== 'async_task_spawned') return;
    this.tasks.set(id, { sessionId, harness, update: { ...had?.update, ...u, sessionUpdate: 'async_task_spawned' } });
  }
  /** Tasks that can't go on (their adapter gone, their session closed): ended, so no one waits on them. */
  private endTasks(match: (t: { sessionId: string; harness: string }) => boolean, summary: string) {
    for (const [id, t] of this.tasks) {
      if (!match(t)) continue;
      this.tasks.delete(id);
      this.emit('session:' + t.sessionId, { kind: 'update', data: { sessionUpdate: 'async_task_state_update', asyncTaskId: id, state: 'failed', summary } });
    }
  }

  private proc(harness: string): AdapterProcess {
    if (!HARNESSES.some((h) => h.id === harness)) throw new RpcError(ERR.invalid, `Unknown harness ${harness}`);
    let p = this.procs.get(harness);
    if (!p) {
      p = new AdapterProcess(
        harness,
        (method, params) => this.fromAgent(harness, method, params),
        (method, params) => this.agentNotice(harness, method, params),
        () => this.adapterExited(harness),
      );
      this.procs.set(harness, p);
    }
    return p;
  }

  private async started(harness: string): Promise<AdapterProcess> {
    const p = this.proc(harness);
    await p.start();
    return p;
  }

  private adapterExited(harness: string) {
    for (const [id, a] of this.approvals) {
      if (a.approval.harness !== harness) continue;
      this.approvals.delete(id);
      this.emit('session:' + a.approval.sessionId, { kind: 'answer', data: { approvalId: id, optionId: null, by: null } });
    }
    // (A turn that was running reports the stop itself: its prompt's request fails.)
    this.endTasks((t) => t.harness === harness, `${harness} stopped`);
  }

  /** Requests the agent makes of us: permission asks. */
  private async fromAgent(harness: string, method: string, params: any): Promise<any> {
    if (method === 'session/request_permission') {
      const id = `ap${Date.now().toString(36)}${(this.nextApproval++).toString(36)}`;
      const approval: Approval = {
        id,
        sessionId: params.sessionId,
        harness,
        toolCall: params.toolCall,
        options: params.options ?? [],
        at: Date.now(),
      };
      const outcome = await new Promise<any>((resolve) => {
        this.approvals.set(id, { approval, resolve });
        this.emit('session:' + params.sessionId, { kind: 'approval', data: approval });
      });
      return { outcome };
    }
    throw new RpcError(ERR.method, `CodeRail does not handle ${method}`);
  }

  private agentNotice(harness: string, method: string, params: any) {
    if (method === 'session/update' && params?.sessionId) {
      if (String(params.update?.sessionUpdate).startsWith('async_task_')) this.trackTask(harness, params.sessionId, params.update);
      this.emit('session:' + params.sessionId, { kind: 'update', data: params.update });
    } else if (method.endsWith('auth/status_update')) {
      this.emit('machine', { type: 'auth', harness, status: params?.authStatus ?? params });
    }
  }

  // ---- Methods ---------------------------------------------------------------------------------------

  async harnesses(): Promise<HarnessInfo[]> {
    return Promise.all(HARNESSES.map((h) => detect(h.id, true)));
  }

  async local(p: { harness: string; cwd?: string }, caller: Caller): Promise<LocalSession[]> {
    const cwd = p.cwd ? await checkPath(p.cwd, caller) : undefined;
    const proc = await this.started(p.harness);
    if (!proc.caps?.sessionCapabilities?.list) return [];
    const out: LocalSession[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 5 && out.length < 300; page++) {
      const r = await proc.request('session/list', { cwd, cursor });
      for (const s of r?.sessions ?? []) {
        out.push({ sessionId: s.sessionId, harness: p.harness, cwd: s.cwd, title: s.title ?? null, updatedAt: s.updatedAt ?? null });
      }
      cursor = r?.nextCursor;
      if (!cursor) break;
    }
    return out;
  }

  async newSession(p: { harness: string; cwd: string }, caller: Caller) {
    const cwd = await checkPath(p.cwd, caller);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new RpcError(ERR.notFound, 'That folder does not exist');
    const proc = await this.started(p.harness);
    // (A new session's id comes with the answer: its browser key is bound to it then.)
    const b = this.browser?.mcpServer();
    const r = await proc.request('session/new', { cwd, mcpServers: b ? [b.server] : [] }).catch((e) => {
      if (b) this.browser!.release(b.key);
      throw e;
    });
    if (b) this.browser!.bindKey(b.key, r.sessionId);
    proc.loaded.add(r.sessionId);
    this.sessionHarness.set(r.sessionId, p.harness);
    return { sessionId: r.sessionId, harness: p.harness, cwd, title: null, modes: r.modes, models: r.models, configOptions: r.configOptions };
  }

  /** Bring back a session from the harness's own history. `known`: CodeRail already has its log. */
  async open(p: { harness: string; sessionId: string; cwd: string; known?: boolean }, caller: Caller, after: (send: () => void) => void) {
    const cwd = await checkPath(p.cwd, caller);
    const proc = await this.started(p.harness);
    if (!p.known && caller.folders) {
      // A session CodeRail has never seen: the folder the harness has it in must be the caller's, not just the
      // folder they named (session ids can be global to a harness).
      const theirs = (await this.local({ harness: p.harness }, caller)).find((s) => s.sessionId === p.sessionId);
      if (!theirs?.cwd || !await checkPath(theirs.cwd, caller).then(() => true, () => false)) {
        throw new RpcError(ERR.forbidden, 'That session is outside your folders');
      }
    }
    let replay: any[] = [];
    let r: any = {};
    if (p.known) {
      r = await this.attach(proc, p.sessionId, cwd);
    } else if (proc.caps?.loadSession) {
      proc.collecting.set(p.sessionId, replay);
      try {
        r = await proc.request('session/load', { sessionId: p.sessionId, cwd, mcpServers: this.mcp(p.sessionId) });
      } finally {
        replay = proc.collecting.get(p.sessionId) ?? replay;
        proc.collecting.delete(p.sessionId);
      }
    } else {
      r = await proc.request('session/resume', { sessionId: p.sessionId, cwd, mcpServers: this.mcp(p.sessionId) });
    }
    proc.loaded.add(p.sessionId);
    this.sessionHarness.set(p.sessionId, p.harness);
    // The replay goes out after the answer, once the hub has made the session's row to log it in.
    after(() => {
      for (const u of replay) this.emit('session:' + p.sessionId, { kind: 'update', data: u });
    });
    let title: string | null = null;
    for (const u of replay) if (u?.sessionUpdate === 'session_info_update' && u.title) title = u.title;
    return { sessionId: p.sessionId, harness: p.harness, cwd, title, modes: r?.modes, models: r?.models, configOptions: r?.configOptions };
  }

  /** Make sure the adapter has the session loaded, without replaying its history. */
  /** Loads in progress, by session: a second call waits for the first rather than loading it again. */
  private attaching = new Map<string, Promise<any>>();
  private attach(proc: AdapterProcess, sessionId: string, cwd: string): Promise<any> {
    if (proc.loaded.has(sessionId)) return Promise.resolve({});
    let a = this.attaching.get(sessionId);
    if (!a) {
      a = this.attachNow(proc, sessionId, cwd).finally(() => this.attaching.delete(sessionId));
      this.attaching.set(sessionId, a);
    }
    return a;
  }
  private async attachNow(proc: AdapterProcess, sessionId: string, cwd: string): Promise<any> {
    let r: any;
    if (proc.caps?.sessionCapabilities?.resume) {
      r = await proc.request('session/resume', { sessionId, cwd, mcpServers: this.mcp(sessionId) });
    } else {
      proc.quiet.add(sessionId);
      try {
        r = await proc.request('session/load', { sessionId, cwd, mcpServers: this.mcp(sessionId) });
      } finally {
        proc.quiet.delete(sessionId);
      }
    }
    proc.loaded.add(sessionId);
    return r;
  }

  private async session(p: { harness: string; sessionId: string; cwd: string }): Promise<AdapterProcess> {
    const proc = await this.started(p.harness);
    await this.attach(proc, p.sessionId, p.cwd);
    this.sessionHarness.set(p.sessionId, p.harness);
    return proc;
  }

  async prompt(p: { harness: string; sessionId: string; cwd: string; prompt: any[] }) {
    if (!Array.isArray(p.prompt) || !p.prompt.length) throw new RpcError(ERR.invalid, 'Nothing to send');
    const proc = await this.session(p);
    const topic = 'session:' + p.sessionId;
    this.busy.set(p.sessionId, (this.busy.get(p.sessionId) ?? 0) + 1);
    proc.request('session/prompt', { sessionId: p.sessionId, prompt: p.prompt }).then(
      (r) => this.emit(topic, { kind: 'turn', data: { stopReason: r?.stopReason ?? 'end_turn', usage: r?.usage ?? null } }),
      (e) => this.emit(topic, { kind: 'error', data: { message: e.message ?? String(e) } }),
    ).finally(() => {
      const n = (this.busy.get(p.sessionId) ?? 1) - 1;
      if (n > 0) this.busy.set(p.sessionId, n);
      else this.busy.delete(p.sessionId);
    });
    return { ok: true };
  }

  /** A new title from the agent, out of sight: Claude Code's /rename with no name makes one from the
   *  conversation; its turn is kept out of the session's log, and the title comes back from session/list. */
  async retitle(p: { harness: string; sessionId: string; cwd: string }) {
    if (p.harness !== 'claude-code') throw new RpcError(ERR.invalid, 'Only Claude Code can name a session');
    if (this.busy.has(p.sessionId)) throw new RpcError(ERR.invalid, 'Wait until the agent is done');
    const proc = await this.session(p);
    proc.quiet.add(p.sessionId);
    try {
      await proc.request('session/prompt', { sessionId: p.sessionId, prompt: [{ type: 'text', text: '/rename' }] });
    } finally {
      proc.quiet.delete(p.sessionId);
    }
    const r = await proc.request('session/list', { cwd: p.cwd }).catch(() => null);
    // (It answers a slug, "plan-kyoto-spring-trip": as words, "Plan kyoto spring trip".)
    const slug: string | null = (r?.sessions ?? []).find((s: any) => s.sessionId === p.sessionId)?.title ?? null;
    const words = slug && /^[\w-]+$/.test(slug) ? slug.replace(/-+/g, ' ').trim() : slug;
    const title = words ? words[0].toUpperCase() + words.slice(1) : null;
    if (!title) throw new RpcError(ERR.internal, 'Claude Code gave no title');
    this.emit('session:' + p.sessionId, { kind: 'update', data: { sessionUpdate: 'session_info_update', title } });
    return { title };
  }

  async cancel(p: { harness: string; sessionId: string; cwd: string }) {
    const proc = this.procs.get(p.harness);
    for (const [id, a] of this.approvals) {
      if (a.approval.sessionId === p.sessionId) this.settle(id, null, null);
    }
    if (proc?.running && proc.loaded.has(p.sessionId)) proc.notify('session/cancel', { sessionId: p.sessionId });
    return { ok: true };
  }

  /** Stops one background task, leaving the turn that started it running. */
  async stopTask(p: { harness: string; sessionId: string; taskId: string }) {
    const proc = this.procs.get(p.harness);
    if (!proc?.running || !proc.loaded.has(p.sessionId)) throw new RpcError(ERR.notFound, 'That task is gone');
    await proc.request('_session/async_task/stop', { sessionId: p.sessionId, asyncTaskId: p.taskId });
    return { ok: true };
  }

  answer(p: { approvalId: string; optionId: string | null }, caller: Caller) {
    const a = this.approvals.get(p.approvalId);
    if (!a) throw new RpcError(ERR.notFound, 'That approval was already answered');
    if (p.optionId !== null && !a.approval.options.some((o) => o.optionId === p.optionId)) throw new RpcError(ERR.invalid, 'Not one of the options');
    this.settle(p.approvalId, p.optionId, caller.username);
    return { ok: true };
  }

  private settle(id: string, optionId: string | null, by: string | null) {
    const a = this.approvals.get(id);
    if (!a) return;
    this.approvals.delete(id);
    a.resolve(optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId });
    this.emit('session:' + a.approval.sessionId, { kind: 'answer', data: { approvalId: id, optionId, by } });
  }

  async setMode(p: { harness: string; sessionId: string; cwd: string; modeId: string }) {
    const proc = await this.session(p);
    await proc.request('session/set_mode', { sessionId: p.sessionId, modeId: p.modeId });
    this.emit('session:' + p.sessionId, { kind: 'update', data: { sessionUpdate: 'current_mode_update', currentModeId: p.modeId } });
    return { ok: true };
  }

  async setModel(p: { harness: string; sessionId: string; cwd: string; modelId: string }) {
    const proc = await this.session(p);
    await proc.request('session/set_model', { sessionId: p.sessionId, modelId: p.modelId });
    return { ok: true };
  }

  async setConfig(p: { harness: string; sessionId: string; cwd: string; configId: string; value: any }) {
    const proc = await this.session(p);
    const r = await proc.request('session/set_config_option', { sessionId: p.sessionId, configId: p.configId, value: p.value });
    if (r?.configOptions) this.emit('session:' + p.sessionId, { kind: 'update', data: { sessionUpdate: 'config_option_update', configOptions: r.configOptions } });
    return { ok: true, configOptions: r?.configOptions };
  }

  async close(p: { harness: string; sessionId: string }) {
    const proc = this.procs.get(p.harness);
    for (const [id, a] of this.approvals) if (a.approval.sessionId === p.sessionId) this.settle(id, null, null);
    if (proc?.running && proc.loaded.has(p.sessionId)) {
      if (proc.caps?.sessionCapabilities?.close) await proc.request('session/close', { sessionId: p.sessionId }).catch(() => {});
      proc.loaded.delete(p.sessionId);
    }
    this.sessionHarness.delete(p.sessionId);
    this.endTasks((t) => t.sessionId === p.sessionId, 'The session was closed');
    this.browser?.release(p.sessionId);
    return { ok: true };
  }

  shutdown() {
    for (const p of this.procs.values()) p.stop();
  }
}

// ---- Harness detection ------------------------------------------------------------------------------

const detected = new Map<string, { at: number; info: HarnessInfo }>();

export async function detect(id: string, fresh = false): Promise<HarnessInfo> {
  const cached = detected.get(id);
  if (cached && (!fresh || Date.now() - cached.at < 30_000)) return cached.info;
  const h = HARNESSES.find((x) => x.id === id)!;
  const env = await userEnv();
  const path = Bun.which(h.command, { PATH: env.PATH }) ?? null;
  let version: string | null = null;
  if (path) {
    const r = await run([path, '--version'], { timeout: 10_000 }).catch(() => null);
    version = r?.stdout.trim().split('\n')[0] || null;
  }
  const auth = path ? await authStatus(id, path) : null;
  const info: HarnessInfo = { id: h.id, name: h.name, installed: !!path, path, version, auth };
  detected.set(id, { at: Date.now(), info });
  return info;
}

/** Drops what detect() knows about a harness, so the next look is fresh (after a sign-in, say). */
export function forget(id: string) {
  detected.delete(id);
}

/** Whether a harness is signed in, from its own status command: `claude auth status` (JSON) or `codex login
 * status` (exit code). null when it can't tell. */
async function authStatus(id: string, path: string): Promise<HarnessAuth | null> {
  if (id === 'claude-code') {
    const r = await run([path, 'auth', 'status'], { timeout: 10_000 }).catch(() => null);
    try {
      const j = JSON.parse(r?.stdout ?? '');
      return { signedIn: !!j.loggedIn, account: j.loggedIn ? (j.email ?? null) : null };
    } catch {
      return null;
    }
  }
  if (id === 'codex') {
    const r = await run([path, 'login', 'status'], { timeout: 10_000 }).catch(() => null);
    if (!r) return null;
    const text = `${r.stdout}\n${r.stderr}`.trim();
    return { signedIn: r.code === 0 && !/not logged in/i.test(text), account: null };
  }
  return null;
}

/** A promise, or an error once ms have passed without it settling. */
function withTimeout<T>(ms: number, message: string, p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([p, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new RpcError(ERR.internal, message)), ms); })]).finally(() => clearTimeout(timer));
}
