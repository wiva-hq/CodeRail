// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Git for the Changes card, the way GitHub Desktop works: changes are HEAD against the files now; a commit takes the
// files and lines picked, built in an index of its own (so what was staged with `git add` elsewhere stays as it was);
// history with its actions; branches, stashes, merges and rebases, conflicts; fetch, pull and push.
import {
  type Caller, ERR, type GitBranch, type GitCommit, type GitCommitFile, type GitFile, type GitLines, type GitOperation, type GitPick,
  type GitRemote, type GitStash, type GitStatus,
} from '@coderail/protocol';
import { randomBytes } from 'node:crypto';
import { readFile, rm, stat, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcError, userEnv } from './env';
import { checkPath, checkWrite } from './scope';

const DIFF_MAX = 800 * 1024;
const NET = 110_000; // (under the hub's 120 s)

/**
 * For a caller limited to some folders, git runs nothing the repository itself names: no hooks, no fsmonitor,
 * no external diff or ssh command, no editor or signing program. (A repo's config or hooks are files such a caller
 * could have had an agent write.)
 */
const SAFE = [
  '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=ssh', '-c', 'diff.external=', '-c', 'core.pager=cat',
  '-c', 'protocol.ext.allow=never', '-c', 'core.editor=true', '-c', 'sequence.editor=true', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false',
  '-c', 'submodule.recurse=false',
];

/** A revision a client named: never something git would take as an option. */
function rev(v: unknown): string {
  if (typeof v !== 'string' || !/^[\w./~^@{}][\w./~^@{}-]*$/.test(v)) throw new RpcError(ERR.invalid, 'Bad revision');
  return v;
}

/** A branch, tag or remote name a client named (git check-ref-format has the last word). */
function refName(v: unknown, what = 'branch'): string {
  if (typeof v !== 'string' || !v || v.startsWith('-') || /[\s~^:?*[\\\0]|\.\.|@\{|\/\/|\.lock$|\/$|^\//.test(v)) throw new RpcError(ERR.invalid, `Bad ${what} name`);
  return v;
}

type Opts = { timeout?: number; ok?: number[]; input?: string; env?: Record<string, string> };

async function env(extra?: Record<string, string>) {
  return {
    ...(await userEnv()),
    GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C',
    // (Nothing waits on someone at the computer: no editor, no credential dialog.)
    GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never',
    ...extra,
  };
}

async function git(args: string[], cwd: string, caller: Caller, opts: Opts = {}) {
  const argv = ['git', ...(caller.folders ? SAFE : []), ...args];
  for (let tries = 0; ; tries++) {
    const p = Bun.spawn(argv, {
      cwd, env: await env(opts.env), stdout: 'pipe', stderr: 'pipe',
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : 'ignore',
    });
    const timer = setTimeout(() => p.kill(), opts.timeout ?? 30_000);
    const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    const code = await p.exited;
    clearTimeout(timer);
    // (Another git is at work in the repository, an agent's maybe: wait a moment for it.)
    if (code !== 0 && /index\.lock.*File exists/s.test(stderr) && tries < 4) { await Bun.sleep(400); continue; }
    if (code !== 0 && !(opts.ok ?? []).includes(code)) throw new RpcError(ERR.internal, plain((stderr || stdout).trim()) || `git ${args[0]} failed`);
    return { code, stdout, stderr };
  }
}

/** git's bytes as they are (a picture at a revision). */
async function gitBytes(args: string[], cwd: string, caller: Caller): Promise<Uint8Array | null> {
  const p = Bun.spawn(['git', ...(caller.folders ? SAFE : []), ...args], { cwd, env: await env(), stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' });
  const timer = setTimeout(() => p.kill(), 30_000);
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  clearTimeout(timer);
  return (await p.exited) === 0 ? out : null;
}

/** git's message, without its hints and with what it means said plainly where that helps. */
function plain(msg: string): string {
  const lines = msg.split('\n').filter((l) => !/^hint:/.test(l));
  const text = lines.join('\n').trim();
  if (/would be overwritten by (checkout|merge)/.test(text)) return 'Your changes to some files would be overwritten. Commit or stash them first.\n\n' + text;
  if (/Could not read from remote repository|Permission denied \(publickey\)|Authentication failed|could not read Username/.test(text)) return 'The computer couldn’t sign in to the remote. Check its git credentials (or `gh auth setup-git`).\n\n' + text;
  if (/\[rejected\].*\(fetch first\)|non-fast-forward/.test(text)) return 'The remote has commits you don’t have yet. Pull first.\n\n' + text;
  if (/stale info|\(stale info\)/.test(text)) return 'The remote changed since you last fetched. Fetch, then try again.\n\n' + text;
  return text;
}

const sha1 = (s: string) => new Bun.CryptoHasher('sha1').update(s).digest('hex');

// ---- The repository ---------------------------------------------------------------------------------------

type Repo = { top: string; gitDir: string; common: string };

async function repoOf(cwd: unknown, caller: Caller): Promise<Repo | null> {
  const dir = await checkPath(cwd, caller);
  const r = await git(['rev-parse', '--path-format=absolute', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'], dir, caller, { ok: [128] }).catch(() => null);
  if (!r || r.code !== 0) return null;
  const [top, gitDir, common] = r.stdout.trim().split('\n');
  // The whole repository must be the caller's, not just the folder they named: a repo rooted above it (a
  // dotfiles repo in ~, a planted core.worktree) would reach everything under that root.
  await checkPath(top, caller);
  if (caller.folders) await checkPath(gitDir, caller);
  return { top, gitDir, common: common || gitDir };
}

async function needRepo(cwd: unknown, caller: Caller): Promise<Repo> {
  const r = await repoOf(cwd, caller);
  if (!r) throw new RpcError(ERR.notFound, 'Not a git repository');
  return r;
}
const needRoot = async (cwd: unknown, caller: Caller) => (await needRepo(cwd, caller)).top;

/** One change at a time per repository (two people, or a person and a refresh, never fight over index.lock). */
const locks = new Map<string, Promise<unknown>>();
function locked<T>(root: string, work: () => Promise<T>): Promise<T> {
  const before = locks.get(root) ?? Promise.resolve();
  const p = before.catch(() => {}).then(work);
  locks.set(root, p);
  void p.finally(() => { if (locks.get(root) === p) locks.delete(root); }).catch(() => {});
  return p;
}

function paths(p: unknown): string[] {
  if (!Array.isArray(p) || !p.length || p.some((x) => typeof x !== 'string' || !x || x.startsWith('-') || x.includes('\0'))) throw new RpcError(ERR.invalid, 'Paths are needed');
  return p as string[];
}

async function emptyTree(root: string, caller: Caller) {
  return (await git(['hash-object', '-t', 'tree', '--stdin'], root, caller, { input: '' })).stdout.trim();
}

const exists = (p: string) => stat(p).then(() => true, () => false);
const text = (p: string) => readFile(p, 'utf8').then((s) => s.trim(), () => null);

// ---- Status -------------------------------------------------------------------------------------------------

export async function status(p: { cwd: string }, caller: Caller): Promise<GitStatus | null> {
  // (A repository reaching past the caller's folders reads as none.)
  const repo = await repoOf(p.cwd, caller).catch((e) => (e instanceof RpcError && e.code === ERR.forbidden ? null : Promise.reject(e)));
  if (!repo) return null;
  const r = repo.top;
  const out = (await git(['status', '--porcelain=v2', '--branch', '--show-stash', '-z', '--untracked-files=all'], r, caller)).stdout;
  const st: GitStatus = { root: r, branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [], stashes: 0 };
  const parts = out.split('\0');
  let ab = false;
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const v = rest.join(' ');
      if (key === 'branch.oid') st.head = v === '(initial)' ? null : v;
      else if (key === 'branch.head') st.branch = v === '(detached)' ? null : v;
      else if (key === 'branch.upstream') st.upstream = v;
      else if (key === 'stash') st.stashes = Number(v) || 0;
      else if (key === 'branch.ab') {
        const m = v.match(/\+(\d+) -(\d+)/);
        if (m) (st.ahead = +m[1]), (st.behind = +m[2]), (ab = true);
      }
      continue;
    }
    const kind = line[0];
    if (kind === '?') {
      st.files.push(file(line.slice(2), '?', '?'));
    } else if (kind === '1') {
      const f = line.split(' ');
      // (Added, then deleted before it was ever committed: nothing to show, as GitHub Desktop has it.)
      if (f[1] === 'AD') continue;
      st.files.push(file(f.slice(8).join(' '), f[1][0], f[1][1]));
    } else if (kind === '2') {
      const f = line.split(' ');
      const g = file(f.slice(9).join(' '), f[1][0], f[1][1]);
      g.orig = parts[++i];
      st.files.push(g);
    } else if (kind === 'u') {
      const f = line.split(' ');
      const g = file(f.slice(10).join(' '), f[1][0], f[1][1]);
      g.conflicted = true;
      st.files.push(g);
    }
  }
  st.files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  st.unborn = !st.head;
  st.upstreamGone = !!st.upstream && !ab;
  const [counts, operation, remote, fetched] = await Promise.all([
    numstat(r, st.unborn, caller).catch(() => new Map<string, [number, number]>()),
    operationOf(repo, st, caller).catch(() => null),
    remoteOf(r, caller).catch(() => null),
    stat(join(repo.common, 'FETCH_HEAD')).then((s) => Math.round(s.mtimeMs), () => null),
  ]);
  for (const f of st.files) {
    const c = counts.get(f.path);
    if (c) [f.added, f.removed] = c;
  }
  if (st.files.some((f) => f.conflicted)) {
    const marks = await markers(r, caller).catch(() => new Map<string, number>());
    for (const f of st.files) if (f.conflicted) f.markers = marks.get(f.path) ?? 0;
  }
  st.operation = operation;
  st.remote = remote?.remote ?? null;
  st.defaultBranch = remote?.defaultBranch ?? null;
  st.fetchedAt = fetched;
  return st;
}

function file(path: string, x: string, y: string): GitFile {
  const untracked = x === '?';
  const ix = x === '.' ? ' ' : x;
  const wt = y === '.' ? ' ' : y;
  return { path, index: ix, worktree: wt, staged: !untracked && ix !== ' ', unstaged: untracked || wt !== ' ', untracked, conflicted: false };
}

/** Lines added and removed per file since the last commit. */
async function numstat(root: string, unborn: boolean, caller: Caller) {
  const base = unborn ? await emptyTree(root, caller) : 'HEAD';
  const out = (await git(['diff', base, '--numstat', '-z', '--no-renames', '--no-ext-diff', '--no-textconv'], root, caller)).stdout;
  const m = new Map<string, [number, number]>();
  for (const rec of out.split('\0')) {
    const t = rec.split('\t');
    if (t.length >= 3 && t[0] !== '-') m.set(t.slice(2).join('\t'), [Number(t[0]), Number(t[1])]);
  }
  return m;
}

/** Conflict markers left in each conflicted file. */
async function markers(root: string, caller: Caller) {
  const out = (await git(['diff', '--check', '--no-ext-diff'], root, caller, { ok: [2] })).stdout;
  const m = new Map<string, number>();
  for (const line of out.split('\n')) {
    const x = line.match(/^(.+):\d+: leftover conflict marker/);
    if (x) m.set(x[1], (m.get(x[1]) ?? 0) + 1);
  }
  return m;
}

async function operationOf(repo: Repo, st: GitStatus, caller: Caller): Promise<GitOperation | null> {
  const g = repo.gitDir;
  const msg = async (f: string) => {
    const t = await text(join(g, f));
    return t ? t.split('\n').filter((l) => !l.startsWith('#')).join('\n').trim() : undefined;
  };
  for (const dir of ['rebase-merge', 'rebase-apply']) {
    if (!await exists(join(g, dir))) continue;
    const head = await text(join(g, dir, 'head-name'));
    const step = Number(await text(join(g, dir, dir === 'rebase-merge' ? 'msgnum' : 'next'))) || undefined;
    const total = Number(await text(join(g, dir, dir === 'rebase-merge' ? 'end' : 'last'))) || undefined;
    return { kind: 'rebase', target: head?.replace(/^refs\/heads\//, '') ?? null, step, total };
  }
  const subject = async (head: string | null) => head ? (await git(['log', '-1', '--format=%h %s', head], repo.top, caller).catch(() => null))?.stdout.trim() ?? null : null;
  if (await exists(join(g, 'MERGE_HEAD'))) {
    const message = await msg('MERGE_MSG');
    const named = message?.match(/^Merge (?:remote-tracking )?branch '([^']+)'/)?.[1];
    return { kind: 'merge', target: named ?? (await subject(await text(join(g, 'MERGE_HEAD')))), message };
  }
  if (await exists(join(g, 'CHERRY_PICK_HEAD'))) return { kind: 'cherry-pick', target: await subject(await text(join(g, 'CHERRY_PICK_HEAD'))), message: await msg('MERGE_MSG') };
  if (await exists(join(g, 'REVERT_HEAD'))) return { kind: 'revert', target: await subject(await text(join(g, 'REVERT_HEAD'))), message: await msg('MERGE_MSG') };
  // (A squash merge leaves SQUASH_MSG; it can be stale, so only while something is staged.)
  if (st.files.some((f) => f.staged) && await exists(join(g, 'SQUASH_MSG'))) return { kind: 'squash', target: null, message: await msg('SQUASH_MSG') };
  return null;
}

// ---- Remotes ------------------------------------------------------------------------------------------------

/** A remote URL as host/owner/repo; null for anything else (a local path, file://, ext::). (gh's own reading.) */
export function parseRemote(raw: string): { host: string; owner: string; repo: string } | null {
  let s = raw.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const m = /^(?:[^@/\s]+@)?([^@/:\s]+):(?!\/)(.+)$/.exec(s);
    if (!m || /^[A-Za-z]$/.test(m[1])) return null;
    s = `ssh://${m[1]}/${m[2]}`;
  }
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  if (!['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(scheme)) return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'ssh.github.com') host = 'github.com';
  let path: string;
  try { path = decodeURIComponent(u.pathname); } catch { return null; }
  const parts = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '').split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || repo === '.' || repo === '..') return null;
  return { host, owner, repo };
}

const isGitHub = (host: string) => host === 'github.com' || host.endsWith('.ghe.com') || host === process.env.GH_HOST;
const WEB_HOSTS = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);

/** The remotes, by name (URLs without user:password). */
export async function remotes(root: string, caller: Caller): Promise<Map<string, string>> {
  const out = (await git(['remote', '-v'], root, caller)).stdout;
  const m = new Map<string, string>();
  for (const line of out.split('\n')) {
    const x = line.match(/^(\S+)\t(\S+) \(fetch\)$/);
    if (x) m.set(x[1], x[2].replace(/^(https?:\/\/)[^/@\s]+@/, '$1'));
  }
  return m;
}

export function remoteInfo(name: string, url: string): GitRemote {
  const p = parseRemote(url);
  const web = p && (WEB_HOSTS.has(p.host) || isGitHub(p.host)) ? `https://${p.host}/${p.owner}/${p.repo}` : null;
  return { name, url, web, github: p && isGitHub(p.host) ? p : null };
}

/** The remote the branch pushes to (else origin, else the first), and that remote's default branch. */
async function remoteOf(root: string, caller: Caller) {
  const all = await remotes(root, caller);
  if (!all.size) return null;
  const push = (await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'], root, caller, { ok: [128] })).stdout.trim();
  const name = [...all.keys()].find((n) => push.startsWith(n + '/')) ?? (all.has('origin') ? 'origin' : [...all.keys()][0]);
  const head = (await git(['symbolic-ref', '--short', '-q', `refs/remotes/${name}/HEAD`], root, caller, { ok: [1, 128] })).stdout.trim();
  return { remote: remoteInfo(name, all.get(name)!), defaultBranch: head ? head.slice(name.length + 1) : null };
}

// ---- Diffs --------------------------------------------------------------------------------------------------

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--find-renames'];

/** One file's changes since the last commit (what the Changes list shows and a commit takes lines from). */
async function headDiff(root: string, path: string, orig: string | undefined, caller: Caller, opts: { untracked?: boolean; ws?: boolean } = {}) {
  await checkPath(join(root, path), caller);
  if (opts.untracked) {
    const d = await git(['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', path], root, caller, { ok: [1] });
    return d.stdout;
  }
  const head = (await git(['rev-parse', '-q', '--verify', 'HEAD'], root, caller, { ok: [1] })).code === 0 ? 'HEAD' : await emptyTree(root, caller);
  const only = orig && orig !== path ? ['--', orig, path] : ['--', path];
  return (await git(['diff', head, ...DIFF_FLAGS, ...(opts.ws === false ? ['-w'] : []), ...only], root, caller)).stdout;
}

export async function diff(p: { cwd: string; path?: string; orig?: string; staged?: boolean; head?: boolean; rev?: string; stash?: string; whitespace?: boolean }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  if (p.path) await checkPath(join(r, String(p.path)), caller);
  const ws = p.whitespace === false ? ['-w'] : [];
  const only = p.path ? ['--', p.path] : [];
  let out: string;
  if (p.stash) {
    out = (await git(['stash', 'show', '-p', '--include-untracked', ...DIFF_FLAGS, ...ws, rev(p.stash)], r, caller)).stdout;
    if (p.path) out = out.split(/(?=^diff --git )/m).filter((d) => d.startsWith(`diff --git a/${p.path} `) || d.includes(` b/${p.path}\n`)).join('');
  } else if (p.rev) {
    out = (await git(['show', '--format=', '--patch', '--diff-merges=first-parent', ...DIFF_FLAGS, ...ws, '--end-of-options', rev(p.rev), ...only], r, caller)).stdout;
  } else if (p.head && p.path) {
    const st = await status({ cwd: r }, caller);
    const f = st?.files.find((x) => x.path === p.path);
    out = await headDiff(r, p.path, p.orig ?? f?.orig, caller, { untracked: f?.untracked, ws: p.whitespace });
  } else if (p.staged) {
    out = (await git(['diff', '--cached', ...DIFF_FLAGS, ...ws, ...only], r, caller)).stdout;
  } else {
    out = (await git(['diff', ...DIFF_FLAGS, ...ws, ...only], r, caller)).stdout;
    // Untracked files show as new files.
    const st = await status({ cwd: r }, caller);
    const untracked = (st?.files ?? []).filter((f) => f.untracked && (!p.path || f.path === p.path));
    for (const f of untracked.slice(0, 50)) {
      if (out.length > DIFF_MAX) break;
      if (!await checkPath(join(r, f.path), caller).then(() => true, () => false)) continue; // (never CodeRail's own folder)
      const d = await git(['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', f.path], r, caller, { ok: [1] }).catch(() => null);
      if (d) out += d.stdout;
    }
  }
  const truncated = out.length > DIFF_MAX;
  return { diff: truncated ? out.slice(0, DIFF_MAX) : out, hash: sha1(out), truncated };
}

// ---- Patches of some lines ------------------------------------------------------------------------------------

type PLine = { k: ' ' | '+' | '-'; t: string; old: number; new: number; noEol: boolean };
type PHunk = { oldStart: number; newStart: number; lines: PLine[] };

function parsePatch(d: string) {
  const all = d.split('\n');
  if (all.at(-1) === '') all.pop();
  const header: string[] = [];
  const hunks: PHunk[] = [];
  let i = 0;
  for (; i < all.length && !all[i].startsWith('@@'); i++) header.push(all[i]);
  let cur: PHunk | null = null, o = 0, n = 0;
  for (; i < all.length; i++) {
    const l = all[i];
    const m = l.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (m) { cur = { oldStart: +m[1], newStart: +m[2], lines: [] }; hunks.push(cur); o = +m[1]; n = +m[2]; continue; }
    if (!cur) continue;
    if (l.startsWith('\\')) { const last = cur.lines.at(-1); if (last) last.noEol = true; continue; }
    const k = l[0] as PLine['k'];
    if (k === '+') cur.lines.push({ k, t: l.slice(1), old: 0, new: n++, noEol: false });
    else if (k === '-') cur.lines.push({ k, t: l.slice(1), old: o++, new: 0, noEol: false });
    else if (k === ' ') cur.lines.push({ k, t: l.slice(1), old: o++, new: n++, noEol: false });
  }
  return { header, hunks, binary: header.some((h) => h.startsWith('Binary files') || h === 'GIT binary patch') };
}

/**
 * The patch of the lines picked (GitHub Desktop's formatPatch). "commit": applied to the last commit's file, it gives
 * that file with only those changes (other removed lines stay, other added ones don't come). "discard": applied in
 * reverse to the file now, it takes only those changes back.
 */
function linesPatch(d: string, sel: GitLines, mode: 'commit' | 'discard'): string {
  const { header, hunks, binary } = parsePatch(d);
  if (binary || !hunks.length) throw new RpcError(ERR.invalid, 'Lines can’t be picked in this file');
  const dels = new Set(sel.dels), adds = new Set(sel.adds);
  const isNew = header.some((h) => h === '--- /dev/null');
  const isGone = header.some((h) => h === '+++ /dev/null');
  if (isGone && mode === 'discard') throw new RpcError(ERR.invalid, 'This file was deleted: discard all of it instead');
  const path = header.find((h) => h.startsWith('+++ b/'))?.slice(6) ?? header.find((h) => h.startsWith('--- a/'))?.slice(6) ?? sel.path;
  // (A patch that keeps the file: no "new file" when discarding some of a new file's lines, no "deleted" when
  // committing some of a deleted file's.)
  const head = mode === 'discard' && isNew ? [`--- a/${path}`, `+++ b/${path}`]
    : mode === 'commit' && isGone ? [`--- a/${path}`, `+++ b/${path}`]
    : header.filter((h) => h.startsWith('--- ') || h.startsWith('+++ ') || /^(new file mode)/.test(h));
  const out: string[] = [`diff --git a/${path} b/${path}`, ...head];
  // (Only the start on the side git places a hunk by matters: the old one going forward, the new one in reverse.)
  let shift = 0, changed = false;
  for (const h of hunks) {
    const body: string[] = [];
    let oc = 0, nc = 0, any = false;
    for (const l of h.lines) {
      let emit: string | null = null;
      if (l.k === ' ') { emit = ' ' + l.t; oc++; nc++; }
      else if (l.k === '+') {
        if (adds.has(l.new)) { emit = '+' + l.t; nc++; any = true; }
        else if (mode === 'discard') { emit = ' ' + l.t; oc++; nc++; }
      } else {
        if (dels.has(l.old)) { emit = '-' + l.t; oc++; any = true; }
        else if (mode === 'commit' && !isNew) { emit = ' ' + l.t; oc++; nc++; }
      }
      if (emit !== null) { body.push(emit); if (l.noEol) body.push('\\ No newline at end of file'); }
    }
    if (!any) continue;
    changed = true;
    const oldStart = mode === 'commit' ? h.oldStart : Math.max(h.newStart - shift, 0);
    const newStart = mode === 'commit' ? Math.max(h.oldStart + shift, 0) : h.newStart;
    out.push(`@@ -${oldStart}${oc === 1 ? '' : ',' + oc} +${newStart}${nc === 1 ? '' : ',' + nc} @@`, ...body);
    shift += nc - oc;
  }
  if (!changed) throw new RpcError(ERR.invalid, 'No lines were picked');
  return out.join('\n') + '\n';
}

/** The file's diff now, refused if it isn't the one the lines were picked in. */
async function sameDiff(root: string, sel: GitLines, caller: Caller) {
  const st = await status({ cwd: root }, caller);
  const f = st?.files.find((x) => x.path === sel.path);
  if (!f) throw new RpcError(ERR.invalid, `${sel.path} has no changes now`);
  if (f.orig) throw new RpcError(ERR.invalid, `${sel.path} was renamed: take all of it`);
  const d = await headDiff(root, sel.path, undefined, caller, { untracked: f.untracked });
  if (sha1(d) !== sel.hash) throw new RpcError(ERR.invalid, `${sel.path} changed since you looked. Review it again.`);
  if (d.length > DIFF_MAX) throw new RpcError(ERR.invalid, `${sel.path} is too large to take some of its lines`);
  return { d, f };
}

// ---- History ------------------------------------------------------------------------------------------------

const LOG_FORMAT = '%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%D%x1f%P%x1f%b%x1e';

function commits(out: string, local: Set<string>): GitCommit[] {
  return out.split('\x1e').map((s) => s.replace(/^\n/, '')).filter((s) => s.trim()).map((s) => {
    const [hash, short, author, email, at, subject, refs, parents, body] = s.split('\x1f');
    const tags = (refs ?? '').split(', ').filter((x) => x.startsWith('tag: ')).map((x) => x.slice(5));
    return { hash, short, author, email, at: Number(at) * 1000, subject, refs: refs ?? '', parents: parents ? parents.split(' ') : [], body: (body ?? '').trim(), local: local.has(hash), tags };
  });
}

/** Commits on HEAD that no remote has (or that its upstream hasn't). */
async function unpushed(root: string, caller: Caller): Promise<Set<string>> {
  const up = await git(['rev-list', '-n', '500', '@{upstream}..HEAD'], root, caller, { ok: [128] });
  const out = up.code === 0 ? up.stdout : (await git(['rev-list', '-n', '500', 'HEAD', '--not', '--remotes'], root, caller, { ok: [128] })).stdout;
  return new Set(out.split('\n').filter(Boolean));
}

export async function log(p: { cwd: string; limit?: number; skip?: number; path?: string; rev?: string }, caller: Caller): Promise<GitCommit[]> {
  const r = await needRoot(p.cwd, caller);
  const limit = Math.min(Math.max(Number(p.limit) || 50, 1), 500);
  const args = ['log', `--format=${LOG_FORMAT}`, `-n${limit}`, `--skip=${Number(p.skip) || 0}`];
  if (p.rev) args.push('--end-of-options', rev(p.rev));
  if (p.path) args.push('--', p.path);
  const res = await git(args, r, caller, { ok: [128] });
  if (res.code !== 0) return []; // no commits yet
  return commits(res.stdout, p.rev ? new Set() : await unpushed(r, caller));
}

export async function show(p: { cwd: string; rev: string }, caller: Caller): Promise<{ commit: GitCommit; files: GitCommitFile[] }> {
  const r = await needRoot(p.cwd, caller);
  const v = rev(p.rev);
  const [one, num, names, local] = await Promise.all([
    git(['log', '-1', `--format=${LOG_FORMAT}`, '--end-of-options', v], r, caller),
    git(['show', '--format=', '--numstat', '-z', '--diff-merges=first-parent', ...DIFF_FLAGS, '--end-of-options', v], r, caller),
    git(['show', '--format=', '--name-status', '-z', '--diff-merges=first-parent', ...DIFF_FLAGS, '--end-of-options', v], r, caller),
    unpushed(r, caller),
  ]);
  const commit = commits(one.stdout, local)[0];
  if (!commit) throw new RpcError(ERR.notFound, 'No such commit');
  const files: GitCommitFile[] = [];
  const ns = names.stdout.split('\0');
  for (let i = 0; i < ns.length; i++) {
    const s = ns[i];
    if (!s) continue;
    if (/^[RC]/.test(s)) { files.push({ status: s[0], orig: ns[i + 1], path: ns[i + 2], added: null, removed: null }); i += 2; }
    else { files.push({ status: s[0], path: ns[i + 1], added: null, removed: null }); i += 1; }
  }
  // (numstat -z: "a\tr\tpath\0", or for a rename "a\tr\t\0old\0new\0".)
  const nn = num.stdout.split('\0');
  for (let i = 0; i < nn.length; i++) {
    const t = nn[i].split('\t');
    if (t.length < 3) continue;
    let path = t.slice(2).join('\t');
    if (!path) { path = nn[i + 2]; i += 2; }
    const f = files.find((x) => x.path === path);
    if (f && t[0] !== '-') { f.added = Number(t[0]); f.removed = Number(t[1]); }
  }
  return { commit, files };
}

// ---- Branches, stashes, tags ----------------------------------------------------------------------------------

export async function branches(p: { cwd: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const fmt = '--format=%(refname:short)%1f%(upstream:short)%1f%(upstream:track)%1f%(committerdate:unix)%1f%(contents:subject)';
  const [l, rm, cur, reflog, rem] = await Promise.all([
    git(['for-each-ref', '--sort=-committerdate', fmt, 'refs/heads'], r, caller),
    git(['for-each-ref', '--sort=-committerdate', fmt, 'refs/remotes'], r, caller),
    git(['branch', '--show-current'], r, caller),
    git(['reflog', '-n', '300', '--format=%gs'], r, caller, { ok: [128] }).catch(() => ({ stdout: '' })),
    remoteOf(r, caller).catch(() => null),
  ]);
  const parse = (out: string): GitBranch[] => out.split('\n').filter(Boolean).map((line) => {
    const [name, upstream, track, at, subject] = line.split('\x1f');
    return {
      name, upstream: upstream || null, gone: track === '[gone]',
      ahead: Number(track.match(/ahead (\d+)/)?.[1] ?? 0), behind: Number(track.match(/behind (\d+)/)?.[1] ?? 0),
      at: Number(at) * 1000, subject: subject ?? '',
    };
  });
  const local = parse(l.stdout);
  const remote = parse(rm.stdout).filter((b) => !b.name.endsWith('/HEAD') && b.name.includes('/'));
  const current = cur.stdout.trim() || null;
  const recent: string[] = [];
  for (const line of reflog.stdout.split('\n')) {
    const m = line.match(/^checkout: moving from (.+) to (.+)$/);
    if (!m) continue;
    for (const b of [m[2], m[1]]) if (b !== current && !recent.includes(b) && local.some((x) => x.name === b)) recent.push(b);
    if (recent.length >= 5) break;
  }
  return { current, local, remote, recent: recent.slice(0, 5), default: rem?.defaultBranch ?? null };
}

export async function compare(p: { cwd: string; branch: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const out = (await git(['rev-list', '--left-right', '--count', `HEAD...${rev(p.branch)}`, '--'], r, caller)).stdout.trim().split(/\s+/);
  return { ahead: Number(out[0]) || 0, behind: Number(out[1]) || 0 };
}

/** GitHub Desktop's mark on a stash it made for a branch; CodeRail makes the same, so either app finds the other's. */
const STASH_MARK = (b: string) => `!!GitHub_Desktop<${b}>`;

export async function stashes(p: { cwd: string }, caller: Caller): Promise<GitStash[]> {
  const r = await needRoot(p.cwd, caller);
  const out = (await git(['stash', 'list', '--format=%gd%x1f%gs%x1f%ct'], r, caller)).stdout;
  return out.split('\n').filter(Boolean).map((line) => {
    const [ref, gs, ct] = line.split('\x1f');
    const desk = gs.match(/!!GitHub_Desktop<(.+)>/)?.[1];
    const on = gs.match(/^(?:WIP on|On) ([^:]+):\s*(.*)$/);
    const message = desk ? 'Changes left on ' + desk : on ? on[2] : gs;
    return { ref, message, branch: desk ?? on?.[1] ?? null, at: Number(ct) * 1000 };
  });
}

export async function tags(p: { cwd: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const out = (await git(['for-each-ref', '--sort=-creatordate', '--count=200', '--format=%(refname:short)%1f%(objectname)%1f%(creatordate:unix)', 'refs/tags'], r, caller)).stdout;
  return out.split('\n').filter(Boolean).map((l) => { const [name, hash, at] = l.split('\x1f'); return { name, hash, at: Number(at) * 1000 }; });
}

export async function fileAt(p: { cwd: string; path: string; rev: string; encoding?: 'base64' }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  if (typeof p.path !== 'string' || typeof p.rev !== 'string') throw new RpcError(ERR.invalid, 'path and rev are needed');
  await checkPath(join(r, p.path), caller);
  const spec = p.rev === ':' ? `:${p.path}` : `${rev(p.rev)}:${p.path}`;
  if (p.encoding === 'base64') {
    const b = await gitBytes(['show', '--no-textconv', '--end-of-options', spec], r, caller);
    return { content: b ? Buffer.from(b.subarray(0, DIFF_MAX)).toString('base64') : '', encoding: 'base64', truncated: !!b && b.length > DIFF_MAX };
  }
  const res = await git(['show', '--no-textconv', '--end-of-options', spec], r, caller, { ok: [128] });
  return { content: res.code === 0 ? res.stdout.slice(0, DIFF_MAX) : '', encoding: 'utf8' };
}

// ---- Changing files -----------------------------------------------------------------------------------------

export async function stage(p: { cwd: string; paths: string[] }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  await locked(r, () => git(['add', '-A', '--', ...paths(p.paths)], r, caller));
  return { ok: true };
}

export async function unstage(p: { cwd: string; paths: string[] }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  await locked(r, async () => {
    const res = await git(['restore', '--staged', '--', ...paths(p.paths)], r, caller, { ok: [128] });
    if (res.code !== 0) await git(['rm', '--cached', '-r', '-q', '--', ...paths(p.paths)], r, caller); // no commits yet
  });
  return { ok: true };
}

/** Back to the last commit, staged changes too; new files deleted. */
export async function discard(p: { cwd: string; paths: string[] }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const list = paths(p.paths);
  for (const x of list) await checkWrite(join(r, x), caller);
  await locked(r, async () => {
    const st = await status({ cwd: r }, caller);
    const of = (x: string) => st?.files.find((f) => f.path === x);
    const untracked = list.filter((x) => of(x)?.untracked);
    // (Added since the last commit: nothing to go back to, so it goes, like a new file.)
    const added = list.filter((x) => !of(x)?.untracked && (of(x)?.index === 'A' || st?.unborn));
    const tracked = list.filter((x) => !untracked.includes(x) && !added.includes(x));
    const renamedFrom = tracked.map((x) => of(x)?.orig).filter(Boolean) as string[];
    if (tracked.length) await git(['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked, ...renamedFrom], r, caller);
    if (added.length) await git(['rm', '-f', '-q', '--', ...added], r, caller);
    if (untracked.length) await git(['clean', '-f', '-q', '--', ...untracked], r, caller);
  });
  return { ok: true };
}

export async function discardLines(p: { cwd: string; lines: GitLines }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const sel = p.lines;
  if (!sel || typeof sel.path !== 'string' || typeof sel.hash !== 'string' || !Array.isArray(sel.dels) || !Array.isArray(sel.adds)) throw new RpcError(ERR.invalid, 'Pick some lines');
  paths([sel.path]);
  await checkWrite(join(r, sel.path), caller);
  await locked(r, async () => {
    const { d } = await sameDiff(r, sel, caller);
    await git(['apply', '-R', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'], r, caller, { input: linesPatch(d, sel, 'discard') });
  });
  return { ok: true };
}

export async function ignore(p: { cwd: string; pattern: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const pat = String(p.pattern ?? '').trim();
  if (!pat || /[\n\r\0]/.test(pat)) throw new RpcError(ERR.invalid, 'A pattern is needed');
  const file = await checkWrite(join(r, '.gitignore'), caller);
  const now = await readFile(file, 'utf8').catch(() => '');
  if (now.split('\n').some((l) => l.trim() === pat)) return { ok: true };
  await appendFile(file, (now && !now.endsWith('\n') ? '\n' : '') + pat + '\n');
  return { ok: true };
}

// ---- Commits ------------------------------------------------------------------------------------------------

function message(m: unknown, amend: boolean): string {
  if (typeof m !== 'string' || (!m.trim() && !amend)) throw new RpcError(ERR.invalid, 'Write a commit message');
  return m.trim() ? m.trim() + '\n' : '';
}

export async function commit(p: { cwd: string; message: string; amend?: boolean; picks?: GitPick[]; noVerify?: boolean }, caller: Caller) {
  const repo = await needRepo(p.cwd, caller);
  const r = repo.top;
  const amend = !!p.amend;
  const msg = message(p.message, amend);
  const tail = [...(msg ? ['-F', '-'] : ['--no-edit']), ...(amend ? ['--amend'] : []), ...(p.noVerify && !caller.folders ? ['--no-verify'] : [])];
  return locked(r, async () => {
    const st = await status({ cwd: r }, caller);
    if (!st) throw new RpcError(ERR.notFound, 'Not a git repository');
    if (!p.picks) {
      await git(['commit', ...tail], r, caller, { input: msg, timeout: 110_000 });
    } else {
      const picks = p.picks;
      for (const k of picks) {
        paths([k.path, ...(k.orig ? [k.orig] : [])]);
        await checkPath(join(r, k.path), caller);
      }
      if (!picks.length && !amend) throw new RpcError(ERR.invalid, 'Pick files to commit');
      const touched = [...new Set(picks.flatMap((k) => (k.orig ? [k.path, k.orig] : [k.path])))];
      if (st.operation && st.operation.kind !== 'squash' && st.operation.kind !== 'merge') throw new RpcError(ERR.invalid, `Finish the ${st.operation.kind} first`);
      if (st.operation) {
        // (Mid-merge the commit is the merge's own: the files go into the real index.)
        if (picks.some((k) => k.lines)) throw new RpcError(ERR.invalid, 'Take whole files while merging');
        if (touched.length) await git(['add', '-A', '--', ...touched], r, caller);
        await git(['commit', ...tail], r, caller, { input: msg, timeout: 110_000 });
      } else {
        const index = join(tmpdir(), `coderail-index-${randomBytes(6).toString('hex')}`);
        const env = { GIT_INDEX_FILE: index };
        try {
          await git(st.unborn ? ['read-tree', '--empty'] : ['read-tree', 'HEAD'], r, caller, { env });
          const whole = picks.filter((k) => !k.lines);
          if (whole.length) {
            const list = whole.flatMap((k) => (k.orig ? [k.orig, k.path] : [k.path]));
            await git(['update-index', '--add', '--remove', '--replace', '-z', '--stdin'], r, caller, { env, input: list.join('\0') + '\0' });
          }
          for (const k of picks.filter((x) => x.lines)) {
            const sel = { ...k.lines!, path: k.path };
            const { d } = await sameDiff(r, sel, caller);
            await git(['apply', '--cached', '--unidiff-zero', '--recount', '--whitespace=nowarn', '-'], r, caller, { env, input: linesPatch(d, sel, 'commit') });
          }
          if (!amend) {
            const base = st.unborn ? await emptyTree(r, caller) : 'HEAD';
            const same = await git(['diff', '--cached', '--quiet', base], r, caller, { env, ok: [1] });
            if (same.code === 0) throw new RpcError(ERR.invalid, 'Nothing to commit: the picked changes are already in the last commit');
          }
          await git(['commit', ...tail], r, caller, { env, input: msg, timeout: 110_000 });
        } finally {
          await rm(index, { force: true });
          await rm(index + '.lock', { force: true });
        }
        // (The real index catches up on what was committed; whatever else was staged stays staged.)
        if (touched.length) await git(['reset', '-q', '--', ...touched], r, caller, { ok: [1] });
      }
    }
    const hash = (await git(['rev-parse', 'HEAD'], r, caller)).stdout.trim();
    return { hash };
  });
}

/** Undoes the last commit (GitHub Desktop's Undo): its changes come back as changes, its message is returned. */
export async function undo(p: { cwd: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  return locked(r, async () => {
    const head = await git(['log', '-1', '--format=%P%x1f%B'], r, caller, { ok: [128] });
    if (head.code !== 0) throw new RpcError(ERR.invalid, 'There is no commit to undo');
    const [parents, ...body] = head.stdout.split('\x1f');
    const ps = parents.trim().split(' ').filter(Boolean);
    if (ps.length > 1) throw new RpcError(ERR.invalid, 'A merge commit can’t be undone here; reset to a commit instead');
    const pushed = (await git(['branch', '-r', '--contains', 'HEAD'], r, caller)).stdout.trim();
    if (pushed) throw new RpcError(ERR.invalid, 'That commit is pushed already; revert it instead');
    if (ps.length) await git(['reset', '--soft', 'HEAD^'], r, caller);
    else await git(['update-ref', '-d', 'HEAD'], r, caller);
    return { message: body.join('\x1f').trim() };
  });
}

// ---- Branches and operations ------------------------------------------------------------------------------------

async function conflicts(r: string, caller: Caller) {
  return !!(await status({ cwd: r }, caller))?.files.some((f) => f.conflicted);
}
/** A command that may stop for conflicts: its output, and whether it did. */
async function mayConflict(r: string, args: string[], caller: Caller, timeout = 60_000) {
  const res = await git(args, r, caller, { ok: [1], timeout });
  const c = await conflicts(r, caller);
  if (res.code !== 0 && !c) throw new RpcError(ERR.internal, plain((res.stderr || res.stdout).trim()) || `git ${args[0]} failed`);
  return { output: (res.stdout + res.stderr).trim(), conflicts: c };
}

export async function checkout(p: { cwd: string; branch?: string; create?: boolean; from?: string; track?: string; rev?: string; changes?: 'stash' | 'bring' }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  return locked(r, async () => {
    if (p.changes === 'stash') {
      const cur = (await git(['branch', '--show-current'], r, caller)).stdout.trim() || 'HEAD';
      await git(['stash', 'push', '--include-untracked', '-m', STASH_MARK(cur)], r, caller);
    }
    if (p.rev) await git(['switch', '--detach', '--end-of-options', rev(p.rev)], r, caller);
    else {
      const b = refName(p.branch);
      await git(['check-ref-format', '--branch', b], r, caller);
      if (p.track) await git(['switch', '-c', b, '--track', rev(p.track)], r, caller);
      else if (p.create) await git(['switch', '-c', b, ...(p.from ? [rev(p.from)] : [])], r, caller);
      else await git(['switch', b], r, caller);
    }
    return { ok: true };
  });
}

export async function branchRename(p: { cwd: string; from: string; to: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  await git(['check-ref-format', '--branch', refName(p.to)], r, caller);
  await locked(r, () => git(['branch', '-m', refName(p.from), p.to], r, caller));
  return { ok: true };
}

export async function branchDelete(p: { cwd: string; branch: string; remote?: boolean }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const b = refName(p.branch);
  return locked(r, async () => {
    let up: string | null = null;
    if (p.remote) {
      const remote = (await git(['config', '--get', `branch.${b}.remote`], r, caller, { ok: [1] })).stdout.trim();
      const merge = (await git(['config', '--get', `branch.${b}.merge`], r, caller, { ok: [1] })).stdout.trim().replace(/^refs\/heads\//, '');
      if (remote && merge) up = merge;
      if (up) await git(['push', refName(remote, 'remote'), '--delete', refName(up)], r, caller, { timeout: NET });
    }
    await git(['branch', '-D', b], r, caller);
    return { ok: true, remote: up };
  });
}

export async function merge(p: { cwd: string; branch: string; squash?: boolean }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  return locked(r, () => mayConflict(r, ['merge', '--no-edit', ...(p.squash ? ['--squash'] : []), '--end-of-options', rev(p.branch)], caller));
}

export async function rebase(p: { cwd: string; onto: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  return locked(r, () => mayConflict(r, ['-c', 'rebase.backend=merge', 'rebase', '--end-of-options', rev(p.onto)], caller, 110_000));
}

export async function revert(p: { cwd: string; rev: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const v = rev(p.rev);
  const parents = (await git(['log', '-1', '--format=%P', '--end-of-options', v], r, caller)).stdout.trim().split(' ').filter(Boolean);
  return locked(r, () => mayConflict(r, ['revert', '--no-edit', ...(parents.length > 1 ? ['-m', '1'] : []), '--end-of-options', v], caller));
}

export async function cherryPick(p: { cwd: string; revs: string[] }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  if (!Array.isArray(p.revs) || !p.revs.length) throw new RpcError(ERR.invalid, 'Pick some commits');
  return locked(r, () => mayConflict(r, ['cherry-pick', '--end-of-options', ...p.revs.map(rev)], caller));
}

/** The branch back to a commit; the changes since stay as changes (GitHub Desktop's Reset to commit). */
export async function reset(p: { cwd: string; rev: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  await locked(r, () => git(['reset', '--mixed', '-q', '--end-of-options', rev(p.rev)], r, caller, { ok: [1] }));
  return { ok: true };
}

export async function tag(p: { cwd: string; name: string; rev?: string; delete?: boolean }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const n = refName(p.name, 'tag');
  await git(['check-ref-format', `refs/tags/${n}`], r, caller);
  await locked(r, () => git(p.delete ? ['tag', '-d', n] : ['tag', n, ...(p.rev ? [rev(p.rev)] : [])], r, caller));
  return { ok: true };
}

/** The operation stopped for conflicts, carried on once they're resolved. */
export async function cont(p: { cwd: string; message?: string }, caller: Caller) {
  const repo = await needRepo(p.cwd, caller);
  const r = repo.top;
  return locked(r, async () => {
    const st = await status({ cwd: r }, caller);
    const op = st?.operation;
    if (!st || !op) throw new RpcError(ERR.invalid, 'Nothing to continue');
    const left = st.files.filter((f) => f.conflicted && (f.markers ?? 0) > 0);
    if (left.length) throw new RpcError(ERR.invalid, `${left.length === 1 ? left[0].path + ' still has' : left.length + ' files still have'} conflicts`);
    const done = st.files.filter((f) => f.conflicted).map((f) => f.path);
    if (done.length) await git(['add', '-A', '--', ...done], r, caller);
    const msg = typeof p.message === 'string' && p.message.trim() ? p.message.trim() + '\n' : null;
    if (op.kind === 'merge' || op.kind === 'squash') {
      const res = await git(['commit', ...(msg ? ['-F', '-'] : ['--no-edit'])], r, caller, { input: msg ?? undefined, timeout: 110_000 });
      return { output: (res.stdout + res.stderr).trim(), conflicts: false };
    }
    const res = await git([op.kind === 'rebase' ? 'rebase' : op.kind, '--continue'], r, caller, { ok: [1], timeout: 110_000 });
    const c = await conflicts(r, caller);
    if (res.code !== 0 && !c) throw new RpcError(ERR.internal, plain((res.stderr || res.stdout).trim()));
    return { output: (res.stdout + res.stderr).trim(), conflicts: c };
  });
}

export async function abort(p: { cwd: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  return locked(r, async () => {
    const op = (await status({ cwd: r }, caller))?.operation;
    if (!op) throw new RpcError(ERR.invalid, 'Nothing to abort');
    if (op.kind === 'squash') {
      await git(['reset', '--merge', '-q'], r, caller);
      const repo = await needRepo(r, caller);
      await rm(join(repo.gitDir, 'SQUASH_MSG'), { force: true });
    } else await git([op.kind === 'rebase' ? 'rebase' : op.kind, '--abort'], r, caller);
    return { ok: true };
  });
}

export async function resolve(p: { cwd: string; path: string; side: 'ours' | 'theirs' | 'mark' }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const [path] = paths([p.path]);
  await checkWrite(join(r, path), caller);
  await locked(r, async () => {
    if (p.side === 'ours' || p.side === 'theirs') {
      const res = await git(['checkout', `--${p.side}`, '--', path], r, caller, { ok: [1] });
      // (That side deleted the file: resolving to it deletes it.)
      if (res.code !== 0) { await git(['rm', '-q', '--', path], r, caller); return; }
    }
    await git(['add', '-A', '--', path], r, caller);
  });
  return { ok: true };
}

// ---- Stashes ------------------------------------------------------------------------------------------------

export async function stash(p: { cwd: string; message?: string; paths?: string[] }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const cur = (await git(['branch', '--show-current'], r, caller)).stdout.trim() || 'HEAD';
  const m = typeof p.message === 'string' && p.message.trim() ? p.message.trim().slice(0, 200) : STASH_MARK(cur);
  await locked(r, () => git(['stash', 'push', '--include-untracked', '-m', m, ...(p.paths?.length ? ['--', ...paths(p.paths)] : [])], r, caller));
  return { ok: true };
}

export async function stashApply(p: { cwd: string; ref: string; drop?: boolean }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  return locked(r, () => mayConflict(r, ['stash', p.drop ? 'pop' : 'apply', rev(p.ref)], caller));
}

export async function stashDrop(p: { cwd: string; ref: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  await locked(r, () => git(['stash', 'drop', rev(p.ref)], r, caller));
  return { ok: true };
}

// ---- The remote ---------------------------------------------------------------------------------------------

export async function fetch(p: { cwd: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const all = await remotes(r, caller);
  if (!all.size) throw new RpcError(ERR.invalid, 'This repository has no remote');
  const res = await git(['fetch', '--prune', ...(all.size > 1 ? ['--all'] : [])], r, caller, { timeout: NET });
  return { output: (res.stdout + res.stderr).trim() };
}

export async function pull(p: { cwd: string }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  // (Merging, unless the repository or the person chose rebasing: git refuses to guess for diverged branches.)
  const how = (await git(['config', '--get', 'pull.rebase'], r, caller, { ok: [1] })).stdout.trim();
  return locked(r, () => mayConflict(r, ['pull', ...(how ? [] : ['--no-rebase']), '--no-edit'], caller, NET));
}

export async function push(p: { cwd: string; setUpstream?: boolean; force?: boolean; tags?: boolean }, caller: Caller) {
  const r = await needRoot(p.cwd, caller);
  const flags = [...(p.force ? ['--force-with-lease'] : []), ...(p.tags ? ['--follow-tags'] : [])];
  let args = ['push', ...flags];
  if (p.setUpstream) {
    const all = await remotes(r, caller);
    if (!all.size) throw new RpcError(ERR.invalid, 'This repository has no remote to publish to');
    args = ['push', ...flags, '-u', all.has('origin') ? 'origin' : [...all.keys()][0], 'HEAD'];
  }
  const res = await git(args, r, caller, { timeout: NET });
  return { output: (res.stdout + res.stderr).trim() };
}

export async function init(p: { cwd: string }, caller: Caller) {
  const dir = await checkWrite(p.cwd, caller);
  if (await repoOf(dir, caller).catch(() => null)) throw new RpcError(ERR.invalid, 'It is a repository already');
  await git(['init', '-q'], dir, caller);
  return { ok: true };
}

export async function clone(p: { cwd: string; url: string; name?: string }, caller: Caller) {
  const dir = await checkPath(p.cwd, caller);
  const url = String(p.url ?? '').trim();
  if (!/^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)[^\s]+$/.test(url) || url.startsWith('-')) throw new RpcError(ERR.invalid, 'A repository address like https://github.com/owner/repo');
  const name = String(p.name || url.replace(/\/+$/, '').split(/[/:]/).pop()!.replace(/\.git$/, ''));
  if (!/^[\w][\w.-]*$/.test(name)) throw new RpcError(ERR.invalid, 'Name the folder with letters, digits, . _ or -');
  const dest = await checkWrite(join(dir, name), caller);
  if (await exists(dest)) throw new RpcError(ERR.invalid, `${name} already exists there`);
  await git(['-c', 'protocol.ext.allow=never', '-c', 'protocol.file.allow=never', 'clone', '--', url, dest], dir, caller, { timeout: NET });
  return { path: dest };
}

export { needRoot, git as runGit };
