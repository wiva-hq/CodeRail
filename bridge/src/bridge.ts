// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type BridgeInFrame, type BridgeOutFrame, type Caller, ERR, type MachineInfo, METHODS } from '@coderail/protocol';
import { Agents } from './agents';
import { RpcError, VERSION, log, machineBasics, setState } from './env';
import { guarded } from './scope';
import * as files from './files';
import * as git from './git';
import * as github from './github';
import { Terminals } from './terminals';
import { Browsers } from './browser';
import { Watches } from './watch';
import { planLimits } from './limits';
import type { Config } from './config';

// The bridge's link to its machine's hub on the server: one WebSocket out, reconnecting forever. It
// answers the methods the hub forwards and streams agent, terminal and browser traffic back.

type Handler = (params: any, caller: Caller, after: (send: () => void) => void) => any;

/** Session events kept while the link is down. */
const HELD = 5000;

export class Bridge {
  private ws: WebSocket | null = null;
  // (The chat's browser as tools for its agent: Browsers is made below, so it's reached when a session starts.)
  private agents = new Agents((topic, data) => this.event(topic, data), {
    mcpServer: (sessionId) => this.browsers.mcpServer(sessionId),
    bindKey: (key, sessionId) => this.browsers.bindKey(key, sessionId),
    release: (key) => this.browsers.release(key),
  });
  private terms = new Terminals((topic, data) => this.event(topic, data));
  private watches = new Watches((topic, data) => this.event(topic, data));
  private noteTails = new Map<string, Promise<void>>();
  private browsers = new Browsers((topic, data) => this.event(topic, data), () => (this.ws?.bufferedAmount ?? 0) < 512 * 1024);
  private backoff = 1000;
  private lastPong = Date.now();
  private pinger: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private handlers: Record<string, Handler>;

  constructor(private config: Config) {
    const a = this.agents;
    const t = this.terms;
    this.handlers = {
      'agent.harnesses': () => a.harnesses(),
      'agent.local': (p, c) => a.local(p, c),
      'agent.new': (p, c) => a.newSession(p, c),
      'agent.open': (p, c, after) => a.open(p, c, after),
      'agent.prompt': (p) => a.prompt(p),
      'agent.retitle': (p) => a.retitle(p),
      'agent.limits': (p) => planLimits(!!p?.fresh),
      'agent.cancel': (p) => a.cancel(p),
      'agent.task_stop': (p) => a.stopTask(p),
      'agent.answer': (p, c) => a.answer(p, c),
      'agent.set_mode': (p) => a.setMode(p),
      'agent.set_model': (p) => a.setModel(p),
      'agent.set_config': (p) => a.setConfig(p),
      'agent.close': (p) => a.close(p),
      'term.list': () => t.list(),
      'browser.open': (p) => this.browsers.open(p),
      'browser.attach': (p) => this.browsers.attach(p),
      'browser.resize': (p) => this.browsers.resize(p),
      'browser.watch': (p) => this.browsers.watch(p),
      'browser.navigate': (p) => this.browsers.navigate(p),
      'browser.go': (p) => this.browsers.go(p),
      'browser.input': (p) => this.browsers.input(p),
      'browser.close': (p) => this.browsers.close(p),
      'term.open': ({ login: _, ...p }, c) => t.open(p, c), // (only harness.login makes a sign-in terminal)
      'term.attach': (p) => t.attach(p),
      'term.write': (p) => t.write(p),
      'term.resize': (p) => t.resize(p),
      'term.close': (p) => t.close(p),
      'harness.login': (p, c) => t.login(p, c),
      'harness.logout': (p) => t.logout(p),
      'fs.home': (_p, c) => guarded(files.home(c)),
      'fs.list': async (p, c) => {
        const r = await guarded(files.list(p, c));
        this.watches.add(p.path, r.path);
        return r;
      },
      'fs.read': (p, c) => guarded(files.read(p, c)),
      'fs.chunk': (p, c) => guarded(files.chunk(p, c)),
      'fs.zip': (p, c) => files.zipFolder(p, c), // (a big folder takes longer than guarded allows; its steps are off the main thread)
      'fs.write': (p, c) => guarded(files.write(p, c)),
      'fs.mkdir': (p, c) => guarded(files.makeDir(p, c)),
      'fs.rename': (p, c) => guarded(files.renamePath(p, c)),
      'fs.trash': (p, c) => guarded(files.trash(p, c)),
      'git.status': (p, c) => git.status(p, c),
      'git.diff': (p, c) => git.diff(p, c),
      'git.log': (p, c) => git.log(p, c),
      'git.show': (p, c) => git.show(p, c),
      'git.branches': (p, c) => git.branches(p, c),
      'git.compare': (p, c) => git.compare(p, c),
      'git.stashes': (p, c) => git.stashes(p, c),
      'git.tags': (p, c) => git.tags(p, c),
      'git.file': (p, c) => git.fileAt(p, c),
      'git.stage': (p, c) => git.stage(p, c),
      'git.unstage': (p, c) => git.unstage(p, c),
      'git.discard': (p, c) => git.discard(p, c),
      'git.discard_lines': (p, c) => git.discardLines(p, c),
      'git.ignore': (p, c) => git.ignore(p, c),
      'git.commit': (p, c) => git.commit(p, c),
      'git.undo': (p, c) => git.undo(p, c),
      'git.checkout': (p, c) => git.checkout(p, c),
      'git.branch_rename': (p, c) => git.branchRename(p, c),
      'git.branch_delete': (p, c) => git.branchDelete(p, c),
      'git.merge': (p, c) => git.merge(p, c),
      'git.rebase': (p, c) => git.rebase(p, c),
      'git.continue': (p, c) => git.cont(p, c),
      'git.abort': (p, c) => git.abort(p, c),
      'git.resolve': (p, c) => git.resolve(p, c),
      'git.revert': (p, c) => git.revert(p, c),
      'git.cherry_pick': (p, c) => git.cherryPick(p, c),
      'git.reset': (p, c) => git.reset(p, c),
      'git.tag': (p, c) => git.tag(p, c),
      'git.stash': (p, c) => git.stash(p, c),
      'git.stash_apply': (p, c) => git.stashApply(p, c),
      'git.stash_drop': (p, c) => git.stashDrop(p, c),
      'git.fetch': (p, c) => git.fetch(p, c),
      'git.pull': (p, c) => git.pull(p, c),
      'git.push': (p, c) => git.push(p, c),
      'git.init': (p, c) => git.init(p, c),
      'git.clone': (p, c) => git.clone(p, c),
      'gh.repo': (p, c) => github.repo(p, c),
      'gh.pulls': (p, c) => github.pulls(p, c),
      'gh.pull': (p, c) => github.pullOne(p, c),
      'gh.diff': (p, c) => github.prDiff(p, c),
      'gh.checkout': (p, c) => github.checkout(p, c),
      'gh.create': (p, c) => github.create(p, c),
      'gh.merge': (p, c) => github.merge(p, c),
      'gh.rerun': (p, c) => github.rerun(p, c),
      'gh.publish': (p, c) => github.publish(p, c),
    };
  }

  start() {
    this.connect();
    this.pinger = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastPong > 70_000) {
        log('no answer from the server for a while; reconnecting');
        this.ws.close();
        return;
      }
      this.send({ t: 'ping' } as any);
    }, 25_000);
  }

  stop() {
    this.stopped = true;
    setState('offline');
    if (this.pinger) clearInterval(this.pinger);
    this.ws?.close();
    this.agents.shutdown();
    this.terms.shutdown();
    this.watches.shutdown();
    this.browsers.shutdown();
  }

  private connect() {
    if (this.stopped) return;
    const url = this.config.server.replace(/^http/, 'ws') + '/api/bridge';
    log(`connecting to ${this.config.server}`);
    setState('connecting');
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.config.token}`, 'user-agent': `coderail-bridge/${VERSION}` } } as any);
    this.ws = ws;
    ws.onopen = async () => {
      log('connected');
      setState('connected');
      this.backoff = 1000;
      this.lastPong = Date.now();
      this.send({ t: 'hello', info: await this.info(), live: { ...this.agents.live(), terminals: this.terms.list() } });
      // (What the agents said while the link was down, after the hello, in order.)
      const held = this.held.splice(0);
      this.holding = false;
      for (const f of held) this.send(f);
    };
    ws.onmessage = (ev) => {
      this.lastPong = Date.now();
      let f: BridgeInFrame | { t: 'pong' };
      try {
        f = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer));
      } catch {
        return;
      }
      this.onFrame(f);
    };
    ws.onclose = async (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.holding = true;
      if (this.stopped) return;
      if (ev.code === 4001) {
        log('this machine was removed from CodeRail; run `coderail link` to link it again');
        setState('removed');
        process.exit(0);
      }
      if (ev.code !== 4000) await this.checkToken();
      setState('offline');
      const wait = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 30_000);
      log(`disconnected (${ev.code}${ev.reason ? ' ' + ev.reason : ''}); retrying in ${Math.round(wait / 1000)}s`);
      setTimeout(() => this.connect(), wait + Math.random() * 500);
    };
    ws.onerror = () => {};
  }

  /** A failed upgrade does not say why; ask plainly whether the token is still good. */
  private async checkToken() {
    try {
      const r = await fetch(this.config.server + '/api/bridge', { headers: { authorization: `Bearer ${this.config.token}` } });
      if (r.status === 401) {
        log('the server refused this machine token (it was removed); run `coderail link` to link again');
        setState('removed');
        process.exit(0);
      }
    } catch {}
  }

  private async info(): Promise<MachineInfo> {
    return { ...machineBasics(), bridgeVersion: VERSION, harnesses: await this.agents.harnesses() };
  }

  private send(f: BridgeOutFrame) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(f));
  }

  /** A session's events while the link is down (or not yet greeted): kept, the newest HELD, and sent after the next
   *  hello, so a turn's answer and its end reach the hub's log. Frames and terminal output are live only. */
  private held: BridgeOutFrame[] = [];
  private holding = true;
  private event(topic: string, data: any) {
    const f: BridgeOutFrame = { t: 'ev', topic, data };
    if (this.holding || this.ws?.readyState !== WebSocket.OPEN) {
      if (!topic.startsWith('session:')) return;
      this.held.push(f);
      if (this.held.length > HELD) this.held.splice(0, this.held.length - HELD);
      return;
    }
    this.send(f);
  }

  private async onFrame(f: BridgeInFrame | { t: 'pong' }) {
    if (f.t === 'pong' || f.t === 'ping') return;
    if (f.t === 'term_quiet') return this.terms.quiet(f.id);
    if (f.t === 'browser_quiet') return this.browsers.quiet(f.id);
    if (f.t === 'fs_quiet') return this.watches.quiet(f.path);
    if (f.t === 'note') {
      // (No answer: a failure is only logged. A chat's notes run one after another, in the order sent: a key's up
      // never overtakes its down.)
      const handler = this.handlers[f.method];
      if (!handler || !METHODS[f.method]?.oneWay) return;
      const key = String(f.params?.sessionId ?? '');
      const run = async () => {
        try { await handler(f.params ?? {}, f.caller, () => {}); }
        catch (e: any) { if (!(e instanceof RpcError)) log(`${f.method} failed: ${e?.message ?? e}`); }
      };
      const tail = (this.noteTails.get(key) ?? Promise.resolve()).then(run);
      this.noteTails.set(key, tail);
      void tail.finally(() => { if (this.noteTails.get(key) === tail) this.noteTails.delete(key); });
      return;
    }
    if (f.t !== 'req') return;
    const handler = this.handlers[f.method];
    const afters: (() => void)[] = [];
    try {
      if (!handler || !METHODS[f.method]) throw new RpcError(ERR.method, `No method ${f.method}`);
      const result = await handler(f.params ?? {}, f.caller, (fn) => afters.push(fn));
      this.send({ t: 'res', id: f.id, result: result ?? null });
    } catch (e: any) {
      if (!(e instanceof RpcError)) log(`${f.method} failed`, e);
      this.send({ t: 'res', id: f.id, error: { code: e.code ?? ERR.internal, message: e.message ?? String(e) } });
    }
    for (const fn of afters) fn();
  }
}
