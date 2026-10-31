// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The wire shared by the web UI, the server (and its hub per machine) and the bridge.
//
// Clients talk to one machine at a time over a WebSocket at /api/machines/<id>/ws. The bridge holds
// one WebSocket to its machine's hub at /api/bridge. Every frame is one JSON object.
//
//   client -> hub      {t:"req", id, method, params}
//   hub -> client      {t:"res", id, result} | {t:"res", id, error}
//   hub -> client      {t:"ev", topic, data}
//   hub -> bridge      {t:"req", id, method, params, caller}
//   bridge -> hub      {t:"res", id, result|error} | {t:"ev", topic, data}
//
// Some methods are answered by the hub itself (sessions, history, subscriptions); the rest go to the
// bridge. See METHODS below for which, and who may call them.

export type Role = 'owner' | 'operator' | 'viewer';

/** What a user may do on one machine. Folders and harnesses are limits for operators; null = any. */
export interface Scope {
  role: Role;
  folders: string[] | null;
  harnesses: string[] | null;
  terminal: boolean;
}

export interface Caller extends Scope {
  userId: string;
  username: string;
}

export interface RpcError {
  code: number;
  message: string;
}

export const ERR = {
  parse: -32700,
  invalid: -32602,
  notFound: -32004,
  forbidden: -32003,
  offline: -32010,
  timeout: -32011,
  internal: -32603,
  method: -32601,
} as const;

export type ServerFrame =
  | { t: 'res'; id: number | string; result?: any; error?: RpcError }
  | { t: 'ev'; topic: string; data: any }
  | { t: 'pong' };

export type BridgeInFrame =
  | { t: 'req'; id: string; method: string; params?: any; caller: Caller }
  // (A oneWay method: the bridge runs it and sends nothing back.)
  | { t: 'note'; method: string; params?: any; caller: Caller }
  // (No client is watching this terminal: keep its output for the scrollback, send none until it's attached again.)
  | { t: 'term_quiet'; id: string }
  // (No client is watching this Camofox tab: stop its frames until it's attached or watched again.)
  | { t: 'browser_quiet'; id: string }
  // (No client is looking at this folder: stop watching it until it's listed again.)
  | { t: 'fs_quiet'; path: string }
  | { t: 'ping' };

export type BridgeOutFrame =
  | { t: 'hello'; info: MachineInfo; live: LiveState }
  | { t: 'res'; id: string; result?: any; error?: RpcError }
  | { t: 'ev'; topic: string; data: any }
  | { t: 'pong' };

// ---- Machine ---------------------------------------------------------------------------------------

export interface HarnessInfo {
  id: string; // "claude-code" | "codex"
  name: string;
  installed: boolean;
  path: string | null;
  version: string | null;
  /** Whether it's signed in on the machine, from its own status command; absent if it couldn't tell. */
  auth?: HarnessAuth | null;
}

export interface HarnessAuth {
  signedIn: boolean;
  /** The account, like an email, when the harness says. */
  account?: string | null;
}

export interface MachineInfo {
  hostname: string;
  os: string; // "darwin" | "linux" | "win32"
  arch: string;
  home: string;
  user: string;
  bridgeVersion: string;
  harnesses: HarnessInfo[];
}

/** What is running on the bridge right now, sent with hello so the hub can reconcile. */
export interface LiveState {
  sessions: { sessionId: string; harness: string; busy: boolean }[];
  terminals: TerminalInfo[];
  approvals: Approval[];
  /** The agents' background tasks still running, each as its async_task_spawned update with what came since. */
  tasks?: { sessionId: string; update: any }[];
}

/** A machine as GET /api/machines lists it. */
export interface MachineSummary {
  id: string;
  name: string;
  ownerId: string;
  ownerName: string;
  online: boolean;
  lastSeen: number | null;
  info: MachineInfo | null;
  scope: Scope;
  createdAt: number;
}

// ---- Agents ----------------------------------------------------------------------------------------

export interface SessionRow {
  sessionId: string;
  harness: string;
  cwd: string;
  title: string | null;
  state: 'idle' | 'running' | 'closed';
  createdBy: string | null; // username
  createdAt: number;
  updatedAt: number;
  pending: number; // approvals waiting
  modes?: any; // ACP SessionModeState as the harness last reported it
  models?: any; // ACP SessionModelState (unstable)
  configOptions?: any[]; // ACP session config options
}

/** One entry of a session's log, kept by the hub. */
export interface LogEntry {
  seq: number;
  at: number;
  kind:
    | 'user' // {prompt: ContentBlock[], by: username}
    | 'update' // the ACP session/update `update` object
    | 'approval' // Approval
    | 'answer' // {approvalId, optionId|null, by}
    | 'turn' // {stopReason, usage?}
    | 'error' // {message}
    | 'notice'; // {text}
  data: any;
}

export interface Approval {
  id: string;
  sessionId: string;
  harness: string;
  toolCall: any; // ACP ToolCallUpdate
  options: { optionId: string; name: string; kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
  at: number;
}

/** Something an agent left running in the background (a backgrounded shell, a subagent), from the adapter's
 *  async_task_* updates. Kept by the hub while it runs. */
export interface AgentTask {
  id: string;
  sessionId: string;
  harness: string;
  name: string;
  taskType?: string;
  description?: string;
  summary?: string;
  state: 'running' | 'paused';
  canStop: boolean;
  at: number;
}

export interface LocalSession {
  sessionId: string;
  harness: string;
  cwd: string;
  title: string | null;
  updatedAt: string | null;
}

// ---- Terminals ---------------------------------------------------------------------------------------

export interface TerminalInfo {
  id: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  startedAt: number;
  exited: number | null; // exit code, null while running
  by: string | null;
  /** A harness's sign-in (harness.login): the link it asks you to open and, for a device sign-in, the code to
   * enter there, as soon as it prints them. */
  login?: { harness: string; url: string | null; code: string | null };
}

// ---- Files and git ---------------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  path: string; // absolute
  kind: 'dir' | 'file' | 'link';
  size: number;
  mtime: number;
}

export interface FileContent {
  path: string;
  size: number;
  mtime: number;
  mime: string;
  encoding: 'utf8' | 'base64';
  content: string;
  truncated: boolean;
}

export interface GitFile {
  path: string;
  orig?: string; // for renames
  index: string; // status letter in the index (" " none, M, A, D, R, C, U, ?)
  worktree: string; // status letter in the worktree
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
  /** Lines added and removed since the last commit (HEAD against the file now); absent for binary files. */
  added?: number;
  removed?: number;
  /** A conflicted file's conflict markers still in it (3 per conflict). */
  markers?: number;
}

/** A merge, rebase, cherry-pick or revert stopped part way (for conflicts), or a squash merge not yet committed. */
export interface GitOperation {
  kind: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'squash';
  /** What is being merged, or the branch being rebased. */
  target: string | null;
  /** A rebase's progress. */
  step?: number;
  total?: number;
  /** The commit message git prepared (MERGE_MSG). */
  message?: string;
}

export interface GitRemote {
  name: string;
  url: string; // without any user:password
  /** Its page on the web (https://github.com/owner/repo), when the host is one CodeRail knows. */
  web: string | null;
  github: { host: string; owner: string; repo: string } | null;
}

export interface GitStatus {
  root: string;
  branch: string | null; // null when detached
  head: string | null;
  upstream: string | null;
  /** The upstream is set but its branch is gone from the remote. */
  upstreamGone?: boolean;
  ahead: number;
  behind: number;
  files: GitFile[];
  /** No commits yet. */
  unborn?: boolean;
  operation?: GitOperation | null;
  stashes?: number;
  /** When the remote was last fetched (FETCH_HEAD's time). */
  fetchedAt?: number | null;
  /** The remote the branch pushes to, or origin. */
  remote?: GitRemote | null;
  /** The remote's default branch (origin/HEAD), like "main". */
  defaultBranch?: string | null;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  at: number;
  subject: string;
  refs: string;
  body?: string;
  parents?: string[];
  /** Not pushed yet (not on the upstream, or on no remote). */
  local?: boolean;
  tags?: string[];
}

export interface GitCommitFile {
  path: string;
  orig?: string;
  status: string; // A M D R C T
  added: number | null; // null for binary
  removed: number | null;
}

export interface GitBranch {
  name: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  gone: boolean;
  at: number;
  subject: string;
}

export interface GitStash {
  ref: string; // stash@{n}
  message: string;
  /** The branch it was made on, when CodeRail or GitHub Desktop made it. */
  branch: string | null;
  at: number;
}

/** Which lines of a file to take, by their numbers in the diff it was read with (hash: that diff's `hash`). */
export interface GitLines {
  path: string;
  hash: string;
  dels: number[]; // old line numbers
  adds: number[]; // new line numbers
}

/** A file to commit: all of it, or some of its lines. */
export type GitPick = { path: string; orig?: string; lines?: GitLines };

/** A GitHub repository as the computer's `gh` sees it. */
export interface GhRepo {
  host: string;
  owner: string;
  repo: string;
  url: string;
  /** gh on the computer: 'ok', 'missing' (not installed) or 'signed-out'. */
  gh: 'ok' | 'missing' | 'signed-out';
  defaultBranch?: string;
  permission?: string; // ADMIN, MAINTAIN, WRITE, TRIAGE, READ
  mergeMethods?: ('merge' | 'squash' | 'rebase')[];
  isFork?: boolean;
}

export interface GhCheck {
  name: string;
  workflow: string | null;
  bucket: 'pass' | 'fail' | 'pending' | 'skipping' | 'cancel';
  link: string | null;
  /** The Actions run, when the check is one (for Re-run). */
  runId: string | null;
}

export interface GhPull {
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  author: string;
  head: string;
  headOid?: string;
  base: string;
  review: string; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED or ""
  checks: { pass: number; fail: number; pending: number; skipping: number; cancel: number };
  updatedAt: number;
  mergeable?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  body?: string;
  /** The PR's checks one by one (gh.pr only). */
  list?: GhCheck[];
}

// ---- Methods ---------------------------------------------------------------------------------------

/**
 * Every method a client may call, where it runs, and the least role that may call it.
 * `needs` adds a requirement beyond the role: "terminal" = the caller's terminal grant.
 * Folder and harness limits are applied where a path/cwd/harness param is given.
 */
// (oneWay: the hub answers {ok} itself and hands the bridge a note, which it never answers: for input sent many times a
// second, where a reply each would double what crosses the hub.)
export const METHODS: Record<string, { at: 'hub' | 'bridge'; role: Role; needs?: 'terminal'; oneWay?: true }> = {
  // the hub itself
  'sub': { at: 'hub', role: 'viewer' }, // {topics: string[]} subscribe; "machine", "session:<id>", "term:<id>", "fs:<folder>"
  'unsub': { at: 'hub', role: 'viewer' }, // {topics}
  'machine.info': { at: 'hub', role: 'viewer' }, // -> {online, info: MachineInfo|null, scope: Scope}
  'agent.sessions': { at: 'hub', role: 'viewer' }, // {cwd?} -> SessionRow[]
  'agent.history': { at: 'hub', role: 'viewer' }, // {sessionId, after?: seq, limit?} -> {entries: LogEntry[], session: SessionRow, more} (more: call again with after = last seq)
  'agent.approvals': { at: 'hub', role: 'viewer' }, // -> Approval[] (pending)
  'agent.tasks': { at: 'hub', role: 'viewer' }, // -> AgentTask[] (running in the background)
  'agent.retitle': { at: 'bridge', role: 'operator' }, // {sessionId} asks the agent to name the session again (Claude Code's /rename) -> {title}
  'agent.limits': { at: 'bridge', role: 'operator' }, // {fresh?} Claude's plan usage limits on this computer's login -> {plan, windows: [{id, label, used: 0-100, resetsAt}], at} | null
  'agent.rename': { at: 'hub', role: 'operator' }, // {sessionId, title} the title CodeRail shows for it (empty: the agent's own)
  'agent.forget': { at: 'hub', role: 'operator' }, // {sessionId} removes it from CodeRail's list (not the harness's history)

  // agents (bridge)
  'agent.harnesses': { at: 'bridge', role: 'viewer' }, // -> HarnessInfo[]
  'agent.local': { at: 'bridge', role: 'viewer' }, // {harness, cwd?} -> LocalSession[] (the harness's own session list)
  'agent.new': { at: 'bridge', role: 'operator' }, // {harness, cwd} -> SessionRow
  'agent.open': { at: 'bridge', role: 'operator' }, // {harness, sessionId, cwd} -> SessionRow (load/resume a session)
  'agent.prompt': { at: 'bridge', role: 'operator' }, // {sessionId, prompt: ContentBlock[]} -> {ok}; the turn streams as events
  'agent.cancel': { at: 'bridge', role: 'operator' }, // {sessionId}
  'agent.task_stop': { at: 'bridge', role: 'operator' }, // {sessionId, taskId} stops one background task
  'agent.answer': { at: 'bridge', role: 'operator' }, // {approvalId, optionId: string|null (null = cancel)}
  'agent.set_mode': { at: 'bridge', role: 'operator' }, // {sessionId, modeId}
  'agent.set_model': { at: 'bridge', role: 'operator' }, // {sessionId, modelId}
  'agent.set_config': { at: 'bridge', role: 'operator' }, // {sessionId, configId, value}
  'agent.close': { at: 'bridge', role: 'operator' }, // {sessionId} stops the harness's session process state

  // terminals
  'term.list': { at: 'bridge', role: 'operator', needs: 'terminal' }, // -> TerminalInfo[]
  // The browser: Camofox on the machine, one per chat session (its own profile), its screen streamed on the topic
  // browser:<sessionId>. Everyone who can work in that chat sees and drives the same browser.
  'browser.open': { at: 'bridge', role: 'operator' }, // {sessionId, url, width?, height?, dpr?} -> {id, url} (reuses the chat's browser); also subscribes
  'browser.attach': { at: 'bridge', role: 'operator' }, // {sessionId, width?, height?, dpr?} -> {id, url, title}; also subscribes
  'browser.resize': { at: 'bridge', role: 'operator' }, // {sessionId, width, height, dpr}
  'browser.watch': { at: 'bridge', role: 'operator' }, // {sessionId, on} frames on or off
  'browser.navigate': { at: 'bridge', role: 'operator' }, // {sessionId, url}
  'browser.go': { at: 'bridge', role: 'operator' }, // {sessionId, delta: -1 back, 1 forward, 0 reload}
  'browser.input': { at: 'bridge', role: 'operator', oneWay: true }, // {sessionId, ev: mouse | wheel | key | text}
  'browser.close': { at: 'bridge', role: 'operator' }, // {sessionId}
  'term.open': { at: 'bridge', role: 'operator', needs: 'terminal' }, // {cwd?, cols, rows, command?: string[]} -> TerminalInfo & {scrollback: base64}
  'term.attach': { at: 'bridge', role: 'operator', needs: 'terminal' }, // {id} -> {info, scrollback: base64}; also subscribes
  'term.write': { at: 'bridge', role: 'operator', needs: 'terminal' }, // {id, data: string}
  'term.resize': { at: 'bridge', role: 'operator', needs: 'terminal' }, // {id, cols, rows}
  'term.close': { at: 'bridge', role: 'operator', needs: 'terminal' }, // {id}
  'harness.logout': { at: 'bridge', role: 'owner', needs: 'terminal' }, // {harness} -> {ok}; then an `auth` machine event
  'harness.login': { at: 'bridge', role: 'owner', needs: 'terminal' }, // {harness, cols, rows} -> TerminalInfo & {scrollback} (runs the harness's login)

  // files
  'fs.home': { at: 'bridge', role: 'viewer' }, // -> {home, roots: string[]} (roots = the caller's folders, or [home])
  'fs.list': { at: 'bridge', role: 'viewer' }, // {path, hidden?} -> {path, parent: string|null, entries: DirEntry[], truncated}; then {type:"changed"} on "fs:<path>" when the folder changes
  'fs.read': { at: 'bridge', role: 'viewer' }, // {path, max?} -> FileContent (at most ~700 KB; truncated beyond)
  // (Downloads: the server's GET /api/machines/<id>/files and /zip routes stream these a part at a time; see docs/api.md.)
  'fs.chunk': { at: 'bridge', role: 'viewer' }, // {path | zip, offset, length} -> {size, mtime, mime, data: base64} (at most 1 MB; length 0: the size only)
  'fs.zip': { at: 'bridge', role: 'viewer' }, // {path} a folder zipped in the computer's temp folder -> {zip, name, size} (read with fs.chunk {zip}, by its maker only; gone after 15 min)
  'fs.write': { at: 'bridge', role: 'operator' }, // {path, content, encoding?, append?} -> DirEntry (append: an upload's later parts)
  'fs.mkdir': { at: 'bridge', role: 'operator' }, // {path} -> DirEntry
  'fs.rename': { at: 'bridge', role: 'operator' }, // {from, to}
  'fs.trash': { at: 'bridge', role: 'operator' }, // {path} moves to the system trash

  // git
  // (Changes are HEAD against the files now, as GitHub Desktop shows them; a commit takes the files and lines picked,
  // built in an index of its own, so what was staged with `git add` elsewhere stays as it was.)
  'git.status': { at: 'bridge', role: 'viewer' }, // {cwd} -> GitStatus | null (not a repo)
  'git.diff': { at: 'bridge', role: 'viewer' }, // {cwd, path?, orig?, staged?, head?, rev?, stash?, whitespace?: false} -> {diff, hash, truncated} (head: HEAD against the file now; untracked files as new; ~800 KB cap)
  'git.log': { at: 'bridge', role: 'viewer' }, // {cwd, limit?, skip?, path?, rev?} -> GitCommit[]
  'git.show': { at: 'bridge', role: 'viewer' }, // {cwd, rev} -> {commit: GitCommit, files: GitCommitFile[]}
  'git.branches': { at: 'bridge', role: 'viewer' }, // {cwd} -> {current, local: GitBranch[], remote: GitBranch[], recent: string[], default: string|null}
  'git.compare': { at: 'bridge', role: 'viewer' }, // {cwd, branch} -> {ahead, behind} (of the current branch against it)
  'git.stashes': { at: 'bridge', role: 'viewer' }, // {cwd} -> GitStash[]
  'git.tags': { at: 'bridge', role: 'viewer' }, // {cwd} -> {name, hash, at}[]
  'git.file': { at: 'bridge', role: 'viewer' }, // {cwd, path, rev, encoding?: 'base64'} -> {content, encoding} (a file at a revision, "" if none; rev ":" = index)
  'git.stage': { at: 'bridge', role: 'operator' }, // {cwd, paths}
  'git.unstage': { at: 'bridge', role: 'operator' }, // {cwd, paths}
  'git.discard': { at: 'bridge', role: 'operator' }, // {cwd, paths} back to HEAD; new files deleted
  'git.discard_lines': { at: 'bridge', role: 'operator' }, // {cwd, lines: GitLines} takes those lines back
  'git.ignore': { at: 'bridge', role: 'operator' }, // {cwd, pattern} adds it to the repository's .gitignore
  'git.commit': { at: 'bridge', role: 'operator' }, // {cwd, message, amend?, picks?: GitPick[], noVerify?} -> {hash} (picks: what to take; none = what is staged)
  'git.undo': { at: 'bridge', role: 'operator' }, // {cwd} undoes the last commit (not pushed), its changes kept -> {message}
  'git.checkout': { at: 'bridge', role: 'operator' }, // {cwd, branch?, create?, from?, track?, rev? (detached), changes?: 'stash'|'bring'}
  'git.branch_rename': { at: 'bridge', role: 'operator' }, // {cwd, from, to}
  'git.branch_delete': { at: 'bridge', role: 'operator' }, // {cwd, branch, remote?: boolean (also on the remote)}
  'git.merge': { at: 'bridge', role: 'operator' }, // {cwd, branch, squash?} -> {output, conflicts}
  'git.rebase': { at: 'bridge', role: 'operator' }, // {cwd, onto} -> {output, conflicts}
  'git.continue': { at: 'bridge', role: 'operator' }, // {cwd, message?} the operation stopped for conflicts, after they're resolved
  'git.abort': { at: 'bridge', role: 'operator' }, // {cwd}
  'git.resolve': { at: 'bridge', role: 'operator' }, // {cwd, path, side: 'ours'|'theirs'|'mark'} one conflicted file
  'git.revert': { at: 'bridge', role: 'operator' }, // {cwd, rev} -> {output, conflicts}
  'git.cherry_pick': { at: 'bridge', role: 'operator' }, // {cwd, revs} -> {output, conflicts}
  'git.reset': { at: 'bridge', role: 'operator' }, // {cwd, rev} the branch back to rev, changes since kept
  'git.tag': { at: 'bridge', role: 'operator' }, // {cwd, name, rev?, delete?}
  'git.stash': { at: 'bridge', role: 'operator' }, // {cwd, message?, paths?} stashes the changes (new files too)
  'git.stash_apply': { at: 'bridge', role: 'operator' }, // {cwd, ref, drop?: true (pop)} -> {conflicts}
  'git.stash_drop': { at: 'bridge', role: 'operator' }, // {cwd, ref}
  'git.fetch': { at: 'bridge', role: 'operator' }, // {cwd} -> {output}
  'git.pull': { at: 'bridge', role: 'operator' }, // {cwd} -> {output, conflicts}
  'git.push': { at: 'bridge', role: 'operator' }, // {cwd, setUpstream?, force?: true (with lease), tags?} -> {output}
  'git.init': { at: 'bridge', role: 'operator' }, // {cwd} makes it a repository
  'git.clone': { at: 'bridge', role: 'operator' }, // {cwd (the folder to clone into), url, name?} -> {path}

  // GitHub, through the computer's own `gh` sign-in (CodeRail never holds a token)
  'gh.repo': { at: 'bridge', role: 'viewer' }, // {cwd, fresh?} -> GhRepo | null (not on GitHub)
  'gh.pulls': { at: 'bridge', role: 'viewer' }, // {cwd, state?: 'open'|'closed'|'merged'|'all', mine?} -> GhPull[]
  'gh.pull': { at: 'bridge', role: 'viewer' }, // {cwd, number?} -> GhPull | null (number: none = the current branch's)
  'gh.diff': { at: 'bridge', role: 'viewer' }, // {cwd, number} -> {diff, truncated}
  'gh.checkout': { at: 'bridge', role: 'operator' }, // {cwd, number}
  'gh.create': { at: 'bridge', role: 'operator' }, // {cwd, title, body?, base?, draft?} pushes the branch first -> {url, number}
  'gh.merge': { at: 'bridge', role: 'operator' }, // {cwd, number, method: 'merge'|'squash'|'rebase', head (its headOid)}
  'gh.rerun': { at: 'bridge', role: 'operator' }, // {cwd, runId, failed?}
  'gh.publish': { at: 'bridge', role: 'operator' }, // {cwd, name, private, description?} a new GitHub repository from this one (callers with no folder limits)
};

/** Events. topic "machine": {type: ...}; "session:<id>": LogEntry; "term:<id>": {type:"output", data: base64} | {type:"exit", code}; "fs:<folder>": {type:"changed"}. */
export type MachineEvent =
  | { type: 'online'; online: boolean; info: MachineInfo | null }
  | { type: 'session'; session: SessionRow } // created or changed
  | { type: 'session_removed'; sessionId: string }
  | { type: 'approval'; approval: Approval }
  | { type: 'approval_done'; approvalId: string; sessionId: string }
  | { type: 'task'; task: AgentTask } // started or changed
  | { type: 'task_done'; taskId: string; sessionId: string }
  | { type: 'browser'; sessionId: string } // the chat's agent opened its browser
  | { type: 'terminal'; terminal: TerminalInfo }
  | { type: 'terminal_closed'; id: string }
  | { type: 'auth'; harness: string; status: any }; // {signedIn, label} after a sign-in; or what an adapter reports

export const ROLE_RANK: Record<Role, number> = { viewer: 0, operator: 1, owner: 2 };

export function atLeast(role: Role, need: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[need];
}

/** Is `path` (absolute, normalized) inside one of `folders`? null folders = everywhere. */
export function inFolders(path: string, folders: string[] | null): boolean {
  if (!folders) return true;
  return folders.some((f) => {
    const base = f.endsWith('/') ? f.slice(0, -1) : f;
    return path === base || path.startsWith(base + '/');
  });
}

export const HARNESSES: { id: string; name: string; command: string }[] = [
  { id: 'claude-code', name: 'Claude Code', command: 'claude' },
  { id: 'codex', name: 'Codex', command: 'codex' },
];
