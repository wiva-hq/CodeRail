// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import type { ServerWebSocket } from 'bun';
import {
  type AgentTask,
  type Approval,
  type BridgeInFrame,
  type BridgeOutFrame,
  type Caller,
  ERR,
  type LiveState,
  type LogEntry,
  METHODS,
  type MachineInfo,
  type RpcError,
  type SessionRow,
  type ServerFrame,
  atLeast,
  inFolders,
} from '@coderail/protocol';
import { type Env, now, randomToken } from './util';
import { notifyApproval } from './push';
import { PERFORMANCE } from './db';

// One hub per machine, in this process. It holds the bridge's socket and every client's socket, checks each client
// call against the caller's scope, forwards what the bridge answers, and keeps each agent session's log for replay,
// in a SQLite file of its own.

type ClientAttachment = { kind: 'client'; tag: string; caller: Caller; topics: string[] };
type BridgeAttachment = { kind: 'bridge'; connectedAt: number };
type Attachment = ClientAttachment | BridgeAttachment;
/** A socket on a machine: its hub, its tags (bridge, client, c:<tag>, u:<userId>) and what it is. */
export type SockData = { machine: Machine; tags: string[]; att: Attachment };
export type Sock = ServerWebSocket<SockData>;

/** A hub's SQL: exec(query, ...args) → rows, as the code below was written against. */
class Sql {
  constructor(readonly db: Database) {}
  exec(query: string, ...args: any[]) {
    const rows = this.db.query(query).all(...args.map((a) => (a === undefined ? null : a))) as Record<string, any>[];
    return {
      toArray: () => rows,
      one: () => {
        if (rows.length !== 1) throw new Error(`Expected one row, got ${rows.length}`);
        return rows[0];
      },
    };
  }
}

const LOG_CAP = 20_000; // entries kept per session
const HISTORY_BYTES = 700_000; // per agent.history answer
const REQUEST_TIMEOUT = 120_000;
const AUDITED = new Set([
  'agent.new', 'agent.open', 'agent.prompt', 'agent.answer', 'agent.cancel', 'agent.close', 'agent.forget', 'agent.retitle',
  'term.open', 'harness.login', 'harness.logout', 'browser.open', 'browser.navigate', 'fs.write', 'fs.mkdir', 'fs.rename', 'fs.trash',
  'git.stage', 'git.unstage', 'git.discard', 'git.commit', 'git.checkout', 'git.pull', 'git.push', 'git.fetch',
  'git.discard_lines', 'git.ignore', 'git.undo', 'git.branch_rename', 'git.branch_delete', 'git.merge', 'git.rebase', 'git.continue', 'git.abort',
  'git.resolve', 'git.revert', 'git.cherry_pick', 'git.reset', 'git.tag', 'git.stash', 'git.stash_apply', 'git.stash_drop', 'git.init', 'git.clone',
  'gh.checkout', 'gh.create', 'gh.merge', 'gh.rerun', 'gh.publish',
]);

export class Machine {
  private sql: Sql;
  private socks = new Set<Sock>();
  /** The server's own calls to the bridge (a download), by id: answered in memory, never through a client. */
  private direct = new Map<string, { resolve: (v: any) => void; reject: (e: any) => void; timer: ReturnType<typeof setTimeout> }>();
  private alarmTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly id: string, private env: Env, private path: string) {
    this.sql = new Sql(new Database(path, { create: true }));
    this.sql.db.exec(PERFORMANCE);
    this.sql.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, harness TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT, state TEXT NOT NULL,
        created_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        modes TEXT, models TEXT, config TEXT
      );
      CREATE TABLE IF NOT EXISTS log (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS log_session ON log(session, seq);
      CREATE TABLE IF NOT EXISTS approvals (id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending (
        id TEXT PRIMARY KEY, client TEXT NOT NULL, client_id TEXT NOT NULL, method TEXT NOT NULL, params TEXT, caller TEXT, at INTEGER NOT NULL
      );
    `);
    this.setMeta('id', id);
    // (Requests a restart left waiting: answered as timed out once their time is up.)
    if (this.sql.exec('SELECT 1 FROM pending LIMIT 1').toArray().length) void this.armTimeout();
  }

  // ---- Entry points from the routes -------------------------------------------------------------------

  /** A socket upgraded for this machine: the bridge (any older one is replaced) or a client. */
  open(ws: Sock) {
    if (ws.data.att.kind === 'bridge') for (const old of this.sockets('bridge')) if (old !== ws) old.close(4000, 'Replaced by a new connection');
    this.socks.add(ws);
  }

  /** The socket data for a bridge or client about to connect (main.ts upgrades the request with it). */
  bridgeData(): SockData {
    return { machine: this, tags: ['bridge'], att: { kind: 'bridge', connectedAt: now() } };
  }
  /** auth: the hash of the sign-in it was opened with (a:<hash>), so a sign-out can close it. */
  clientData(caller: Caller, auth: string): SockData {
    const tag = 'c:' + randomToken(9);
    return { machine: this, tags: ['client', tag, 'u:' + caller.userId, 'a:' + auth], att: { kind: 'client', tag, caller, topics: [] } };
  }

  /** The sign-ins its clients were opened with. */
  auths(): string[] {
    return [...new Set(this.sockets('client').flatMap((ws) => ws.data.tags.filter((t) => t.startsWith('a:')).map((t) => t.slice(2))))];
  }
  /** Closes the clients opened with a sign-in that is gone. */
  closeAuth(auth: string) {
    for (const ws of this.sockets('a:' + auth)) ws.close(4003, 'Signed out');
  }

  /** The machine was removed: everyone off, its data gone. */
  private revoked = false;
  revoke() {
    // (First: the sockets' close handlers, which run after, find nothing left to update.)
    this.revoked = true;
    for (const ws of this.sockets()) ws.close(4001, 'This machine was removed');
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.sql.db.close();
    for (const f of ['', '-wal', '-shm']) rmSync(this.path + f, { force: true });
  }

  /** The sockets, or those with a tag. */
  private sockets(tag?: string): Sock[] {
    return [...this.socks].filter((ws) => !tag || ws.data.tags.includes(tag));
  }

  /**
   * A call the server makes itself, for a caller, to the bridge (the files and zip download routes): checked against
   * the caller's role as a client's call is, and answered here instead of on a socket.
   */
  call(method: string, params: any, caller: Caller, timeout = REQUEST_TIMEOUT): Promise<any> {
    const spec = METHODS[method];
    if (!spec || spec.at !== 'bridge') return Promise.reject(rpcError(ERR.method, `No method ${method}`));
    if (!atLeast(caller.role, spec.role)) return Promise.reject(rpcError(ERR.forbidden, `Your role (${caller.role}) cannot ${method}`));
    const id = 'd:' + randomToken(9);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.direct.delete(id);
        reject(rpcError(ERR.timeout, 'The computer did not answer in time'));
      }, timeout);
      this.direct.set(id, { resolve, reject, timer });
      if (!this.toBridge({ t: 'req', id, method, params, caller })) {
        clearTimeout(timer);
        this.direct.delete(id);
        reject(rpcError(ERR.offline, 'The computer is offline'));
      }
    });
  }

  /** An entry in the audit log for something done outside the socket (a download). */
  record(caller: Caller, action: string, detail: unknown) {
    this.audit(caller, action, detail);
  }

  // ---- Sockets ------------------------------------------------------------------------------------------

  async webSocketMessage(ws: Sock, message: string | Buffer) {
    const att = ws.data.att;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (text === '{"t":"ping"}') return void ws.send('{"t":"pong"}');
    let frame: any;
    try {
      frame = JSON.parse(text);
    } catch {
      return;
    }
    if (att.kind === 'bridge') await this.fromBridge(frame as BridgeOutFrame);
    else await this.fromClient(ws, att, frame);
  }

  async webSocketClose(ws: Sock) {
    this.socks.delete(ws);
    if (this.revoked) return;
    if (ws.data.att.kind === 'bridge') {
      if (this.bridges().length) return; // replaced
      await this.bridgeGone();
    }
  }

  /** The bridge's sockets that are open, newest first. One it dropped (its network went away) or one a new
   *  connection replaced can stay in the list for a long while, closing, with no one at the other end: requests
   *  sent there go nowhere, so they're never chosen. */
  private bridges(): Sock[] {
    return this.sockets('bridge')
      .filter((w) => w.readyState === 1)
      .sort((a, b) => ((b.data.att as BridgeAttachment).connectedAt ?? 0) - ((a.data.att as BridgeAttachment).connectedAt ?? 0));
  }

  private bridge(): Sock | null {
    return this.bridges()[0] ?? null;
  }

  private toBridge(frame: BridgeInFrame): boolean {
    const b = this.bridge();
    if (!b) return false;
    try {
      b.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private send(ws: Sock, frame: ServerFrame) {
    try {
      ws.send(JSON.stringify(frame));
    } catch {}
  }

  private clients(): { ws: Sock; att: ClientAttachment }[] {
    return this.sockets('client').map((ws) => ({ ws, att: ws.data.att as ClientAttachment }));
  }

  /** Send an event to every client subscribed to its topic that may see it. */
  private publish(topic: string, data: any, may?: (c: Caller) => boolean) {
    const text = JSON.stringify({ t: 'ev', topic, data } satisfies ServerFrame);
    for (const { ws, att } of this.clients()) {
      if (!att.topics.includes(topic)) continue;
      if (may && !may(att.caller)) continue;
      try {
        ws.send(text);
      } catch {}
    }
  }

  updateScope(userId: string, caller: Caller | null) {
    for (const ws of this.sockets('u:' + userId)) {
      const att = ws.data.att as ClientAttachment;
      if (!caller) ws.close(4003, 'Your access to this machine was removed');
      else ws.data.att = { ...att, caller: { ...caller, userId: att.caller.userId, username: att.caller.username } };
    }
  }

  // ---- Clients -----------------------------------------------------------------------------------------

  private async fromClient(ws: Sock, att: ClientAttachment, frame: any) {
    if (frame.t !== 'req' || typeof frame.method !== 'string') return;
    const reply = (result: any) => this.send(ws, { t: 'res', id: frame.id, result });
    const fail = (code: number, message: string) => this.send(ws, { t: 'res', id: frame.id, error: { code, message } });
    const caller = att.caller;
    const params = frame.params ?? {};
    const spec = METHODS[frame.method];
    if (!spec) return fail(ERR.method, `No method ${frame.method}`);
    if (!atLeast(caller.role, spec.role)) return fail(ERR.forbidden, `Your role (${caller.role}) cannot ${frame.method}`);
    if (spec.needs === 'terminal' && !caller.terminal) return fail(ERR.forbidden, 'You have no terminal access on this machine');

    try {
      if (spec.at === 'hub') return reply(await this.local(ws, att, frame.method, params));

      // Calls about a session: check it, and hand the bridge what it needs to bring the session back.
      if (typeof params.sessionId === 'string' && frame.method !== 'agent.open') {
        const s = this.session(params.sessionId);
        if (!s) return fail(ERR.notFound, 'No such session');
        if (!this.maySee(caller, s)) return fail(ERR.forbidden, 'That session is outside your folders');
        if (caller.harnesses && !caller.harnesses.includes(s.harness)) return fail(ERR.forbidden, `You cannot use ${s.harness}`);
        params.harness = s.harness;
        params.cwd = s.cwd;
      }
      if (frame.method === 'agent.open') {
        const s = typeof params.sessionId === 'string' ? this.session(params.sessionId) : null;
        if (s && !this.maySee(caller, s)) return fail(ERR.forbidden, 'That session is outside your folders');
        params.known = !!s; // CodeRail has its log: bring it back without replaying the harness's history
      }
      if (frame.method === 'agent.answer') {
        const a = this.sql.exec('SELECT session FROM approvals WHERE id = ?', params.approvalId).toArray()[0];
        if (!a) return fail(ERR.notFound, 'That approval was already answered or is gone');
        const s = this.session(a.session as string);
        if (s ? !this.maySee(caller, s) : !unlimited(caller)) return fail(ERR.forbidden, 'That session is outside your folders');
      }
      if (typeof params.harness === 'string' && caller.harnesses && !caller.harnesses.includes(params.harness)) {
        return fail(ERR.forbidden, `You cannot use ${params.harness}`);
      }
      if (typeof params.cwd === 'string' && !inFolders(params.cwd, caller.folders) && !frame.method.startsWith('term.')) {
        return fail(ERR.forbidden, 'That folder is outside your access');
      }
      if (frame.method === 'term.attach' || frame.method === 'term.open' || frame.method === 'harness.login') {
        // subscribe now so no output is missed; term.open's id is known only after, see afterBridge
        if (params.id) this.subscribe(ws, att, ['term:' + params.id]);
      }
      if (frame.method === 'agent.task_stop') {
        const t = this.sql.exec('SELECT session FROM tasks WHERE id = ?', String(params.taskId)).toArray()[0];
        if (!t || t.session !== params.sessionId) return fail(ERR.notFound, 'That task is gone');
      }
      if (frame.method === 'browser.attach' && typeof params.sessionId === 'string') this.subscribe(ws, att, ['browser:' + params.sessionId]);
      if (!this.bridge()) return fail(ERR.offline, 'The machine is offline');
      // (Asking the agent for a title: what it says replaces one you set.)
      if (frame.method === 'agent.retitle') this.setMeta('named:' + params.sessionId, '');
      if (frame.method === 'agent.prompt') {
        const entry = this.append(params.sessionId, 'user', { prompt: params.prompt, by: caller.username });
        const s = this.session(params.sessionId)!;
        // (No title yet: the start of the first prompt, until the agent names it.)
        if (!s.title) {
          const text = ((params.prompt ?? []) as any[]).filter((b) => b?.type === 'text').map((b) => String(b.text)).join(' ').replace(/\s+/g, ' ').trim();
          if (text) this.patchSession(s.sessionId, { title: text.length > 60 ? text.slice(0, 59).trimEnd() + '…' : text });
        }
        this.publish('session:' + s.sessionId, entry, (c) => this.maySee(c, s));
        this.setState(params.sessionId, 'running');
      }
      if (AUDITED.has(frame.method)) this.audit(caller, frame.method, auditDetail(frame.method, params));
      if (spec.oneWay) {
        if (!this.toBridge({ t: 'note', method: frame.method, params, caller })) return fail(ERR.offline, 'The machine is offline');
        return reply({ ok: true });
      }

      const id = randomToken(9);
      this.sql.exec(
        'INSERT INTO pending (id, client, client_id, method, params, caller, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, att.tag, JSON.stringify(frame.id), frame.method, JSON.stringify(params).slice(0, 4000), JSON.stringify(caller), now(),
      );
      await this.armTimeout();
      if (!this.toBridge({ t: 'req', id, method: frame.method, params, caller })) {
        this.sql.exec('DELETE FROM pending WHERE id = ?', id);
        return fail(ERR.offline, 'The machine is offline');
      }
    } catch (e: any) {
      fail(e.code ?? ERR.internal, e.message ?? String(e));
    }
  }

  private subscribe(ws: Sock, att: ClientAttachment, topics: string[]) {
    const set = new Set(att.topics);
    for (const t of topics) set.add(t);
    att.topics = [...set];
    ws.data.att = att;
  }

  private async local(ws: Sock, att: ClientAttachment, method: string, params: any): Promise<any> {
    const caller = att.caller;
    switch (method) {
      case 'sub': {
        const topics: string[] = (params.topics ?? []).filter((t: string) => {
          if (t === 'machine') return true;
          if (t.startsWith('session:')) {
            const s = this.session(t.slice(8));
            return !s || this.maySee(caller, s);
          }
          if (t.startsWith('term:')) return caller.terminal;
          if (t.startsWith('fs:')) return mayWatch(t.slice(3), caller);
          if (t.startsWith('browser:')) {
            const s = this.session(t.slice(8));
            return !!s && atLeast(caller.role, 'operator') && this.maySee(caller, s);
          }
          return false;
        });
        this.subscribe(ws, att, topics);
        return { topics: att.topics };
      }
      case 'unsub': {
        const drop = new Set<string>(params.topics ?? []);
        att.topics = att.topics.filter((t) => !drop.has(t));
        ws.data.att = att;
        return { topics: att.topics };
      }
      case 'machine.info':
        return { online: !!this.bridge(), info: this.info(), scope: scopeOf(caller) };
      case 'agent.sessions': {
        const rows = this.sql.exec('SELECT * FROM sessions ORDER BY updated_at DESC').toArray().map((r) => this.row(r));
        return rows.filter((s) => this.maySee(caller, s) && (!params.cwd || s.cwd === params.cwd));
      }
      case 'agent.history': {
        const s = this.session(params.sessionId);
        if (!s) throw rpcError(ERR.notFound, 'No such session');
        if (!this.maySee(caller, s)) throw rpcError(ERR.forbidden, 'That session is outside your folders');
        const limit = Math.min(Math.max(Number(params.limit) || 2000, 1), 5000);
        const rows = this.sql
          .exec('SELECT seq, at, kind, data FROM log WHERE session = ? AND seq > ? ORDER BY seq LIMIT ?', s.sessionId, Number(params.after) || 0, limit + 1)
          .toArray();
        const entries: LogEntry[] = [];
        let bytes = 0;
        let more = rows.length > limit;
        for (const r of rows.slice(0, limit)) {
          bytes += (r.data as string).length + 60;
          if (bytes > HISTORY_BYTES && entries.length) {
            more = true;
            break;
          }
          entries.push({ seq: r.seq as number, at: r.at as number, kind: r.kind as LogEntry['kind'], data: JSON.parse(r.data as string) });
        }
        return { session: s, entries, more };
      }
      case 'agent.approvals':
        return this.approvals().filter((a) => {
          const s = this.session(a.sessionId);
          return s ? this.maySee(caller, s) : unlimited(caller);
        });
      case 'agent.rename': {
        const s = this.session(params.sessionId);
        if (!s) throw rpcError(ERR.notFound, 'No such session');
        if (!this.maySee(caller, s)) throw rpcError(ERR.forbidden, 'That session is outside your folders');
        if (typeof params.title !== 'string') throw rpcError(ERR.invalid, 'A title, please');
        const title = params.title.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
        this.setMeta('named:' + s.sessionId, title ? '1' : '');
        this.patchSession(s.sessionId, { title });
        this.audit(caller, method, { sessionId: s.sessionId, title });
        return { ok: true, title };
      }
      case 'agent.tasks':
        return this.tasks().filter((t) => {
          const s = this.session(t.sessionId);
          return s ? this.maySee(caller, s) : unlimited(caller);
        });
      case 'agent.forget': {
        const s = this.session(params.sessionId);
        if (!s) throw rpcError(ERR.notFound, 'No such session');
        if (!this.maySee(caller, s)) throw rpcError(ERR.forbidden, 'That session is outside your folders');
        this.sql.exec('DELETE FROM sessions WHERE id = ?', s.sessionId);
        this.sql.exec('DELETE FROM log WHERE session = ?', s.sessionId);
        for (const a of this.approvals().filter((x) => x.sessionId === s.sessionId)) {
          this.publish('machine', { type: 'approval_done', approvalId: a.id, sessionId: a.sessionId }, (c) => this.maySee(c, s));
        }
        this.sql.exec('DELETE FROM approvals WHERE session = ?', s.sessionId);
        for (const t of this.tasks().filter((x) => x.sessionId === s.sessionId)) this.endTask(t, s);
        this.sql.exec('DELETE FROM meta WHERE k = ?', 'named:' + s.sessionId);
        this.audit(caller, method, { sessionId: s.sessionId });
        this.publish('machine', { type: 'session_removed', sessionId: s.sessionId });
        return { ok: true };
      }
    }
    throw rpcError(ERR.method, `No method ${method}`);
  }

  // ---- The bridge --------------------------------------------------------------------------------------

  private async fromBridge(f: BridgeOutFrame) {
    switch (f.t) {
      case 'hello':
        return this.hello(f.info, f.live);
      case 'res':
        return this.bridgeAnswer(f.id, f.result, f.error);
      case 'ev':
        return this.bridgeEvent(f.topic, f.data);
    }
  }

  private async hello(info: MachineInfo, live: LiveState) {
    this.setMeta('info', JSON.stringify(info));
    const id = this.getMeta('id');
    if (id) {
      await this.env.DB.prepare('UPDATE machines SET online = 1, last_seen = ?, info = ? WHERE id = ?').bind(now(), JSON.stringify(info), id).run();
    }
    // Reconcile: what the bridge has now wins.
    const busy = new Set(live.sessions.filter((s) => s.busy).map((s) => s.sessionId));
    for (const r of this.sql.exec("SELECT id FROM sessions WHERE state = 'running'").toArray()) {
      if (!busy.has(r.id as string)) this.setState(r.id as string, 'idle');
    }
    const liveIds = new Set(live.approvals.map((a) => a.id));
    for (const a of this.approvals()) {
      if (!liveIds.has(a.id)) {
        this.sql.exec('DELETE FROM approvals WHERE id = ?', a.id);
        this.publish('machine', { type: 'approval_done', approvalId: a.id, sessionId: a.sessionId });
      }
    }
    // (The background tasks still running: the bridge's list wins, so a drop of the link loses none.)
    const liveTasks = new Set((live.tasks ?? []).map((t) => t.update?.asyncTaskId));
    for (const t of this.tasks()) if (!liveTasks.has(t.id)) this.endTask(t, this.session(t.sessionId));
    for (const t of live.tasks ?? []) {
      const s = this.session(t.sessionId);
      if (s) this.taskUpdate(s, t.update);
    }
    for (const a of live.approvals) {
      if (!this.session(a.sessionId)) continue; // (a session forgotten here: its approval goes nowhere)
      this.sql.exec('INSERT OR IGNORE INTO approvals (id, session, data) VALUES (?, ?, ?)', a.id, a.sessionId, JSON.stringify(a));
    }
    this.publish('machine', { type: 'online', online: true, info });
  }

  private async bridgeGone() {
    const id = this.getMeta('id');
    if (id) await this.env.DB.prepare('UPDATE machines SET online = 0, last_seen = ? WHERE id = ?').bind(now(), id).run();
    for (const p of this.sql.exec('SELECT id FROM pending').toArray()) {
      this.bridgeAnswer(p.id as string, undefined, { code: ERR.offline, message: 'The machine went offline' });
    }
    for (const id of [...this.direct.keys()]) this.bridgeAnswer(id, undefined, { code: ERR.offline, message: 'The machine went offline' });
    for (const r of this.sql.exec("SELECT id FROM sessions WHERE state = 'running'").toArray()) {
      this.setState(r.id as string, 'idle');
    }
    // (The agents' background tasks went with the bridge's processes.)
    for (const t of this.tasks()) this.endTask(t, this.session(t.sessionId));
    this.publish('machine', { type: 'online', online: false, info: this.info() });
  }

  private bridgeAnswer(id: string, result: any, error?: RpcError) {
    const d = this.direct.get(id);
    if (d) {
      clearTimeout(d.timer);
      this.direct.delete(id);
      return error ? d.reject(rpcError(error.code, error.message)) : d.resolve(result);
    }
    const p = this.sql.exec('SELECT * FROM pending WHERE id = ?', id).toArray()[0];
    if (!p) return;
    this.sql.exec('DELETE FROM pending WHERE id = ?', id);
    const method = p.method as string;
    const caller = JSON.parse(p.caller as string) as Caller;
    if (error) this.afterFailure(method, String(p.params ?? ''), p.client as string);
    else {
      try {
        result = this.afterBridge(method, result, caller, p.client as string);
      } catch (e: any) {
        console.error('afterBridge', method, e);
        error = { code: ERR.internal, message: e.message ?? String(e) };
        result = undefined;
      }
    }
    const ws = this.sockets(p.client as string)[0];
    if (ws) this.send(ws, { t: 'res', id: JSON.parse(p.client_id as string), result, error });
  }

  /** What a call that failed leaves undone. (params: the stored request, cut at 4000 characters, so read by pattern.) */
  private afterFailure(method: string, params: string, client: string) {
    const field = (k: string) => params.match(new RegExp(`"${k}":"([^"]+)"`))?.[1];
    // (A prompt the harness never started: its session isn't working.)
    if (method === 'agent.prompt') { const sid = field('sessionId'); if (sid) this.setState(sid, 'idle'); }
    // (An attach that failed: its frames or output aren't for this client.)
    const topic = method === 'browser.attach' ? 'browser:' + field('sessionId') : method === 'term.attach' ? 'term:' + field('id') : null;
    const ws = topic && !topic.endsWith(':undefined') ? this.sockets(client)[0] : null;
    if (ws && topic) {
      const att = ws.data.att as ClientAttachment;
      ws.data.att = { ...att, topics: att.topics.filter((t) => t !== topic) };
    }
  }

  /** What the hub does with a bridge's answer before passing it on. */
  private afterBridge(method: string, result: any, caller: Caller, client: string): any {
    if ((method === 'agent.new' || method === 'agent.open') && result?.sessionId) {
      const t = now();
      const existing = this.session(result.sessionId);
      this.sql.exec(
        `INSERT INTO sessions (id, harness, cwd, title, state, created_by, created_at, updated_at, modes, models, config)
         VALUES (?, ?, ?, ?, 'idle', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET modes = excluded.modes, models = excluded.models, config = excluded.config,
           title = COALESCE(sessions.title, excluded.title), updated_at = excluded.updated_at`,
        result.sessionId, result.harness, result.cwd, result.title ?? null, existing?.createdBy ?? caller.username, existing?.createdAt ?? t, t,
        json(result.modes), json(result.models), json(result.configOptions),
      );
      // A session loaded from the harness's own history replays it as events; those were logged as they came.
      const row = this.session(result.sessionId)!;
      this.publish('machine', { type: 'session', session: row }, (c) => this.maySee(c, row));
      const ws = this.sockets(client)[0];
      if (ws) this.subscribe(ws, ws.data.att as ClientAttachment, ['session:' + row.sessionId]);
      return row;
    }
    if ((method === 'term.open' || method === 'harness.login') && result?.id) {
      const ws = this.sockets(client)[0];
      if (ws) this.subscribe(ws, ws.data.att as ClientAttachment, ['term:' + result.id]);
    }
    if (method === 'browser.open' && result?.id) {
      const ws = this.sockets(client)[0];
      if (ws) this.subscribe(ws, ws.data.att as ClientAttachment, ['browser:' + result.id]);
    }
    if (method === 'agent.local' && Array.isArray(result) && caller.folders) {
      return result.filter((s: any) => inFolders(s.cwd, caller.folders));
    }
    return result;
  }

  private async bridgeEvent(topic: string, data: any) {
    if (topic.startsWith('session:')) {
      const sessionId = topic.slice(8);
      const s = this.session(sessionId);
      if (!s) {
        // (A session no client opened through CodeRail, e.g. loading for a list, or one forgotten here: an approval
        // it answers is gone all the same.)
        if (data?.kind === 'answer' && data.data?.approvalId) this.sql.exec('DELETE FROM approvals WHERE id = ?', data.data.approvalId);
        return;
      }
      const entry = this.append(sessionId, data.kind, data.data);
      this.publish(topic, entry, (c) => this.maySee(c, s));
      await this.sideEffects(s, entry);
      return;
    }
    if (topic.startsWith('term:')) {
      // Output no one is watching (htop left running in a closed tab): every message is a request here, so the
      // bridge holds it until a client attaches again.
      if (data?.type === 'output' && !this.clients().some(({ att }) => att.topics.includes(topic))) this.toBridge({ t: 'term_quiet', id: topic.slice(5) });
      return this.publish(topic, data, (c) => c.terminal);
    }
    if (topic.startsWith('fs:')) {
      // (A folder no one has open any more: the bridge stops watching it.)
      if (!this.clients().some(({ att }) => att.topics.includes(topic))) this.toBridge({ t: 'fs_quiet', path: topic.slice(3) });
      return this.publish(topic, data, (c) => mayWatch(topic.slice(3), c));
    }
    if (topic.startsWith('browser:')) {
      // (Frames no one is watching: each is a request here, so the bridge stops them until a card asks again.)
      if (data?.type === 'frame' && !this.clients().some(({ att }) => att.topics.includes(topic))) this.toBridge({ t: 'browser_quiet', id: topic.slice(8) });
      // (A chat's browser: everyone who can work in that chat sees the same screen.)
      const s = this.session(topic.slice(8));
      return this.publish(topic, data, (c) => !!s && atLeast(c.role, 'operator') && this.maySee(c, s));
    }
    if (topic === 'machine') {
      // (A chat's agent opened its browser: for those who may watch that chat's browser.)
      if (data?.type === 'browser') {
        const s = this.session(String(data.sessionId));
        return this.publish('machine', data, (c) => !!s && atLeast(c.role, 'operator') && this.maySee(c, s));
      }
      const terminalOnly = data?.type === 'terminal' || data?.type === 'terminal_closed';
      return this.publish('machine', data, terminalOnly ? (c) => c.terminal : undefined);
    }
  }

  private async sideEffects(s: SessionRow, e: LogEntry) {
    const d = e.data;
    switch (e.kind) {
      case 'update':
        switch (d?.sessionUpdate) {
          case 'session_info_update':
            // (The agent's title, unless you named the session yourself.)
            if (d.title && !this.getMeta('named:' + s.sessionId)) this.patchSession(s.sessionId, { title: d.title });
            break;
          case 'current_mode_update':
            if (s.modes) this.patchSession(s.sessionId, { modes: { ...s.modes, currentModeId: d.currentModeId } });
            break;
          case 'config_option_update':
            if (d.configOptions) this.patchSession(s.sessionId, { configOptions: d.configOptions });
            break;
          case 'async_task_spawned':
          case 'async_task_progress':
          case 'async_task_state_update':
            this.taskUpdate(s, d);
            break;
          case 'user_message_chunk':
          case 'agent_message_chunk':
            break;
        }
        break;
      case 'approval': {
        const a = d as Approval;
        this.sql.exec('INSERT OR REPLACE INTO approvals (id, session, data) VALUES (?, ?, ?)', a.id, s.sessionId, JSON.stringify(a));
        this.publish('machine', { type: 'approval', approval: a }, (c) => this.maySee(c, s));
        this.touch(s.sessionId);
        const id = this.getMeta('id');
        if (id) void notifyApproval(this.env, id, s, a).catch((err) => console.error('push', err));
        break;
      }
      case 'answer':
        this.sql.exec('DELETE FROM approvals WHERE id = ?', d.approvalId);
        this.publish('machine', { type: 'approval_done', approvalId: d.approvalId, sessionId: s.sessionId }, (c) => this.maySee(c, s));
        this.touch(s.sessionId);
        break;
      case 'turn':
      case 'error':
        this.setState(s.sessionId, 'idle');
        break;
    }
  }

  // ---- Sessions and the log ------------------------------------------------------------------------------

  private session(id: string): SessionRow | null {
    const r = this.sql.exec('SELECT * FROM sessions WHERE id = ?', id).toArray()[0];
    return r ? this.row(r) : null;
  }

  private row(r: Record<string, any>): SessionRow {
    const pending = this.sql.exec('SELECT COUNT(*) AS n FROM approvals WHERE session = ?', r.id).one().n as number;
    return {
      sessionId: r.id as string,
      harness: r.harness as string,
      cwd: r.cwd as string,
      title: (r.title as string) ?? null,
      state: r.state as SessionRow['state'],
      createdBy: (r.created_by as string) ?? null,
      createdAt: r.created_at as number,
      updatedAt: r.updated_at as number,
      pending,
      modes: r.modes ? JSON.parse(r.modes as string) : undefined,
      models: r.models ? JSON.parse(r.models as string) : undefined,
      configOptions: r.config ? JSON.parse(r.config as string) : undefined,
    };
  }

  private append(sessionId: string, kind: string, data: any): LogEntry {
    const at = now();
    const text = JSON.stringify(data ?? null);
    const seq = this.sql.exec('INSERT INTO log (session, at, kind, data) VALUES (?, ?, ?, ?) RETURNING seq', sessionId, at, kind, text).one().seq as number;
    if (seq % 500 === 0) {
      this.sql.exec(
        'DELETE FROM log WHERE session = ? AND seq <= (SELECT seq FROM log WHERE session = ? ORDER BY seq DESC LIMIT 1 OFFSET ?)',
        sessionId, sessionId, LOG_CAP,
      );
    }
    return { seq, at, kind: kind as LogEntry['kind'], data };
  }

  private setState(id: string, state: SessionRow['state']) {
    const s = this.session(id);
    if (!s || s.state === state) return;
    this.patchSession(id, { state });
  }

  private touch(id: string) {
    const s = this.session(id);
    if (s) this.publish('machine', { type: 'session', session: s }, (c) => this.maySee(c, s));
  }

  private patchSession(id: string, patch: Partial<Pick<SessionRow, 'title' | 'state' | 'modes' | 'configOptions'>>) {
    const sets: string[] = ['updated_at = ?'];
    const vals: any[] = [now()];
    if (patch.title !== undefined) sets.push('title = ?'), vals.push(patch.title);
    if (patch.state !== undefined) sets.push('state = ?'), vals.push(patch.state);
    if (patch.modes !== undefined) sets.push('modes = ?'), vals.push(json(patch.modes));
    if (patch.configOptions !== undefined) sets.push('config = ?'), vals.push(json(patch.configOptions));
    this.sql.exec(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`, ...vals, id);
    this.touch(id);
  }

  // ---- Background tasks (an agent's async_task_* updates) -------------------------------------------------

  private tasks(): AgentTask[] {
    return this.sql.exec('SELECT data FROM tasks').toArray().map((r) => JSON.parse(r.data as string));
  }

  private taskUpdate(s: SessionRow, d: any) {
    const id = typeof d.asyncTaskId === 'string' ? d.asyncTaskId : null;
    if (!id) return;
    const old = this.sql.exec('SELECT data FROM tasks WHERE id = ?', id).toArray()[0];
    const prev: AgentTask | null = old ? JSON.parse(old.data as string) : null;
    if (!prev && d.sessionUpdate !== 'async_task_spawned') return;
    const state = d.sessionUpdate === 'async_task_state_update' ? d.state : prev?.state ?? 'running';
    const task: AgentTask = {
      id, sessionId: s.sessionId, harness: s.harness,
      name: String(d.name ?? prev?.name ?? d.description ?? 'Background task').slice(0, 200),
      taskType: d.taskType ?? prev?.taskType,
      description: d.description ?? prev?.description,
      summary: d.summary ?? prev?.summary,
      state: state === 'paused' ? 'paused' : 'running',
      canStop: d.canStop ?? prev?.canStop ?? false,
      at: now(),
    };
    if (state === 'completed' || state === 'failed' || state === 'stopped') return this.endTask(task, s);
    this.sql.exec('INSERT OR REPLACE INTO tasks (id, session, data) VALUES (?, ?, ?)', id, s.sessionId, JSON.stringify(task));
    this.publish('machine', { type: 'task', task }, (c) => this.maySee(c, s));
  }

  private endTask(t: AgentTask, s: SessionRow | null) {
    this.sql.exec('DELETE FROM tasks WHERE id = ?', t.id);
    this.publish('machine', { type: 'task_done', taskId: t.id, sessionId: t.sessionId }, (c) => (s ? this.maySee(c, s) : unlimited(c)));
  }

  private approvals(): Approval[] {
    return this.sql.exec('SELECT data FROM approvals').toArray().map((r) => JSON.parse(r.data as string));
  }

  private maySee(c: Caller, s: SessionRow): boolean {
    return inFolders(s.cwd, c.folders) && (!c.harnesses || c.harnesses.includes(s.harness));
  }

  // ---- Timeouts --------------------------------------------------------------------------------------------

  private async armTimeout() {
    this.alarmTimer ??= setTimeout(() => void this.alarm(), REQUEST_TIMEOUT);
  }

  async alarm() {
    this.alarmTimer = null;
    const cutoff = now() - REQUEST_TIMEOUT;
    for (const p of this.sql.exec('SELECT id FROM pending WHERE at < ?', cutoff).toArray()) {
      this.bridgeAnswer(p.id as string, undefined, { code: ERR.timeout, message: 'The machine did not answer in time' });
    }
    const left = this.sql.exec('SELECT MIN(at) AS at FROM pending').one().at as number | null;
    if (left) this.alarmTimer = setTimeout(() => void this.alarm(), Math.max(1000, left + REQUEST_TIMEOUT - now()));
  }

  // ---- Small things -------------------------------------------------------------------------------------

  private info(): MachineInfo | null {
    const v = this.getMeta('info');
    return v ? JSON.parse(v) : null;
  }

  private getMeta(k: string): string | null {
    return (this.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0]?.v as string) ?? null;
  }

  private setMeta(k: string, v: string) {
    this.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v', k, v);
  }

  private audit(c: Caller, action: string, detail: unknown) {
    const id = this.getMeta('id');
    void this.env.DB.prepare('INSERT INTO audit (at, user_id, username, machine_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(now(), c.userId, c.username, id, action, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000))
      .run()
      .catch((e) => console.error('audit', e));
  }
}

/** A caller who may see everything on the machine (no folder or harness limits). */
function unlimited(c: Caller): boolean {
  return !c.folders && !c.harnesses;
}

/** A folder's changes, for those whose folders hold it (the bridge checks the path again when it's listed). */
function mayWatch(path: string, c: Caller): boolean {
  return !path.split(/[\\/]/).includes('..') && inFolders(path, c.folders);
}

function scopeOf(c: Caller) {
  return { role: c.role, folders: c.folders, harnesses: c.harnesses, terminal: c.terminal };
}

function rpcError(code: number, message: string) {
  return Object.assign(new Error(message), { code });
}

function json(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

function auditDetail(method: string, p: any): unknown {
  switch (method) {
    case 'agent.prompt': {
      const text = (p.prompt ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ');
      return { sessionId: p.sessionId, text: text.slice(0, 300) };
    }
    case 'fs.write':
      return { path: p.path, bytes: (p.content ?? '').length };
    case 'git.commit':
      return { cwd: p.cwd, message: String(p.message ?? '').slice(0, 300), files: Array.isArray(p.picks) ? p.picks.length : undefined, amend: !!p.amend || undefined };
    case 'gh.create':
      return { cwd: p.cwd, title: String(p.title ?? '').slice(0, 300), base: p.base, draft: !!p.draft };
    default: {
      const { prompt, content, ...rest } = p ?? {};
      return rest;
    }
  }
}
