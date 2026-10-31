// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Caller, ERR, type TerminalInfo } from '@coderail/protocol';
import { existsSync } from 'node:fs';
import { HOME, RpcError, b64, userEnv } from './env';
import { detect, forget } from './agents';
import { checkPath } from './scope';

// Terminals on the machine: real PTYs that keep running with no client attached. Each keeps its last
// 256 KiB of output so a client that attaches (or comes back) sees the screen it left.

const SCROLLBACK = 256 * 1024;
const FLUSH_MS = 12;
/** Output that keeps coming (a full-screen app redrawing) goes at most this often: each send is a request to the server. */
const MIN_GAP = 50;

type Emit = (topic: string, data: any) => void;

interface Term {
  info: TerminalInfo;
  /** A sign-in terminal's output so far, as text, for its link and code. */
  loginText?: string;
  proc: ReturnType<typeof Bun.spawn>;
  chunks: Uint8Array[];
  size: number;
  out: Uint8Array[];
  timer: ReturnType<typeof setTimeout> | null;
  /** When output last went out. */
  sent: number;
  /** No client is watching: output only goes to the scrollback. */
  quiet: boolean;
  /** When it was last opened or attached (a client subscribing right then may not show yet). */
  seen: number;
}

export class Terminals {
  private terms = new Map<string, Term>();
  private next = 1;

  constructor(private emit: Emit) {}

  list(): TerminalInfo[] {
    return [...this.terms.values()].map((t) => t.info);
  }

  async open(p: { cwd?: string; cols?: number; rows?: number; command?: string[]; title?: string; login?: string }, caller: Caller) {
    const cwd = p.cwd ? await checkPath(p.cwd, caller) : HOME;
    if (!existsSync(cwd)) throw new RpcError(ERR.notFound, 'That folder does not exist');
    const env = await userEnv();
    const shell = env.SHELL || '/bin/zsh';
    const cmd = p.command?.length ? p.command : [shell, '-l'];
    const cols = clamp(p.cols ?? 100, 10, 1000);
    const rows = clamp(p.rows ?? 30, 4, 300);
    const id = `t${Date.now().toString(36)}${(this.next++).toString(36)}`;
    const info: TerminalInfo = {
      id,
      title: p.title ?? (p.command?.length ? p.command.map((c) => c.split('/').pop()).join(' ') : shell.split('/').pop()!),
      cwd,
      cols,
      rows,
      startedAt: Date.now(),
      exited: null,
      by: caller.username,
      ...(p.login ? { login: { harness: p.login, url: null, code: null } } : {}),
    };
    const t: Term = { info, proc: null as any, chunks: [], size: 0, out: [], timer: null, sent: 0, quiet: false, seen: Date.now() };
    t.proc = Bun.spawn(cmd, {
      cwd,
      env: { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'CodeRail' },
      terminal: {
        cols,
        rows,
        data: (_term, data) => this.output(t, new Uint8Array(data)),
      },
    });
    t.proc.exited.then((code) => {
      this.flush(t);
      t.info.exited = code ?? 0;
      this.emit('term:' + id, { type: 'exit', code: t.info.exited });
      // (Closed by someone: it already left the list, and isn't put back.)
      if (this.terms.get(id) === t) this.emit('machine', { type: 'terminal', terminal: t.info });
      if (t.info.login) void this.signedIn(t.info.login.harness);
      // Keep a finished terminal's output around for a while, then let it go.
      setTimeout(() => {
        if (this.terms.get(id) === t) {
          this.terms.delete(id);
          this.emit('machine', { type: 'terminal_closed', id });
        }
      }, 10 * 60_000);
    });
    this.terms.set(id, t);
    this.emit('machine', { type: 'terminal', terminal: info });
    return { ...info, scrollback: this.scrollback(t) };
  }

  async login(p: { harness: string; cols?: number; rows?: number }, caller: Caller) {
    const h = await detect(p.harness, true);
    if (!h.installed || !h.path) throw new RpcError(ERR.notFound, `${h.name} is not installed on this machine`);
    const command = p.harness === 'codex' ? [h.path, 'login', '--device-auth'] : [h.path, 'auth', 'login'];
    // Wide, so a sign-in link is never wrapped.
    return this.open({ command, cols: Math.max(p.cols ?? 0, 200), rows: p.rows ?? 30, title: `${h.name} sign-in`, login: p.harness }, caller);
  }

  /** Signs the harness out (its own logout, which needs no input), then tells everyone its status. */
  async logout(p: { harness: string }) {
    const h = await detect(p.harness, true);
    if (!h.installed || !h.path) throw new RpcError(ERR.notFound, `${h.name} is not installed on this machine`);
    const command = p.harness === 'codex' ? [h.path, 'logout'] : [h.path, 'auth', 'logout'];
    const proc = Bun.spawn(command, { cwd: HOME, env: await userEnv(), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const code = await Promise.race([proc.exited, Bun.sleep(30_000).then(() => (proc.kill(), -1))]);
    await this.signedIn(p.harness);
    if (code !== 0) throw new RpcError(ERR.internal, `${h.name} could not sign out`);
    return { ok: true };
  }

  /** After a sign-in ends: the harness's status, looked up again, to everyone watching the machine. */
  private async signedIn(harness: string) {
    forget(harness);
    const h = await detect(harness, true).catch(() => null);
    if (!h?.auth) return;
    this.emit('machine', { type: 'auth', harness, status: { signedIn: h.auth.signedIn, label: h.auth.signedIn ? h.auth.account || 'Signed in' : null } });
  }

  /** The link a sign-in prints (from its terminal hyperlink if it uses one, else the first https URL), and a
   * device sign-in's code (like ABCD-12345), told to the clients when they first appear. */
  private watchLogin(t: Term, data: Uint8Array) {
    const login = t.info.login!;
    if (login.url && (login.code || login.harness !== 'codex')) return;
    t.loginText = ((t.loginText ?? '') + new TextDecoder().decode(data)).slice(-65536);
    const raw = t.loginText;
    const plain = raw.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '');
    const url = raw.match(/\x1b\]8;[^;]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/)?.[1] ?? plain.match(/https:\/\/[^\s"'<>]+/)?.[0] ?? null;
    const code = login.harness === 'codex' ? (plain.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4,5})\b/)?.[1] ?? null) : null;
    if (url !== login.url || code !== login.code) {
      t.info.login = { ...login, url: url ?? login.url, code: code ?? login.code };
      this.emit('machine', { type: 'terminal', terminal: t.info });
    }
  }

  attach(p: { id: string }) {
    const t = this.get(p.id);
    t.quiet = false;
    t.seen = Date.now();
    this.flush(t);
    return { info: t.info, scrollback: this.scrollback(t) };
  }

  /** The server has no client watching this terminal. */
  quiet(id: string) {
    const t = this.terms.get(id);
    if (!t || Date.now() - t.seen < 5000) return;
    t.quiet = true;
    t.out = [];
  }

  write(p: { id: string; data: string }) {
    const t = this.get(p.id);
    if (t.info.exited !== null) throw new RpcError(ERR.invalid, 'That terminal has ended');
    if (typeof p.data !== 'string' || p.data.length > 1024 * 1024) throw new RpcError(ERR.invalid, 'Bad input');
    t.proc.terminal!.write(p.data);
    return { ok: true };
  }

  resize(p: { id: string; cols: number; rows: number }) {
    const t = this.get(p.id);
    t.info.cols = clamp(p.cols, 10, 1000);
    t.info.rows = clamp(p.rows, 4, 300);
    if (t.info.exited === null) t.proc.terminal!.resize(t.info.cols, t.info.rows);
    return { ok: true };
  }

  close(p: { id: string }) {
    const t = this.get(p.id);
    if (t.info.exited === null) t.proc.kill('SIGHUP');
    this.terms.delete(p.id);
    this.emit('machine', { type: 'terminal_closed', id: p.id });
    return { ok: true };
  }

  shutdown() {
    for (const t of this.terms.values()) if (t.info.exited === null) t.proc.kill('SIGHUP');
  }

  private get(id: string): Term {
    const t = this.terms.get(id);
    if (!t) throw new RpcError(ERR.notFound, 'No such terminal');
    return t;
  }

  private output(t: Term, data: Uint8Array) {
    if (t.info.login) this.watchLogin(t, data);
    t.chunks.push(data);
    t.size += data.length;
    while (t.size > SCROLLBACK && t.chunks.length > 1) t.size -= t.chunks.shift()!.length;
    if (t.quiet) return;
    t.out.push(data);
    if (!t.timer) t.timer = setTimeout(() => this.flush(t), Math.max(FLUSH_MS, t.sent + MIN_GAP - Date.now()));
  }

  private flush(t: Term) {
    if (t.timer) clearTimeout(t.timer);
    t.timer = null;
    if (!t.out.length) return;
    t.sent = Date.now();
    const all = Buffer.concat(t.out);
    t.out = [];
    for (let i = 0; i < all.length; i += 256 * 1024) {
      this.emit('term:' + t.info.id, { type: 'output', data: b64(all.subarray(i, i + 256 * 1024)) });
    }
  }

  private scrollback(t: Term): string {
    return b64(Buffer.concat(t.chunks));
  }
}

function clamp(n: number, lo: number, hi: number) {
  return Math.min(hi, Math.max(lo, Math.round(Number(n) || lo)));
}
