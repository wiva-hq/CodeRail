// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// One repository as the Changes card sees it (on `git.*` and `gh.*`): its status, branches, stashes, the GitHub
// repository and the current branch's pull request; which files and lines the next commit takes (all of every file
// to start with, as GitHub Desktop has it); and every action, with a toast when it ends and the status read again.
import type { GhPull, GhRepo, GitBranch, GitCommit, GitFile, GitPick, GitStash, GitStatus } from '@coderail/protocol';
import type { DiffLine } from '../components/DiffView.svelte';
import type { MachineConn } from './machine.svelte';
import { app } from './app.svelte';
import { plainError } from './api';
import { parseUnified, type FileDiff } from './diffs';

export type Diff = FileDiff & { hash: string; truncated?: boolean };
/** A file's lines picked, by "d<old>" and "a<new>", in the diff with that hash; `total`: how many it has. */
type Lines = { hash: string; on: Set<string>; total: number };

export const lineKey = (l: DiffLine) => (l.kind === 'del' ? 'd' + l.old : 'a' + l.new);
const keysOf = (d: FileDiff) => d.lines.filter((l) => l.kind === 'add' || l.kind === 'del').map(lineKey);

export class GitRepo {
  st = $state<GitStatus | null | undefined>(undefined);
  error = $state<string | null>(null);
  busy = $state<string | null>(null);
  branches = $state<{ current: string | null; local: GitBranch[]; remote: GitBranch[]; recent: string[]; default: string | null } | null>(null);
  stashes = $state<GitStash[]>([]);
  head = $state<GitCommit | null>(null);
  gh = $state<GhRepo | null | undefined>(undefined);
  pull = $state<GhPull | null | undefined>(undefined);
  /** Files left out of the next commit, and files only some of whose lines it takes. */
  out = $state<Set<string>>(new Set());
  lines = $state<Record<string, Lines>>({});
  /** The diffs read, by path. */
  diffs = $state<Record<string, Diff | 'loading' | { error: string }>>({});
  /** A commit message to put back in the box (after Undo). */
  restored = $state<string | null>(null);
  hideSpace = $state(false);
  /** History asked the commit box to amend the last commit. */
  amendNow = $state(false);
  /** Bumped when history may have changed (a commit, a pull, a reset). */
  logStamp = $state(0);
  private gen = 0;
  private lastHead: string | null | undefined;

  constructor(readonly conn: MachineConn, readonly dir: string) {}

  get can() { return this.conn.canAct; }
  get why() { return !this.conn.online ? 'The computer is offline' : 'Viewers can’t change the repository'; }
  /** Whoever may act everywhere on the computer (gh acts as its owner for a new repository). */
  get everywhere() { return !!this.conn.scope && !this.conn.scope.folders; }
  call<T = any>(method: string, params: Record<string, unknown> = {}, timeout?: number) {
    return this.conn.call<T>(method, { cwd: this.dir, ...params }, timeout);
  }

  async load() {
    if (!this.conn.online) return;
    const g = ++this.gen;
    try {
      const st = await this.call<GitStatus | null>('git.status');
      if (g !== this.gen) return;
      this.st = st;
      this.error = null;
      if (!st) return;
      const at = `${st.branch}@${st.head}`;
      if (this.lastHead !== undefined && this.lastHead !== at) this.logStamp++;
      this.lastHead = at;
      // (What was picked stays picked while the file is there; a file that went is forgotten.)
      const paths = new Set(st.files.map((f) => f.path));
      this.out = new Set([...this.out].filter((p) => paths.has(p)));
      const lines = { ...this.lines };
      for (const p of Object.keys(lines)) if (!paths.has(p)) delete lines[p];
      this.lines = lines;
      const diffs = { ...this.diffs };
      for (const p of Object.keys(diffs)) if (!paths.has(p)) delete diffs[p];
      this.diffs = diffs;
      void this.side(g);
    } catch (e) { if (g === this.gen) this.error = plainError(e); }
  }

  /** The rest, after the status: stashes, the last commit, GitHub. */
  private async side(g: number) {
    const st = this.st;
    if (!st) return;
    const [stashes, head] = await Promise.all([
      st.stashes ? this.call<GitStash[]>('git.stashes').catch(() => []) : Promise.resolve([]),
      st.unborn ? Promise.resolve([]) : this.call<GitCommit[]>('git.log', { limit: 1 }).catch(() => []),
    ]);
    if (g !== this.gen) return;
    this.stashes = stashes;
    this.head = head[0] ?? null;
    if (this.gh === undefined && st.remote?.github) this.gh = await this.call<GhRepo | null>('gh.repo').catch(() => null);
    else if (!st.remote?.github) this.gh = null;
    if (this.gh?.gh === 'ok' && st.branch && st.branch !== (this.gh.defaultBranch ?? st.defaultBranch)) {
      this.pull = await this.call<GhPull | null>('gh.pull').catch(() => null);
    } else this.pull = null;
  }

  async loadBranches() {
    this.branches = await this.call('git.branches').catch(() => ({ current: this.st?.branch ?? null, local: [], remote: [], recent: [], default: null }));
    return this.branches!;
  }

  /** Runs an action: busy while it runs, a toast when it ends (its own, or git's last line), then a fresh status. */
  async run<T = any>(label: string, method: string, params: Record<string, unknown> = {}, ok?: string | ((r: T) => string | null), timeout = 60_000): Promise<T | undefined> {
    this.busy = label;
    let r: T | undefined;
    try {
      r = await this.call<T>(method, params, timeout);
      const said = typeof ok === 'function' ? ok(r) : ok;
      if ((r as any)?.conflicts) app.toast('Stopped for conflicts: resolve them, then continue', 'warning');
      else if (said) app.toast(said, 'success');
      else if (said === undefined && (r as any)?.output) app.toast(String((r as any).output).trim().split('\n').filter((l) => !/^hint:/.test(l)).at(-1) || 'Done', 'success');
    } catch (e) { app.toast(plainError(e), 'warning'); r = undefined; }
    this.busy = null;
    await this.load();
    return r;
  }

  // ---- the diff of a changed file (HEAD against the file now)
  async loadDiff(f: GitFile) {
    // (Read again: the one shown stays until the new one is here.)
    const had = this.diffs[f.path];
    if (!had || had === 'loading' || 'error' in had) this.diffs = { ...this.diffs, [f.path]: 'loading' };
    try {
      const r = await this.call<{ diff: string; hash: string; truncated?: boolean }>('git.diff', { path: f.path, orig: f.orig, head: true, ...(this.hideSpace ? { whitespace: false } : {}) });
      const d = parseUnified(r.diff)[0] ?? { path: f.path, lines: [], added: 0, removed: 0, binary: false };
      this.diffs = { ...this.diffs, [f.path]: { ...d, path: f.path, hash: r.hash, truncated: r.truncated } };
      // (The file changed since its lines were picked: they're picked again from scratch, all of them.)
      const l = this.lines[f.path];
      if (l && l.hash !== r.hash && !this.hideSpace) { const x = { ...this.lines }; delete x[f.path]; this.lines = x; app.toast(`${f.path.split('/').pop()} changed: its lines are all picked again`, 'info'); }
    } catch (e) { this.diffs = { ...this.diffs, [f.path]: { error: plainError(e) } }; }
  }

  // ---- what the next commit takes
  /** 'all', 'some' or 'none' of a file. */
  state(path: string): 'all' | 'some' | 'none' {
    if (this.out.has(path)) return 'none';
    return this.lines[path] ? 'some' : 'all';
  }
  setFile(path: string, on: boolean) {
    const out = new Set(this.out);
    if (on) out.delete(path); else out.add(path);
    this.out = out;
    if (this.lines[path]) { const x = { ...this.lines }; delete x[path]; this.lines = x; }
  }
  setAll(on: boolean) {
    this.out = on ? new Set() : new Set((this.st?.files ?? []).map((f) => f.path));
    this.lines = {};
  }
  /** Whether lines of this file can be picked one by one. */
  canPick(f: GitFile): boolean {
    const d = this.diffs[f.path];
    return this.can && !this.hideSpace && !f.orig && !f.conflicted && !this.st?.operation && !!d && d !== 'loading' && !('error' in d) && !d.binary && !d.truncated && d.lines.length > 0;
  }
  has(path: string, l: DiffLine) {
    if (this.out.has(path)) return false;
    const x = this.lines[path];
    return x ? x.on.has(lineKey(l)) : true;
  }
  pick(path: string, ls: DiffLine[], on: boolean) {
    const d = this.diffs[path];
    if (!d || d === 'loading' || 'error' in d) return;
    const all = keysOf(d);
    const cur = this.out.has(path) ? new Set<string>() : this.lines[path]?.on ?? new Set(all);
    const next = new Set(cur);
    for (const l of ls) { if (on) next.add(lineKey(l)); else next.delete(lineKey(l)); }
    const lines = { ...this.lines };
    const out = new Set(this.out);
    if (next.size === all.length) { delete lines[path]; out.delete(path); }
    else if (next.size === 0) { delete lines[path]; out.add(path); }
    else { lines[path] = { hash: d.hash, on: next, total: all.length }; out.delete(path); }
    this.lines = lines; this.out = out;
  }
  /** The files (and lines) to commit. */
  picks(): GitPick[] {
    return (this.st?.files ?? []).filter((f) => !this.out.has(f.path)).map((f) => {
      const l = this.lines[f.path];
      if (!l) return { path: f.path, ...(f.orig ? { orig: f.orig } : {}) };
      const keys = [...l.on];
      return { path: f.path, lines: { path: f.path, hash: l.hash, dels: keys.filter((k) => k[0] === 'd').map((k) => +k.slice(1)), adds: keys.filter((k) => k[0] === 'a').map((k) => +k.slice(1)) } };
    });
  }
  get picked() { return (this.st?.files ?? []).filter((f) => !this.out.has(f.path)).length; }
  /** After a commit: everything is picked again. */
  clearPicks() { this.out = new Set(); this.lines = {}; this.diffs = {}; }
}

/** GitHub's links, built here (never `gh browse`, which would open a browser on the computer). */
export const ghLink = {
  commit: (web: string, sha: string) => `${web}/commit/${sha}`,
  tree: (web: string, ref: string) => `${web}/tree/${ref.split('/').map(encodeURIComponent).join('/')}`,
  compare: (web: string, base: string, head: string) => `${web}/compare/${encodeURIComponent(base)}...${head.split('/').map(encodeURIComponent).join('/')}?expand=1`,
};

/** Opens a page in this browser (a new tab), https only. */
export function openWeb(url: string) {
  if (/^https:\/\//.test(url)) window.open(url, '_blank', 'noopener');
}

/** A file's state as a word and a letter: New, Modified, Deleted, Renamed, Conflicted. */
export function kindOf(f: GitFile): { letter: string; word: string } {
  if (f.conflicted) return { letter: '!', word: 'Conflicted' };
  if (f.untracked || f.index === 'A') return { letter: 'A', word: 'New' };
  if (f.index === 'D' || f.worktree === 'D') return { letter: 'D', word: 'Deleted' };
  if (f.orig) return { letter: 'R', word: 'Renamed' };
  return { letter: 'M', word: 'Modified' };
}
