// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Approval, type Caller, ERR, HARNESSES, type HarnessAuth, type HarnessInfo, type LocalSession } from '@coderail/protocol';
import { appendFileSync, existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { adapterPath } from './adapters';
import type { McpServer } from './browser';
import { HOME, RpcError, STATE_DIR, VERSION, log, run, userEnv } from './env';
import { checkPath } from './scope';
import { platform } from './platform';
import type { spawnStream } from './platform/win32/stream';
import { appended, forkTail, forksOf, hungOff, mirrored, sizeOf, tipOf, transcriptPath, uuidsOf } from './transcripts';

// Agents over ACP: one adapter process per harness, shared by all its sessions. The adapter runs the
// machine's own `claude` / `codex` with the machine's own login and config; CodeRail only relays.

type Emit = (topic: string, data: any) => void;

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
}

class AdapterProcess {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private managed: Awaited<ReturnType<typeof spawnStream>> | null = null;
  private expectedExit = false;
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
      this.expectedExit = false;
      if (platform.process.spawnManaged) this.managed = await platform.process.spawnManaged([process.execPath, script], { env: childEnv, cwd: env.HOME, keepBun: true });
      else this.proc = platform.process.spawn([process.execPath, script], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        env: childEnv,
        cwd: env.HOME,
      });
      const child = this.managed ?? this.proc!;
      this.readLines(child.stdout as ReadableStream<Uint8Array>, (line) => this.onLine(line));
      this.readLines(child.stderr as ReadableStream<Uint8Array>, (line) => {
        if (process.env.CODERAIL_DEBUG) log(`[${this.harness}] ${line}`);
      });
      child.exited.then((code) => {
        log(`${this.harness} adapter exited (${code})`);
        // (One that failed to start and was replaced: the new one is not its to clear.)
        if ((this.managed ?? this.proc) !== child) return;
        this.proc = null;
        this.managed = null;
        this.ready = null;
        this.loaded.clear();
        for (const p of this.pending.values()) p.reject(new RpcError(ERR.internal, `${this.harness} stopped`));
        this.pending.clear();
        if (!this.expectedExit) this.onExit();
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
      this.stop();
      throw e;
    }
  }

  get running() {
    return !!(this.proc ?? this.managed);
  }

  stop() {
    if (this.managed) { this.expectedExit = true; this.managed.stop(); }
    if (this.proc) platform.process.stopLegacy(this.proc, 'agent');
  }

  async stopAndWait() {
    const exited = (this.managed ?? this.proc)?.exited;
    this.stop(); if (exited) await exited;
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
    if (this.managed) { this.managed.write(JSON.stringify(msg) + '\n'); return; }
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

/** A Claude Code session the bridge has loaded, followed in its transcript: another client may go on with it. */
interface Follow {
  harness: string;
  cwd: string;
  file: string | null;
  /** Up to where the transcript is in CodeRail's log (the bridge's own turns, or what it caught up on). */
  shown: number;
  /** The size at the last look, and since when it has stayed so: a turn being written is left until it's done. */
  size: number;
  quietSince: number;
  /** The adapter's session is behind the transcript: it is loaded afresh before the next prompt. */
  stale: boolean;
  running: Promise<void> | null;
  /** Forks another client made (see transcripts.ts): those changed after this, and the size each was taken at. */
  since: number;
  forks: Map<string, number>;
}

/** How often followed transcripts are looked at; how long a turn that did not end may stay quiet before it is taken
 *  as done (an interrupted one); and how recent a write must be for a turn to count as going on elsewhere. */
const FOLLOW_EVERY = 2_000;
const FOLLOW_GIVE_UP = 30_000;
const FOLLOW_LIVE = 15_000;
const FOLLOWS_PATH = join(STATE_DIR, 'follows.json');
/** Harnesses whose adapter queues a prompt sent mid-turn itself (claude-agent-acp's turnQueue). */
const QUEUES_ITSELF = new Set(['claude-code']);

export class Agents {
  private procs = new Map<string, AdapterProcess>();
  private approvals = new Map<string, PendingApproval>();
  private busy = new Map<string, number>(); // sessionId -> prompts in flight
  /** The last prompt's turn, by session: the next prompt waits for it (harnesses not in QUEUES_ITSELF). */
  private turns = new Map<string, Promise<void>>();
  /** Stops asked for, by session: a held-back prompt from before a Stop is dropped. */
  private stops = new Map<string, number>();
  private sessionHarness = new Map<string, string>();
  private recoveries = new Map<string, Promise<void>>();
  private cancelling = new Set<string>();
  private stopping = false;
  private nextApproval = 1;
  private follows = new Map<string, Follow>();
  private followTimer: ReturnType<typeof setInterval> | null = null;
  /** Sessions the bridge is writing to outside a prompt (a retitle): not another client's writes. */
  private writing = new Set<string>();
  private claudeDir: string | null = null;
  private followsChanged = false;

  /** browser: the chat's browser as an MCP server for each session (Browsers.mcpServer, bindKey). */
  constructor(private emit: Emit, private browser?: { mcpServer(sessionId?: string): { server: McpServer; key: string }; bindKey(key: string, sessionId: string): void; release(key: string): void }) {
    this.restoreFollows();
  }

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

  private processKey(harness: string, sessionId?: string) {
    return platform.os === 'win32' ? `${harness}:${sessionId ?? '_discovery'}` : harness;
  }

  private proc(harness: string, sessionId?: string): AdapterProcess {
    if (!HARNESSES.some((h) => h.id === harness)) throw new RpcError(ERR.invalid, `Unknown harness ${harness}`);
    const key = this.processKey(harness, sessionId);
    let p = this.procs.get(key);
    if (!p) {
      p = new AdapterProcess(
        harness,
        (method, params) => this.fromAgent(harness, method, params),
        (method, params) => this.agentNotice(harness, method, params),
        () => this.adapterExited(harness, p!),
      );
      this.procs.set(key, p);
    }
    return p;
  }

  private async started(harness: string, sessionId?: string): Promise<AdapterProcess> {
    if (this.stopping) throw new RpcError(ERR.internal, 'Bridge is shutting down');
    const p = this.proc(harness, sessionId);
    await p.start();
    return p;
  }

  private adapterExited(harness: string, proc: AdapterProcess) {
    for (const [id, a] of this.approvals) {
      if (a.approval.harness !== harness) continue;
      if (platform.os === 'win32' && this.procs.get(this.processKey(harness, a.approval.sessionId)) !== proc) continue;
      this.approvals.delete(id);
      this.emit('session:' + a.approval.sessionId, { kind: 'answer', data: { approvalId: id, optionId: null, by: null } });
    }
    // (A turn that was running reports the stop itself: its prompt's request fails.)
    this.endTasks((t) => t.harness === harness && (platform.os !== 'win32' || this.procs.get(this.processKey(harness, t.sessionId)) === proc), `${harness} stopped`);
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

  // ---- Another client on the same session ----------------------------------------------------------------
  // A Claude Code session lives in its transcript, which the Claude app or a terminal can resume too. The bridge
  // follows the transcripts of the sessions it has loaded: what another client appends goes to CodeRail's log once
  // its turn is done, and the adapter, whose session would answer from where it last was, loads it afresh before
  // the next prompt. Only one client should run a turn at a time: a prompt while another is mid-turn is refused.

  /** Starts following a session, from where its transcript is now. */
  private async follow(harness: string, sessionId: string, cwd: string) {
    if (harness !== 'claude-code' || this.follows.has(sessionId)) return;
    if (!this.claudeDir) this.claudeDir = (await userEnv()).CLAUDE_CONFIG_DIR || join(HOME, '.claude');
    if (this.follows.has(sessionId)) return;
    const file = transcriptPath(this.claudeDir, cwd, sessionId);
    const size = file ? Math.max(sizeOf(file), 0) : 0;
    // (A fork newer than the session's own last write has turns it lacks, made while CodeRail was not following.)
    let since = 0;
    try { if (file) since = statSync(file).mtimeMs; } catch {}
    this.follows.set(sessionId, { harness, cwd, file, shown: size, size, quietSince: Date.now(), stale: false, running: null, since, forks: new Map() });
    this.followsChanged = true;
    this.followTimer ??= setInterval(() => this.lookAtFollowed(), FOLLOW_EVERY);
  }

  /** The followed sessions, kept across restarts: CodeRail shows a session's history without the bridge, so after a
   *  restart the bridge would otherwise hear of a session only at its next prompt. */
  private restoreFollows() {
    let saved: Record<string, { harness: string; cwd: string; file: string | null; shown: number; since: number }>;
    try { saved = JSON.parse(readFileSync(FOLLOWS_PATH, 'utf8')); } catch { return; }
    for (const [sessionId, s] of Object.entries(saved ?? {})) {
      if (s?.harness !== 'claude-code' || typeof s.cwd !== 'string' || typeof s.shown !== 'number') continue;
      if (s.file && sizeOf(s.file) < 0) continue; // (Its transcript is gone.)
      this.follows.set(sessionId, { harness: s.harness, cwd: s.cwd, file: s.file ?? null, shown: s.shown, size: s.shown, quietSince: Date.now(), stale: false, running: null, since: s.since ?? 0, forks: new Map() });
    }
    if (!this.follows.size) return;
    log(`following ${this.follows.size} session(s) from before`);
    void userEnv().then((env) => { this.claudeDir ??= env.CLAUDE_CONFIG_DIR || join(HOME, '.claude'); }, () => {});
    this.followTimer ??= setInterval(() => this.lookAtFollowed(), FOLLOW_EVERY);
  }

  private saveFollows() {
    this.followsChanged = false;
    const out: Record<string, { harness: string; cwd: string; file: string | null; shown: number; since: number }> = {};
    for (const [sessionId, f] of this.follows) out[sessionId] = { harness: f.harness, cwd: f.cwd, file: f.file, shown: f.shown, since: f.since };
    try {
      platform.fs.ensurePrivateDirectory(STATE_DIR);
      platform.fs.writePrivateFile(FOLLOWS_PATH, JSON.stringify(out) + '\n');
    } catch (e: any) {
      log(`saving the followed sessions: ${e?.message ?? e}`);
    }
  }

  /** What the bridge itself wrote is in CodeRail's log already. */
  private wrote(sessionId: string) {
    const f = this.follows.get(sessionId);
    if (!f) return;
    if (!f.file && this.claudeDir) f.file = transcriptPath(this.claudeDir, f.cwd, sessionId);
    if (!f.file) return;
    f.shown = f.size = Math.max(sizeOf(f.file), 0);
    f.quietSince = Date.now();
    this.followsChanged = true;
    try { this.giveToFork(sessionId, f); } catch (e: any) { log(`giving ${sessionId} to its fork: ${e?.message ?? e}`); }
  }

  /** The other way: the fork another client goes on in (the Claude app keeps to its fork once it made one) gets the
   *  session's conversation, CodeRail's turns and all, so that client has them when it loads the session again.
   *  The newest fork only, never while it is mid-turn. */
  private giveToFork(sessionId: string, f: Follow) {
    if (!f.file) return;
    let fork: string | null = null;
    let newest = 0;
    for (const c of forksOf(f.file, sessionId, f.since)) {
      if (this.follows.has(basename(c, '.jsonl'))) continue;
      let mtime = 0;
      try { mtime = statSync(c).mtimeMs; } catch { continue; }
      if (mtime > newest) { newest = mtime; fork = c; }
    }
    if (!fork) return;
    const forkId = basename(fork, '.jsonl');
    const size = sizeOf(fork);
    // (Turns of its own the session hasn't taken yet: those first, or they'd be left off the conversation.)
    if (forkTail(fork, uuidsOf(f.file), sessionId).lines.length) return;
    const text = mirrored(fork, f.file, forkId);
    if (text === null) return;
    if (Date.now() - newest < FOLLOW_LIVE && !appended(fork, 0).turnDone) {
      log(`${sessionId}: not given to ${forkId}: another client is mid-turn in it`);
      return;
    }
    // (Rewritten whole: once the two went on from different messages, appending can't make the fork's conversation
    // the session's. Only if the other client wrote nothing meanwhile.)
    if (sizeOf(fork) !== size) return;
    const tmp = fork + '.coderail-tmp';
    writeFileSync(tmp, text);
    try { renameSync(tmp, fork); } catch { writeFileSync(fork, text); rmSync(tmp, { force: true }); }
    // (Nothing in it now that the session lacks: no need to look at it again for that.)
    f.forks.set(fork, sizeOf(fork));
    log(`${sessionId}: the conversation given to ${forkId}, the fork another client goes on in`);
  }

  /** Puts the turns another client made in a fork of the session (the Claude app's resume) in the session's
   *  transcript, once each such turn is done. Whether a fork is mid-turn, written to in the last `liveMs`. */
  private takeForks(sessionId: string, f: Follow, liveMs = FOLLOW_GIVE_UP): boolean {
    if (!f.file) return false;
    let live = false;
    let took = false;
    let have: Set<string> | null = null;
    for (const fork of forksOf(f.file, sessionId, f.since)) {
      const forkId = basename(fork, '.jsonl');
      if (this.follows.has(forkId)) continue; // (Open in CodeRail as a session of its own.)
      const size = sizeOf(fork);
      if (f.forks.get(fork) === size) continue;
      have ??= uuidsOf(f.file);
      const t = forkTail(fork, have, sessionId);
      if (!t.lines.length) { f.forks.set(fork, size); continue; }
      let mtime = 0;
      try { mtime = statSync(fork).mtimeMs; } catch {}
      if (!t.turnDone && Date.now() - mtime < liveMs) { live = true; continue; }
      f.forks.set(fork, size);
      // (A fork from an earlier point, the other client not having loaded CodeRail's turns: what it said goes after
      // them, so that the conversation has both.)
      const tip = tipOf(f.file);
      if (t.parent !== tip) log(`${sessionId}: ${forkId} went on from an earlier message than CodeRail's last: its turns go after CodeRail's`);
      appendFileSync(f.file, [...hungOff(t, tip), ...(t.lastPrompt ? [t.lastPrompt] : [])].join('\n') + '\n');
      for (const u of t.uuids) have.add(u);
      log(`${sessionId}: ${t.lines.length} transcript lines from ${forkId}, a fork another client made`);
      took = true;
    }
    // (And back: the fork's conversation made the session's, CodeRail's turns before its own included.)
    if (took) try { this.giveToFork(sessionId, f); } catch (e: any) { log(`giving ${sessionId} to its fork: ${e?.message ?? e}`); }
    return live;
  }

  private lookAtFollowed() {
    for (const [sessionId, f] of this.follows) {
      if (!f.file || f.running || this.busy.has(sessionId) || this.writing.has(sessionId)) continue;
      if (this.recoveries.has(this.processKey(f.harness, sessionId))) continue;
      try { this.takeForks(sessionId, f); } catch (e: any) { log(`forks of ${sessionId}: ${e?.message ?? e}`); }
      const size = sizeOf(f.file);
      if (size === f.shown) continue;
      if (size !== f.size) { f.size = size; f.quietSince = Date.now(); continue; }
      if (!appended(f.file, f.shown).turnDone && Date.now() - f.quietSince < FOLLOW_GIVE_UP) continue;
      f.running = this.catchUp(sessionId, f)
        .catch((e) => log(`catching up on ${sessionId}: ${e?.message ?? e}`))
        .finally(() => { f.running = null; });
    }
    if (this.followsChanged) this.saveFollows();
  }

  /** Puts what another client appended to the transcript in CodeRail's log: the adapter replays the session from
   *  the transcript, and the replay from the first of the new messages goes out. */
  private async catchUp(sessionId: string, f: Follow) {
    if (!f.file) return;
    const size = sizeOf(f.file);
    if (size < f.shown) { f.shown = f.size = Math.max(size, 0); f.stale = true; return; } // (Rewritten: nothing to add.)
    const a = appended(f.file, f.shown);
    f.shown = a.end;
    this.followsChanged = true;
    if (!a.ids.size) return;
    f.stale = true;
    // (An adapter that went away loads the session afresh: it is then not behind.)
    const loaded = this.procs.get(this.processKey(f.harness, sessionId));
    const proc = loaded?.running && loaded.loaded.has(sessionId) ? loaded : await this.session({ harness: f.harness, sessionId, cwd: f.cwd });
    if (proc !== loaded) f.stale = false;
    if (!proc.caps?.loadSession) return;
    const replay: any[] = [];
    proc.collecting.set(sessionId, replay);
    try {
      await proc.request('session/load', { sessionId, cwd: f.cwd, mcpServers: this.mcp(sessionId) });
    } finally {
      proc.collecting.delete(sessionId);
    }
    const from = replay.findIndex((u) => a.ids.has(u?.messageId));
    if (from < 0) return;
    log(`${sessionId}: ${replay.length - from} updates from another client`);
    for (const u of replay.slice(from)) this.emit('session:' + sessionId, { kind: 'update', data: u });
  }

  /** Before a prompt: CodeRail's log and the adapter's session caught up with the transcript, unless another client
   *  is mid-turn in it. */
  private async catchUpFirst(p: { harness: string; sessionId: string; cwd: string }) {
    const f = this.follows.get(p.sessionId);
    if (!f) return;
    await f.running;
    // (Until the prompt is under way, the timer leaves the session to this.)
    this.writing.add(p.sessionId);
    try { await this.catchUpBefore(p, f); }
    finally { this.writing.delete(p.sessionId); }
  }

  private async catchUpBefore(p: { harness: string; sessionId: string; cwd: string }, f: Follow) {
    if (f.file && this.takeForks(p.sessionId, f, FOLLOW_LIVE)) {
      throw new RpcError(ERR.invalid, 'This session is running in another app right now: send once its turn is done');
    }
    if (f.file) {
      const size = sizeOf(f.file);
      if (size !== f.shown) {
        const a = appended(f.file, f.shown);
        let mtime = 0;
        try { mtime = statSync(f.file).mtimeMs; } catch {}
        if (a.ids.size && !a.turnDone && Date.now() - mtime < FOLLOW_LIVE) {
          throw new RpcError(ERR.invalid, 'This session is running in another app right now: send once its turn is done');
        }
        await this.catchUp(p.sessionId, f);
      }
    }
    if (!f.stale) return;
    const proc = this.procs.get(this.processKey(p.harness, p.sessionId));
    if (proc?.running && proc.loaded.has(p.sessionId)) {
      if (platform.os === 'win32') {
        // (The session's own adapter: the next attach starts it again, on the transcript as it is now.)
        await proc.stopAndWait();
      } else if (proc.caps?.sessionCapabilities?.close) {
        await proc.request('session/close', { sessionId: p.sessionId }).catch(() => {});
        proc.loaded.delete(p.sessionId);
      } else {
        log(`${p.sessionId}: the ${p.harness} adapter can't reload one session; it may answer without the other client's turns`);
      }
    }
    f.stale = false;
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
    // (On Windows each session has its adapter: it starts under a key of its own until the session's id is known.)
    const initial = `new:${crypto.randomUUID()}`;
    const proc = await this.started(p.harness, initial);
    // (A new session's id comes with the answer: its browser key is bound to it then.)
    const b = this.browser?.mcpServer();
    let r: any;
    try { r = await proc.request('session/new', { cwd, mcpServers: b ? [b.server] : [] }); }
    catch (error) {
      if (b) this.browser!.release(b.key);
      if (platform.os === 'win32') { await proc.stopAndWait(); this.procs.delete(this.processKey(p.harness, initial)); }
      throw error;
    }
    if (b) this.browser!.bindKey(b.key, r.sessionId);
    if (platform.os === 'win32') {
      this.procs.delete(this.processKey(p.harness, initial));
      this.procs.set(this.processKey(p.harness, r.sessionId), proc);
    }
    proc.loaded.add(r.sessionId);
    this.sessionHarness.set(r.sessionId, p.harness);
    await this.follow(p.harness, r.sessionId, cwd);
    return { sessionId: r.sessionId, harness: p.harness, cwd, title: null, modes: r.modes, models: r.models, configOptions: r.configOptions };
  }

  /** Bring back a session from the harness's own history. `known`: CodeRail already has its log. */
  async open(p: { harness: string; sessionId: string; cwd: string; known?: boolean }, caller: Caller, after: (send: () => void) => void) {
    const cwd = await checkPath(p.cwd, caller);
    if (!p.known && caller.folders) {
      // A session CodeRail has never seen: the folder the harness has it in must be the caller's, not just the
      // folder they named (session ids can be global to a harness).
      const theirs = (await this.local({ harness: p.harness }, caller)).find((s) => s.sessionId === p.sessionId);
      if (!theirs?.cwd || !await checkPath(theirs.cwd, caller).then(() => true, () => false)) {
        throw new RpcError(ERR.forbidden, 'That session is outside your folders');
      }
    }
    await this.recoveries.get(this.processKey(p.harness, p.sessionId));
    await this.follow(p.harness, p.sessionId, cwd);
    const proc = await this.started(p.harness, p.sessionId);
    let replay: any[] = [];
    let r: any = {};
    try {
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
    } catch (error) {
      await this.dropUnloaded(p.harness, p.sessionId, proc);
      throw error;
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
    await this.recoveries.get(this.processKey(p.harness, p.sessionId));
    await this.follow(p.harness, p.sessionId, p.cwd);
    const proc = await this.started(p.harness, p.sessionId);
    try { await this.attach(proc, p.sessionId, p.cwd); }
    catch (error) { await this.dropUnloaded(p.harness, p.sessionId, proc); throw error; }
    this.sessionHarness.set(p.sessionId, p.harness);
    return proc;
  }

  /** On Windows a session's adapter is its alone: one that could not load it (Codex has it open in another client)
   *  is stopped, not left running with nothing loaded. */
  private async dropUnloaded(harness: string, sessionId: string, proc: AdapterProcess) {
    if (platform.os !== 'win32' || proc.loaded.has(sessionId)) return;
    await proc.stopAndWait();
    const key = this.processKey(harness, sessionId);
    if (this.procs.get(key) === proc) this.procs.delete(key);
  }

  async prompt(p: { harness: string; sessionId: string; cwd: string; prompt: any[] }) {
    if (!Array.isArray(p.prompt) || !p.prompt.length) throw new RpcError(ERR.invalid, 'Nothing to send');
    await this.follow(p.harness, p.sessionId, p.cwd);
    await this.catchUpFirst(p);
    let proc = await this.session(p);
    const topic = 'session:' + p.sessionId;
    this.busy.set(p.sessionId, (this.busy.get(p.sessionId) ?? 0) + 1);
    // (codex-acp ends the running turn when another prompt comes: the bridge holds that prompt until the turn is
    // done. A Stop drops the prompts held back, as Claude Code's own queue does.)
    const before = QUEUES_ITSELF.has(p.harness) ? undefined : this.turns.get(p.sessionId);
    const stops = this.stops.get(p.sessionId) ?? 0;
    const turn = (async () => {
      if (before) {
        await before;
        if ((this.stops.get(p.sessionId) ?? 0) !== stops) return { stopReason: 'cancelled' };
        proc = await this.session(p);
      }
      return proc.request('session/prompt', { sessionId: p.sessionId, prompt: p.prompt });
    })();
    const done = turn.then(
      (r) => this.emit(topic, { kind: 'turn', data: { stopReason: r?.stopReason ?? 'end_turn', usage: r?.usage ?? null } }),
      (e) => this.cancelling.has(p.sessionId)
        ? this.emit(topic, { kind: 'turn', data: { stopReason: 'cancelled', usage: null } })
        : this.emit(topic, { kind: 'error', data: { message: e.message ?? String(e) } }),
    ).finally(() => {
      if (this.turns.get(p.sessionId) === done) this.turns.delete(p.sessionId);
      const n = (this.busy.get(p.sessionId) ?? 1) - 1;
      if (n > 0) this.busy.set(p.sessionId, n);
      else { this.busy.delete(p.sessionId); this.wrote(p.sessionId); }
    });
    if (!QUEUES_ITSELF.has(p.harness)) this.turns.set(p.sessionId, done);
    return { ok: true };
  }

  /** A new title from the agent, out of sight: Claude Code's /rename with no name makes one from the
   *  conversation; its turn is kept out of the session's log, and the title comes back from session/list. */
  async retitle(p: { harness: string; sessionId: string; cwd: string }) {
    if (p.harness !== 'claude-code') throw new RpcError(ERR.invalid, 'Only Claude Code can name a session');
    if (this.busy.has(p.sessionId)) throw new RpcError(ERR.invalid, 'Wait until the agent is done');
    await this.follow(p.harness, p.sessionId, p.cwd);
    await this.catchUpFirst(p);
    const proc = await this.session(p);
    proc.quiet.add(p.sessionId);
    this.writing.add(p.sessionId);
    try {
      await proc.request('session/prompt', { sessionId: p.sessionId, prompt: [{ type: 'text', text: '/rename' }] });
    } finally {
      proc.quiet.delete(p.sessionId);
      this.writing.delete(p.sessionId);
      this.wrote(p.sessionId);
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
    const key = this.processKey(p.harness, p.sessionId);
    this.stops.set(p.sessionId, (this.stops.get(p.sessionId) ?? 0) + 1);
    if (this.recoveries.has(key)) { await this.recoveries.get(key); return { ok: true }; }
    const proc = this.procs.get(key);
    for (const [id, a] of this.approvals) {
      if (a.approval.sessionId === p.sessionId) this.settle(id, null, null);
    }
    if (proc?.running && proc.loaded.has(p.sessionId)) proc.notify('session/cancel', { sessionId: p.sessionId });
    if (platform.os === 'win32' && proc?.running) {
      this.cancelling.add(p.sessionId);
      const recovery = (async () => {
        await Bun.sleep(500);
        // Every session owns its runtime Job. Closing it cannot affect another session.
        await proc.stopAndWait();
        if (this.stopping) return;
        await proc.start(); await this.attach(proc, p.sessionId, p.cwd);
      })();
      this.recoveries.set(key, recovery);
      try { await recovery; }
      finally { this.recoveries.delete(key); this.cancelling.delete(p.sessionId); }
    }
    return { ok: true };
  }

  /** Stops one background task, leaving the turn that started it running. */
  async stopTask(p: { harness: string; sessionId: string; taskId: string }) {
    const proc = this.procs.get(this.processKey(p.harness, p.sessionId));
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
    const key = this.processKey(p.harness, p.sessionId);
    // (Prompts held back for it are dropped, not sent to an adapter started for it again.)
    this.stops.set(p.sessionId, (this.stops.get(p.sessionId) ?? 0) + 1);
    await this.recoveries.get(key);
    const proc = this.procs.get(key);
    for (const [id, a] of this.approvals) if (a.approval.sessionId === p.sessionId) this.settle(id, null, null);
    if (platform.os === 'win32' && proc) {
      await proc.stopAndWait(); this.procs.delete(key);
    } else if (proc?.running && proc.loaded.has(p.sessionId)) {
      if (proc.caps?.sessionCapabilities?.close) await proc.request('session/close', { sessionId: p.sessionId }).catch(() => {});
      proc.loaded.delete(p.sessionId);
    }
    this.sessionHarness.delete(p.sessionId);
    if (this.follows.delete(p.sessionId)) this.saveFollows();
    this.endTasks((t) => t.sessionId === p.sessionId, 'The session was closed');
    this.browser?.release(p.sessionId);
    return { ok: true };
  }

  shutdown() {
    this.stopping = true;
    if (this.followTimer) clearInterval(this.followTimer);
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
  const path = platform.shell.findExecutable(h.command, env);
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
