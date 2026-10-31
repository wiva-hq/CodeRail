// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// One machine's WebSocket (protocol/src/index.ts): requests and answers by id, events on subscribed topics, a ping
// every 25 s, reconnect with backoff. On every (re)connect it subscribes to "machine" and every topic a view holds,
// reads machine.info, the sessions and the pending approvals again, and tells its listeners (`onReconnect`), so open
// sessions read what they missed and terminals attach again.
import type { AgentTask, Approval, LogEntry, MachineEvent, MachineInfo, Scope, SessionRow, TerminalInfo } from '@coderail/protocol';
import { atLeast } from '@coderail/protocol';
import { Folder, type Item } from './transcript';

export class RpcFail extends Error {
  constructor(public code: number, message: string) { super(message); }
}

type Pending = { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> };

export function wsUrl(id: string) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/api/machines/${encodeURIComponent(id)}/ws`;
}

export class MachineConn {
  /** The socket to the server is open. */
  connected = $state(false);
  /** Ever opened (the first read is done). */
  ready = $state(false);
  /** The bridge on the computer is connected. */
  online = $state(false);
  info = $state<MachineInfo | null>(null);
  scope = $state<Scope | null>(null);
  sessions = $state<SessionRow[]>([]);
  approvals = $state<Approval[]>([]);
  /** What the agents left running in the background (a backgrounded shell, a subagent). */
  tasks = $state<AgentTask[]>([]);
  terminals = $state<TerminalInfo[]>([]);
  /** What each harness last said about its sign-in (the `auth` machine event's status: `label` is the account). */
  auth = $state<Record<string, any>>({});
  /** Claude's plan usage limits on this computer's login (agent.limits), as the Claude app shows them. */
  limits = $state<PlanLimits | null>(null);
  error = $state<string | null>(null);
  /** Can't open at all (no access, removed). */
  fatal = $state<string | null>(null);

  private ws: WebSocket | null = null;
  private seq = 1;
  private pending = new Map<string | number, Pending>();
  private listeners = new Map<string, Set<(data: any) => void>>();
  /** Topics a view asked for with `subscribe` (sent again after a reconnect). */
  private topics = new Map<string, number>();
  private reconnectFns = new Set<() => void>();
  private downFns = new Set<() => void>();
  private waiters: (() => void)[] = [];
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private ping: ReturnType<typeof setInterval> | null = null;
  private closed = false;
  private views = new Map<string, SessionView>();

  constructor(public id: string) {
    this.open();
  }

  // ---- what the role allows
  get role() { return this.scope?.role ?? 'viewer'; }
  get canOperate() { return !!this.scope && atLeast(this.scope.role, 'operator'); }
  get isOwner() { return this.scope?.role === 'owner'; }
  get canTerminal() { return this.canOperate && !!this.scope?.terminal; }
  /** Running a harness's own sign-in: owners with the terminal grant. */
  get canLogin() { return this.isOwner && !!this.scope?.terminal; }
  /** Live actions need the bridge and a role that drives. */
  get canAct() { return this.online && this.canOperate; }
  harnessAllowed(h: string) { return !this.scope?.harnesses || this.scope.harnesses.includes(h); }

  // ---- the socket
  private open() {
    if (this.closed) return;
    let ws: WebSocket;
    try { ws = new WebSocket(wsUrl(this.id)); } catch (e) { this.error = String(e); this.schedule(); return; }
    this.ws = ws;
    // (Each handler is this socket's alone: one that was replaced (reconnect) goes quiet.)
    ws.onopen = () => {
      if (this.ws !== ws) return void ws.close();
      this.connected = true;
      this.error = null;
      this.retry = 0;
      this.ping = setInterval(() => this.send({ t: 'ping' }), 25_000);
      for (const w of this.waiters.splice(0)) w();
      void this.hello();
    };
    ws.onmessage = (m) => { if (this.ws === ws) this.frame(m.data); };
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      const was = this.connected;
      this.connected = false;
      if (this.ping) clearInterval(this.ping);
      this.ping = null;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new RpcFail(-1, 'Connection lost')); }
      this.pending.clear();
      this.ws = null;
      if (was) for (const f of this.downFns) { try { f(); } catch { /* a view's own */ } }
      // (Refused before it ever opened with a policy close: no access to this machine.)
      if (e.code === 1008 || e.code === 4003 || e.code === 4004) { this.fatal = e.reason || 'You don’t have access to this computer'; return; }
      if (!was && !this.ready) this.error = 'Can’t reach the server';
      this.schedule();
    };
  }
  private schedule() {
    if (this.closed || this.retryTimer) return;
    const wait = Math.min(30_000, 500 * 2 ** this.retry) * (0.75 + Math.random() * 0.5);
    this.retry++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.open(); }, wait);
  }
  /** Try now (a Retry button, the page coming back). */
  reconnect() {
    if (this.connected || this.closed) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.retry = 0;
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.open();
  }
  close() {
    this.closed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.ping) clearInterval(this.ping);
    this.ws?.close();
  }
  private send(f: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(f));
  }
  private async hello() {
    const topics = ['machine', ...this.topics.keys()];
    await this.call('sub', { topics }).catch(() => {});
    await this.refresh();
    this.ready = true;
    for (const f of this.reconnectFns) { try { f(); } catch { /* a view's own */ } }
  }
  /** machine.info, the sessions, the approvals (and the terminals, when allowed). */
  async refresh() {
    try {
      const r = await this.call<{ online: boolean; info: MachineInfo | null; scope: Scope }>('machine.info');
      this.online = r.online;
      this.info = r.info;
      this.scope = r.scope;
    } catch (e) { this.error = (e as Error).message; return; }
    const [s, a, t] = await Promise.all([
      this.call<SessionRow[]>('agent.sessions', {}).catch(() => null),
      this.call<Approval[]>('agent.approvals').catch(() => null),
      this.call<AgentTask[]>('agent.tasks').catch(() => null),
    ]);
    if (s) this.sessions = s;
    if (a) this.approvals = a;
    if (t) this.tasks = t;
    if (this.online && this.canTerminal) this.call<TerminalInfo[]>('term.list').then((t) => (this.terminals = t)).catch(() => {});
  }

  private frame(raw: string) {
    let f: any;
    try { f = JSON.parse(raw); } catch { return; }
    if (f.t === 'res') {
      const p = this.pending.get(f.id);
      if (!p) return;
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      if (f.error) p.reject(new RpcFail(f.error.code, f.error.message));
      else p.resolve(f.result);
    } else if (f.t === 'ev') {
      if (f.topic === 'machine') this.machineEvent(f.data as MachineEvent);
      for (const fn of this.listeners.get(f.topic) ?? []) { try { fn(f.data); } catch (e) { console.error(e); } }
    }
  }

  private machineEvent(e: MachineEvent) {
    switch (e.type) {
      case 'online':
        this.online = e.online;
        if (e.info) this.info = e.info;
        if (e.online) void this.refresh();
        break;
      case 'session': {
        const i = this.sessions.findIndex((s) => s.sessionId === e.session.sessionId);
        if (i >= 0) this.sessions[i] = e.session; else this.sessions = [e.session, ...this.sessions];
        break;
      }
      case 'session_removed':
        this.sessions = this.sessions.filter((s) => s.sessionId !== e.sessionId);
        break;
      case 'approval':
        if (!this.approvals.some((a) => a.id === e.approval.id)) this.approvals = [...this.approvals, e.approval];
        break;
      case 'approval_done':
        this.approvals = this.approvals.filter((a) => a.id !== e.approvalId);
        break;
      case 'task': {
        const i = this.tasks.findIndex((t) => t.id === e.task.id);
        if (i >= 0) this.tasks[i] = e.task; else this.tasks = [...this.tasks, e.task];
        break;
      }
      case 'task_done':
        this.tasks = this.tasks.filter((t) => t.id !== e.taskId);
        break;
      case 'terminal': {
        const i = this.terminals.findIndex((t) => t.id === e.terminal.id);
        if (i >= 0) this.terminals[i] = e.terminal; else this.terminals = [...this.terminals, e.terminal];
        break;
      }
      case 'terminal_closed':
        this.terminals = this.terminals.filter((t) => t.id !== e.id);
        break;
      case 'auth':
        this.auth = { ...this.auth, [e.harness]: e.status };
        break;
    }
  }

  /** A request; waits for the socket (up to 15 s) when it is not open yet. */
  async call<T = any>(method: string, params?: unknown, timeout = 60_000): Promise<T> {
    if (this.fatal) throw new RpcFail(-32003, this.fatal);
    if (!this.connected) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== go); reject(new RpcFail(-1, 'Not connected')); }, 15_000);
        const go = () => { clearTimeout(t); resolve(); };
        this.waiters.push(go);
      });
    }
    const id = this.seq++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new RpcFail(-32011, 'Timed out')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ t: 'req', id, method, params: params ?? {} });
    });
  }

  /** Listens to a topic's events without subscribing (a terminal: `term.attach` subscribes itself). */
  listen(topic: string, fn: (data: any) => void): () => void {
    let set = this.listeners.get(topic);
    if (!set) { set = new Set(); this.listeners.set(topic, set); }
    set.add(fn);
    return () => { set!.delete(fn); if (!set!.size) this.listeners.delete(topic); };
  }
  /** Subscribes to a topic (counted: the last one to leave unsubscribes) and listens to it. */
  subscribe(topic: string, fn: (data: any) => void): () => void {
    const n = this.topics.get(topic) ?? 0;
    this.topics.set(topic, n + 1);
    if (!n && this.connected) this.call('sub', { topics: [topic] }).catch(() => {});
    const off = this.listen(topic, fn);
    return () => {
      off();
      const m = (this.topics.get(topic) ?? 1) - 1;
      if (m > 0) this.topics.set(topic, m);
      else { this.topics.delete(topic); if (this.connected) this.call('unsub', { topics: [topic] }).catch(() => {}); }
    };
  }
  /** The connection dropped (fn: hold what comes next until the view has caught up). */
  onDown(fn: () => void): () => void {
    this.downFns.add(fn);
    return () => this.downFns.delete(fn);
  }
  onReconnect(fn: () => void): () => void {
    this.reconnectFns.add(fn);
    return () => this.reconnectFns.delete(fn);
  }

  // ---- sessions
  session(id: string) { return this.sessions.find((s) => s.sessionId === id); }
  /** A session's transcript, kept while the page lives (opening it again is instant). */
  view(id: string): SessionView {
    let v = this.views.get(id);
    if (!v) { v = new SessionView(this, id); this.views.set(id, v); }
    return v;
  }
  /** Patches a session row locally (a mode or option the harness reported in the stream). */
  patchSession(id: string, f: (s: SessionRow) => void) {
    const i = this.sessions.findIndex((s) => s.sessionId === id);
    if (i >= 0) f(this.sessions[i]);
  }
  pendingFor(sessionId: string) { return this.approvals.filter((a) => a.sessionId === sessionId); }
  /** Reads the plan limits (`fresh`: past the bridge's minute-long cache, after a turn); quietly keeps the last. */
  async loadLimits(fresh = false) {
    if (!this.canAct) return;
    try { this.limits = (await this.call<PlanLimits | null>('agent.limits', { fresh })) ?? this.limits; } catch { /* kept */ }
  }
}

/** One session's log: its history read in pages, then live entries (`session:<id>`) with a seq past the last seen,
 * folded into the transcript's items as they come. */
export interface PlanLimits {
  /** "Max (20x)", "Pro", … */
  plan: string | null;
  windows: { id: string; label: string; used: number; resetsAt: number | null }[];
  at: number;
}

export class SessionView {
  items = $state<Item[]>([]);
  row = $state<SessionRow | null>(null);
  loading = $state(false);
  loaded = $state(false);
  error = $state<string | null>(null);
  /** Slash commands the agent offers (available_commands_update). */
  commands = $state<{ name: string; description?: string }[]>([]);
  /** The context window as last reported (usage_update). */
  usage = $state<{ used?: number; size?: number } | null>(null);
  private last = 0;
  private folder: Folder;
  private off: (() => void) | null = null;
  private offRe: (() => void) | null = null;
  private offDown: (() => void) | null = null;
  private buffer: LogEntry[] | null = null;
  private holders = 0;

  constructor(private conn: MachineConn, public id: string) {
    this.folder = new Folder(this.items);
  }

  /** A view shows it: subscribe, read what is missing. → release. */
  hold(): () => void {
    this.holders++;
    if (this.holders === 1) {
      this.off = this.conn.subscribe(`session:${this.id}`, (e: LogEntry) => this.live(e));
      this.offRe = this.conn.onReconnect(() => void this.load());
      // (From the drop until it has read the history again, live entries wait: one that came first would move
      // `last` past the ones missed meanwhile.)
      this.offDown = this.conn.onDown(() => { this.buffer ??= []; });
      void this.load();
    }
    return () => {
      this.holders--;
      if (this.holders === 0) { this.off?.(); this.offRe?.(); this.offDown?.(); this.off = this.offRe = this.offDown = null; }
    };
  }

  private live(e: LogEntry) {
    // (A Claude Code turn just spent some of the plan: read the limits again.)
    if (e.kind === 'turn' && this.row?.harness === 'claude-code') void this.conn.loadLimits(true);
    if (this.buffer) { this.buffer.push(e); return; }
    this.apply(e);
  }
  private apply(e: LogEntry) {
    if (e.seq <= this.last) return;
    this.last = e.seq;
    this.folder.add(e);
    if (e.kind === 'update') this.sideEffects(e.data);
  }
  /** What a stream update changes beside the transcript: the row's mode, options, title; commands; usage. */
  private sideEffects(u: any) {
    switch (u?.sessionUpdate) {
      case 'available_commands_update': this.commands = u.availableCommands ?? []; break;
      case 'current_mode_update': this.conn.patchSession(this.id, (s) => { if (s.modes) s.modes = { ...s.modes, currentModeId: u.currentModeId }; }); break;
      case 'config_option_update': if (u.configOptions) this.conn.patchSession(this.id, (s) => { s.configOptions = u.configOptions; }); break;
      case 'usage_update': {
        this.usage = { used: u.used ?? u.usage?.used, size: u.size ?? u.usage?.size };
        break;
      }
    }
  }

  async load() {
    if (this.loading) return;
    this.loading = true;
    this.buffer ??= [];
    try {
      // (Frames are capped near 1 MiB: the history comes in pages; `more` says another follows.)
      let more = true, guard = 0;
      while (more && guard++ < 500) {
        const r = await this.conn.call<{ entries: LogEntry[]; session: SessionRow; more?: boolean }>('agent.history', { sessionId: this.id, ...(this.last ? { after: this.last } : {}) });
        this.row = r.session ?? this.row;
        for (const e of r.entries ?? []) this.apply(e);
        more = !!r.more && (r.entries?.length ?? 0) > 0;
      }
      this.error = null;
      this.loaded = true;
    } catch (e) {
      this.error = (e as Error).message;
    } finally {
      const b = this.buffer ?? [];
      this.buffer = null;
      for (const e of b) this.apply(e);
      this.loading = false;
    }
  }
}
