// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// GitHub through the computer's own `gh`: its sign-in makes every call and keeps the token (CodeRail never sees one).
// Only fixed, repository-scoped operations, with the repository always the one in a folder the caller may use: no
// `gh api` passthrough, no -R from a client, nothing that opens a browser or an editor on the computer.
import { type Caller, ERR, type GhCheck, type GhPull, type GhRepo } from '@coderail/protocol';
import { RpcError, userEnv } from './env';
import { needRoot, push, remoteInfo, remotes, runGit, status } from './git';

const GH_SET = {
  GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_SPINNER_DISABLED: '1',
  GH_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1', CLICOLOR: '0',
  GH_BROWSER: 'true', // (a page gh would open on this computer goes nowhere)
  GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', SSH_ASKPASS_REQUIRE: 'never', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C',
};
const GH_DROP = ['GH_REPO', 'GH_FORCE_TTY', 'CLICOLOR_FORCE', 'GH_DEBUG', 'DEBUG'];
// (For a caller limited to some folders, the git gh runs itself gets the same safe settings as git.ts's.)
const SAFE_KV = [['core.fsmonitor', 'false'], ['core.hooksPath', '/dev/null'], ['core.sshCommand', 'ssh'], ['diff.external', ''], ['core.pager', 'cat'], ['protocol.ext.allow', 'never'], ['submodule.recurse', 'false']];

let ghPath: string | null | undefined;
async function gh(): Promise<string | null> {
  if (ghPath !== undefined) return ghPath;
  const PATH = (await userEnv()).PATH;
  ghPath = Bun.which('gh', { PATH }) ?? ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/opt/local/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh', '/snap/bin/gh'].find((p) => Bun.which(p)) ?? null;
  return ghPath;
}

/** Tokens and passwords out of anything that reaches a client. */
const scrub = (s: string) => s.replace(/\b(gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g, '[token]').replace(/(https?:\/\/)[^\s/@]+@/g, '$1');

class GhError extends RpcError {
  constructor(message: string, readonly needs?: 'install' | 'login') { super(ERR.internal, message); }
}

/** gh's failure said plainly. */
function plain(err: string): string {
  const e = scrub(err).trim();
  if (/not logged in|gh auth login|authentication required|HTTP 401/i.test(e)) return 'GitHub CLI isn’t signed in on this computer. Run `gh auth login` there.';
  if (/SAML|SSO/i.test(e)) return 'The organization needs single sign-on for this token: run `gh auth refresh` on the computer.\n\n' + e;
  if (/rate limit/i.test(e)) return 'GitHub’s rate limit was reached. Try again in a little while.';
  if (/could not resolve to a Repository|Could not resolve host/i.test(e)) return 'GitHub couldn’t find this repository with the computer’s sign-in.\n\n' + e;
  return e.split('\n').slice(0, 12).join('\n').slice(0, 4000);
}

async function run(args: string[], root: string, caller: Caller, opts: { input?: string; timeout?: number; ok?: number[] } = {}) {
  const bin = await gh();
  if (!bin) throw new GhError('GitHub CLI (gh) isn’t installed on this computer. Install it from cli.github.com.', 'install');
  const env: Record<string, string> = { ...(await userEnv()), ...GH_SET, GH_PATH: bin };
  for (const k of GH_DROP) delete env[k];
  if (caller.folders) {
    let n = Number(env.GIT_CONFIG_COUNT) || 0;
    for (const [k, v] of SAFE_KV) { env[`GIT_CONFIG_KEY_${n}`] = k; env[`GIT_CONFIG_VALUE_${n}`] = v; n++; }
    env.GIT_CONFIG_COUNT = String(n);
    env.GIT_ALLOW_PROTOCOL = 'https:http:ssh';
  }
  const p = Bun.spawn([bin, ...args], {
    cwd: root, env, stdout: 'pipe', stderr: 'pipe',
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : 'ignore',
  });
  const timer = setTimeout(() => p.kill(), opts.timeout ?? 30_000);
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(timer);
  if (code !== 0 && !(opts.ok ?? []).includes(code)) {
    const msg = plain(stderr || stdout) || `gh ${args[0]} failed`;
    throw new GhError(msg, code === 4 || /signed in|auth login/.test(msg) ? 'login' : undefined);
  }
  return { code, stdout: scrub(stdout), stderr: scrub(stderr) };
}

/** A short cache with one call in flight per key: many people watching one repository make one call. */
const cache = new Map<string, { at: number; p: Promise<any> }>();
function cached<T>(key: string, ttl: number, fresh: boolean, work: () => Promise<T>): Promise<T> {
  const c = cache.get(key);
  if (c && Date.now() - c.at < (fresh ? 5_000 : ttl)) return c.p;
  const p = work();
  cache.set(key, { at: Date.now(), p });
  p.catch(() => cache.delete(key));
  return p;
}
const forget = (root: string) => { for (const k of cache.keys()) if (k.startsWith(root + '\0')) cache.delete(k); };

const pr = (n: unknown) => {
  if (!Number.isInteger(n) || (n as number) < 1) throw new RpcError(ERR.invalid, 'A pull request number');
  return String(n);
};

// ---- The repository -------------------------------------------------------------------------------------------

/** The repository pull requests live in, from its remotes (upstream, then github, then origin, as gh picks). */
async function base(root: string, caller: Caller) {
  const all = await remotes(root, caller);
  const rank = (n: string) => (n === 'upstream' ? 3 : n === 'github' ? 2 : n === 'origin' ? 1 : 0);
  const gits = [...all].map(([n, u]) => remoteInfo(n, u)).filter((x) => x.github).sort((a, b) => rank(b.name) - rank(a.name));
  return gits[0] ?? null;
}

export async function repo(p: { cwd: string; fresh?: boolean }, caller: Caller): Promise<GhRepo | null> {
  const root = await needRoot(p.cwd, caller);
  const b = await base(root, caller);
  if (!b?.github) return null;
  const { host, owner, repo: name } = b.github;
  const out: GhRepo = { host, owner, repo: name, url: `https://${host}/${owner}/${name}`, gh: 'ok' };
  if (!await gh()) return { ...out, gh: 'missing' };
  return cached(root + '\0repo', 5 * 60_000, !!p.fresh, async () => {
    try {
      const r = await run(['repo', 'view', '--json', 'url,defaultBranchRef,viewerPermission,mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed,isFork'], root, caller);
      const j = JSON.parse(r.stdout);
      return {
        ...out, url: j.url ?? out.url, defaultBranch: j.defaultBranchRef?.name, permission: j.viewerPermission, isFork: !!j.isFork,
        mergeMethods: [j.squashMergeAllowed && 'squash', j.mergeCommitAllowed && 'merge', j.rebaseMergeAllowed && 'rebase'].filter(Boolean),
      } as GhRepo;
    } catch (e) {
      if (e instanceof GhError && e.needs === 'login') return { ...out, gh: 'signed-out' as const };
      throw e;
    }
  });
}

// ---- Pull requests --------------------------------------------------------------------------------------------

/** One check's state as gh buckets it (STARTUP_FAILURE counted as a failure). */
function bucket(c: any): GhCheck['bucket'] {
  const s = String(c.state || (c.status === 'COMPLETED' ? c.conclusion : c.status) || '').toUpperCase();
  if (s === 'SUCCESS') return 'pass';
  if (s === 'SKIPPED' || s === 'NEUTRAL') return 'skipping';
  if (['ERROR', 'FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'].includes(s)) return 'fail';
  if (s === 'CANCELLED') return 'cancel';
  return 'pending';
}

function checks(rollup: any[] | null | undefined): { counts: GhPull['checks']; list: GhCheck[] } {
  const counts = { pass: 0, fail: 0, pending: 0, skipping: 0, cancel: 0 };
  const list: GhCheck[] = (rollup ?? []).map((c) => {
    const b = bucket(c);
    counts[b]++;
    const link = c.detailsUrl || c.targetUrl || null;
    return { name: c.name || c.context || 'check', workflow: c.workflowName || null, bucket: b, link, runId: link?.match(/\/actions\/runs\/(\d+)/)?.[1] ?? null };
  });
  return { counts, list };
}

const FIELDS = 'number,title,url,state,isDraft,author,headRefName,baseRefName,reviewDecision,statusCheckRollup,updatedAt';

function pull(j: any, full = false): GhPull {
  const c = checks(j.statusCheckRollup);
  const out: GhPull = {
    number: j.number, title: j.title, url: j.url, state: j.state, draft: !!j.isDraft, author: j.author?.login ?? '',
    head: j.headRefName, base: j.baseRefName, review: j.reviewDecision ?? '', checks: c.counts, updatedAt: Date.parse(j.updatedAt) || 0,
  };
  if (full) Object.assign(out, { headOid: j.headRefOid, mergeable: j.mergeable, additions: j.additions, deletions: j.deletions, changedFiles: j.changedFiles, body: j.body ?? '', list: c.list });
  return out;
}

export async function pulls(p: { cwd: string; state?: string; mine?: boolean; fresh?: boolean }, caller: Caller): Promise<GhPull[]> {
  const root = await needRoot(p.cwd, caller);
  const state = ['open', 'closed', 'merged', 'all'].includes(String(p.state)) ? String(p.state) : 'open';
  return cached(`${root}\0pulls\0${state}\0${!!p.mine}`, 20_000, !!p.fresh, async () => {
    const r = await run(['pr', 'list', '--state', state, '--limit', '40', ...(p.mine ? ['--author', '@me'] : []), '--json', FIELDS], root, caller);
    return (JSON.parse(r.stdout) as any[]).map((j) => pull(j));
  });
}

export async function pullOne(p: { cwd: string; number?: number; fresh?: boolean }, caller: Caller): Promise<GhPull | null> {
  const root = await needRoot(p.cwd, caller);
  const st = await status({ cwd: root }, caller);
  if (p.number === undefined && !st?.branch) return null;
  const key = `${root}\0pull\0${p.number ?? st!.branch + '@' + st!.head}`;
  return cached(key, 15_000, !!p.fresh, async () => {
    const r = await run(['pr', 'view', ...(p.number !== undefined ? [pr(p.number)] : []), '--json', FIELDS + ',headRefOid,mergeable,additions,deletions,changedFiles,body'], root, caller, { ok: [1] });
    if (r.code !== 0) {
      if (/no pull requests found|no open pull requests/i.test(r.stderr)) return null;
      throw new GhError(plain(r.stderr));
    }
    return pull(JSON.parse(r.stdout), true);
  });
}

export async function prDiff(p: { cwd: string; number: number }, caller: Caller) {
  const root = await needRoot(p.cwd, caller);
  const r = await run(['pr', 'diff', pr(p.number), '--color', 'never'], root, caller, { timeout: 60_000 });
  const max = 800 * 1024;
  return { diff: r.stdout.slice(0, max), truncated: r.stdout.length > max };
}

export async function checkout(p: { cwd: string; number: number }, caller: Caller) {
  const root = await needRoot(p.cwd, caller);
  const st = await status({ cwd: root }, caller);
  if (st?.files.length) throw new RpcError(ERR.invalid, 'Commit or stash your changes first');
  await run(['pr', 'checkout', pr(p.number)], root, caller, { timeout: 110_000 });
  forget(root);
  return { ok: true };
}

export async function create(p: { cwd: string; title: string; body?: string; base?: string; draft?: boolean }, caller: Caller) {
  const root = await needRoot(p.cwd, caller);
  const title = String(p.title ?? '').trim();
  if (!title) throw new RpcError(ERR.invalid, 'Give it a title');
  const st = await status({ cwd: root }, caller);
  if (!st?.branch) throw new RpcError(ERR.invalid, 'Switch to a branch first');
  // (gh won't push on its own without asking: push with CodeRail's git first.)
  if (!st.upstream || st.upstreamGone) await push({ cwd: root, setUpstream: true }, caller);
  else if (st.ahead) await push({ cwd: root }, caller);
  const baseRef = p.base ? String(p.base) : null;
  if (baseRef && (baseRef.startsWith('-') || /\s/.test(baseRef))) throw new RpcError(ERR.invalid, 'Bad base branch');
  const r = await run(['pr', 'create', '--head', st.branch, ...(baseRef ? ['--base', baseRef] : []), '--title', title, '--body-file', '-', ...(p.draft ? ['--draft'] : [])], root, caller, { input: String(p.body ?? ''), timeout: 60_000, ok: [1] });
  if (r.code !== 0) {
    const exists = r.stderr.match(/already exists:?\s*(https:\/\/\S+)/);
    if (exists) return { url: exists[1], number: Number(exists[1].match(/\/pull\/(\d+)/)?.[1]) || null, existed: true };
    throw new GhError(plain(r.stderr));
  }
  forget(root);
  const url = r.stdout.trim().split('\n').pop()!;
  return { url, number: Number(url.match(/\/pull\/(\d+)/)?.[1]) || null };
}

export async function merge(p: { cwd: string; number: number; method: string; head: string }, caller: Caller) {
  const root = await needRoot(p.cwd, caller);
  if (!['merge', 'squash', 'rebase'].includes(p.method)) throw new RpcError(ERR.invalid, 'Merge, squash or rebase');
  if (typeof p.head !== 'string' || !/^[0-9a-f]{40}$/.test(p.head)) throw new RpcError(ERR.invalid, 'The pull request’s head commit is needed');
  await run(['pr', 'merge', pr(p.number), `--${p.method}`, '--match-head-commit', p.head], root, caller, { timeout: 60_000 });
  forget(root);
  return { ok: true };
}

export async function rerun(p: { cwd: string; runId: string; failed?: boolean }, caller: Caller) {
  const root = await needRoot(p.cwd, caller);
  if (!/^\d{1,20}$/.test(String(p.runId))) throw new RpcError(ERR.invalid, 'Bad run');
  await run(['run', 'rerun', String(p.runId), ...(p.failed ? ['--failed'] : [])], root, caller, { timeout: 60_000 });
  forget(root);
  return { ok: true };
}

/** A new GitHub repository from this one, pushed (only for callers with no folder limits: it acts as the owner). */
export async function publish(p: { cwd: string; name: string; private: boolean; description?: string }, caller: Caller) {
  if (caller.folders) throw new RpcError(ERR.forbidden, 'Only people with access to the whole computer can publish a new repository');
  const root = await needRoot(p.cwd, caller);
  const name = String(p.name ?? '').trim();
  if (!/^[\w.-]+(\/[\w.-]+)?$/.test(name) || name.startsWith('-')) throw new RpcError(ERR.invalid, 'Name it with letters, digits, . _ or - (owner/name for an organization)');
  if ((await remotes(root, caller)).has('origin')) throw new RpcError(ERR.invalid, 'It already has a remote named origin');
  const head = await runGit(['rev-parse', '-q', '--verify', 'HEAD'], root, caller, { ok: [1] });
  if (head.code !== 0) throw new RpcError(ERR.invalid, 'Make a first commit before publishing');
  const desc = String(p.description ?? '').trim().slice(0, 300);
  const r = await run(['repo', 'create', name, p.private ? '--private' : '--public', '--source', '.', '--remote', 'origin', '--push', ...(desc ? ['--description', desc] : [])], root, caller, { timeout: 110_000 });
  forget(root);
  return { url: r.stdout.trim().split('\n').find((l) => l.startsWith('https://')) ?? null };
}
