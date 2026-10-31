// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// `bun run dev:mock` (VITE_MOCK=1): a fake server in the page, for working on the UI without a backend. `fetch('/api/…')`
// answers from fixtures, and `WebSocket` to /api/machines/:id/ws is a fake machine: one online computer with
// sessions (history, a pending approval), files, git, terminals that echo, and a browser per chat; one offline. A prompt
// streams a made-up answer. Never in a build without VITE_MOCK.
import { b64 } from '../lib/b64';
import type { Approval, LogEntry, MachineInfo, MachineSummary, SessionRow, TerminalInfo, DirEntry, GitStatus } from '@coderail/protocol';

const now = Date.now();
const mockBrowser = { url: 'about:blank', click: 'none', w: 800, h: 600, open: new Set<string>() };
const invites = [{ code: 'K3Q9X', isAdmin: false, createdAt: now - 86400e3, expiresAt: now + 6 * 86400e3, createdBy: 'sam' }];
const HOME = '/Users/sam';
const ME = { id: 'u1', username: 'sam', isAdmin: true };
let signedIn = localStorage.getItem('mock.signedOut') !== '1';

const info: MachineInfo = {
  hostname: 'studio.local', os: 'darwin', arch: 'arm64', home: HOME, user: 'sam', bridgeVersion: '0.1.0',
  harnesses: [
    { id: 'claude-code', name: 'Claude Code', installed: true, path: '/opt/homebrew/bin/claude', version: '2.1.4' },
    { id: 'codex', name: 'Codex', installed: true, path: '/opt/homebrew/bin/codex', version: '0.48.0' },
  ],
};
const machines: MachineSummary[] = [
  { id: 'm1', name: 'Studio Mac', ownerId: 'u1', ownerName: 'sam', online: true, lastSeen: now, info, scope: { role: 'owner', folders: null, harnesses: null, terminal: true }, createdAt: now - 9e8 },
  { id: 'm2', name: 'Build box', ownerId: 'u2', ownerName: 'maya', online: false, lastSeen: now - 3 * 3600e3, info: { ...info, hostname: 'build-01', os: 'linux', arch: 'x64', home: '/home/ci', user: 'ci' }, scope: { role: 'operator', folders: ['/home/ci/src'], harnesses: null, terminal: false }, createdAt: now - 5e8 },
];

const modes = { currentModeId: 'default', availableModes: [
  { id: 'default', name: 'Ask before edits', description: 'Asks before it changes files or runs commands' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Edits files without asking' },
  { id: 'plan', name: 'Plan', description: 'Plans without changing anything' },
] };
const configOptions = [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'opus', options: [{ value: 'opus', name: 'Opus 5.5', description: 'Most capable' }, { value: 'sonnet', name: 'Sonnet 5', description: 'Fast and capable' }] },
  { id: 'effort', name: 'Effort', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }] },
];
const W = `${HOME}/code/webapp`, A = `${HOME}/code/api`;
const sessions: SessionRow[] = [
  { sessionId: 's1', harness: 'claude-code', cwd: W, title: 'Fix the login redirect loop', state: 'idle', createdBy: 'sam', createdAt: now - 7200e3, updatedAt: now - 120e3, pending: 1, modes, configOptions },
  { sessionId: 's2', harness: 'codex', cwd: W, title: 'Add a dark mode toggle', state: 'idle', createdBy: 'maya', createdAt: now - 86400e3, updatedAt: now - 5 * 3600e3, pending: 0, modes: { currentModeId: 'auto', availableModes: [{ id: 'read-only', name: 'Read only' }, { id: 'auto', name: 'Auto' }, { id: 'full', name: 'Full access' }] } },
  { sessionId: 's3', harness: 'claude-code', cwd: A, title: 'Refactor billing webhooks', state: 'closed', createdBy: 'sam', createdAt: now - 3 * 86400e3, updatedAt: now - 2 * 86400e3, pending: 0, modes },
];

const LOGIN_OLD = `export function redirectAfterLogin(req) {\n  const next = req.query.next;\n  return next || '/';\n}\n`;
const LOGIN_NEW = `export function redirectAfterLogin(req) {\n  const next = req.query.next;\n  // Only same-site paths, never back to /login itself.\n  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) return '/';\n  return next;\n}\n`;
const approval: Approval = {
  id: 'ap1', sessionId: 's1', harness: 'claude-code', at: now - 60e3,
  toolCall: { toolCallId: 't4', title: '`npm test -- auth`', kind: 'execute', rawInput: { command: 'npm test -- auth', description: 'Run the auth tests' } },
  options: [
    { optionId: 'allow', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'reject', name: 'Deny', kind: 'reject_once' },
  ],
};
let seq = 0;
const E = (kind: LogEntry['kind'], data: any, ago: number): LogEntry => ({ seq: ++seq, at: now - ago, kind, data });
const U = (update: any, ago: number) => E('update', update, ago);
const chunk = (text: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const logs: Record<string, LogEntry[]> = {
  s1: [
    E('user', { prompt: [{ type: 'text', text: 'After signing in, users who came from `/login?next=/login` end up in a redirect loop. Can you fix it?' }], by: 'sam' }, 600e3),
    U({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'The redirect target comes from `next`. If it points at /login itself, we loop. Let me find where it is read.' } }, 590e3),
    U({ sessionUpdate: 'plan', entries: [{ content: 'Find where `next` is read after sign-in', status: 'completed', priority: 'high' }, { content: 'Only allow same-site paths that are not /login', status: 'completed', priority: 'high' }, { content: 'Run the auth tests', status: 'in_progress', priority: 'medium' }] }, 585e3),
    U({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'Search `redirectAfterLogin`', kind: 'search', status: 'pending' }, 580e3),
    U({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'src/auth/redirect.ts:1\nsrc/routes/login.ts:42' } }] }, 579e3),
    U({ sessionUpdate: 'tool_call', toolCallId: 't2', title: 'Read src/auth/redirect.ts', kind: 'read', status: 'completed', locations: [{ path: `${W}/src/auth/redirect.ts` }] }, 575e3),
    U(chunk('Found it. `redirectAfterLogin` trusts `next` as is, so '), 570e3),
    U(chunk('`/login?next=/login` sends you straight back. I’ll only accept same-site paths and never `/login` itself.'), 569e3),
    U({ sessionUpdate: 'tool_call', toolCallId: 't3', title: 'Edit src/auth/redirect.ts', kind: 'edit', status: 'in_progress', content: [{ type: 'diff', path: `${W}/src/auth/redirect.ts`, oldText: LOGIN_OLD, newText: LOGIN_NEW }] }, 560e3),
    U({ sessionUpdate: 'tool_call_update', toolCallId: 't3', status: 'completed' }, 559e3),
    E('approval', approval, 60e3),
  ],
  s2: [
    E('user', { prompt: [{ type: 'text', text: 'Add a dark mode toggle to the settings page.' }], by: 'maya' }, 6 * 3600e3),
    U(chunk('Added a **Theme** row to Settings with System, Light and Dark. It writes `data-theme` on `<html>` and keeps the choice in `localStorage`.\n\n```ts\nexport function setTheme(t: Theme) {\n  document.documentElement.dataset.theme = t;\n  localStorage.setItem("theme", t);\n}\n```'), 5.9 * 3600e3),
    E('turn', { stopReason: 'end_turn' }, 5.9 * 3600e3),
  ],
  s3: [
    E('user', { prompt: [{ type: 'text', text: 'Split the billing webhook handler by event type.' }], by: 'sam' }, 2.1 * 86400e3),
    U(chunk('Done: one handler per event, a table maps the event name to it, and unknown events are logged and acknowledged.'), 2.1 * 86400e3),
    E('turn', { stopReason: 'end_turn' }, 2.1 * 86400e3),
    E('notice', { text: 'The agent stopped (bridge restarted)' }, 2 * 86400e3),
  ],
};
let approvals: Approval[] = [approval];
let terminals: TerminalInfo[] = [{ id: 'term1', title: 'npm run dev', cwd: W, cols: 80, rows: 24, startedAt: now - 3600e3, exited: null, by: 'sam' }];

// ---- files
const files: Record<string, string> = {
  [`${W}/package.json`]: '{\n  "name": "webapp",\n  "scripts": { "dev": "vite", "test": "vitest" }\n}\n',
  [`${W}/README.md`]: '# webapp\n\nThe customer app. `npm run dev` starts it on **:5173**.\n\n- Sign-in: `src/auth`\n- Routes: `src/routes`\n',
  [`${W}/src/auth/redirect.ts`]: LOGIN_NEW,
  [`${W}/src/auth/session.ts`]: 'export const COOKIE = "sid";\n',
  [`${W}/src/routes/login.ts`]: 'import { redirectAfterLogin } from "../auth/redirect";\n\nexport function onLogin(req, res) {\n  res.redirect(redirectAfterLogin(req));\n}\n',
  [`${W}/src/main.ts`]: 'import "./app";\n',
  [`${W}/tests/auth.test.ts`]: 'import { redirectAfterLogin } from "../src/auth/redirect";\n',
  [`${A}/billing/webhooks.ts`]: 'export const handlers = {};\n',
};
const dirs = new Set<string>();
for (const p of Object.keys(files)) { let d = p; while ((d = d.slice(0, d.lastIndexOf('/'))) && d.length >= HOME.length) dirs.add(d); }
dirs.add(`${HOME}/Documents`); dirs.add(`${HOME}/Desktop`); dirs.add(`${HOME}/code/blog`);
function list(path: string): DirEntry[] {
  const p = path.replace(/\/+$/, '');
  const out = new Map<string, DirEntry>();
  for (const d of dirs) if (d.startsWith(p + '/') && !d.slice(p.length + 1).includes('/')) out.set(d, { name: d.slice(p.length + 1), path: d, kind: 'dir', size: 0, mtime: now });
  for (const [f, c] of Object.entries(files)) if (f.startsWith(p + '/') && !f.slice(p.length + 1).includes('/')) out.set(f, { name: f.slice(p.length + 1), path: f, kind: 'file', size: c.length, mtime: now });
  return [...out.values()];
}
const git: GitStatus = {
  root: W, branch: 'fix/login-loop', head: 'a1b2c3d', upstream: 'origin/fix/login-loop', ahead: 1, behind: 0, stashes: 0, fetchedAt: Date.now() - 600e3, defaultBranch: 'main',
  remote: { name: 'origin', url: 'git@github.com:sam/webapp.git', web: 'https://github.com/sam/webapp', github: { host: 'github.com', owner: 'sam', repo: 'webapp' } },
  files: [
    { path: 'src/auth/redirect.ts', index: ' ', worktree: 'M', staged: false, unstaged: true, untracked: false, conflicted: false },
    { path: 'tests/auth.test.ts', index: '?', worktree: '?', staged: false, unstaged: false, untracked: true, conflicted: false },
    { path: 'README.md', index: 'M', worktree: ' ', staged: true, unstaged: false, untracked: false, conflicted: false },
  ],
};
const DIFF_REDIRECT = `diff --git a/src/auth/redirect.ts b/src/auth/redirect.ts\n--- a/src/auth/redirect.ts\n+++ b/src/auth/redirect.ts\n@@ -1,4 +1,6 @@\n export function redirectAfterLogin(req) {\n   const next = req.query.next;\n-  return next || '/';\n+  // Only same-site paths, never back to /login itself.\n+  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/login')) return '/';\n+  return next;\n }\n`;
const DIFF_README = `diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1,3 +1,3 @@\n # webapp\n \n-The customer app.\n+The customer app. \`npm run dev\` starts it on **:5173**.\n`;

// ---- HTTP
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const realFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return realFetch(input, init);
  await new Promise((r) => setTimeout(r, 120));
  const method = (init?.method ?? 'GET').toUpperCase();
  const body = init?.body ? JSON.parse(String(init.body)) : {};
  const p = url.pathname;
  if (p === '/api/me') return json({ user: signedIn ? ME : null, setup: false });
  if (p === '/api/login') { if (body.password?.length < 1) return json({ error: 'Wrong username or password' }, 401); signedIn = true; localStorage.removeItem('mock.signedOut'); return json({ user: ME }); }
  if (p === '/api/logout') { signedIn = false; localStorage.setItem('mock.signedOut', '1'); return json({ ok: true }); }
  if (!signedIn && !p.startsWith('/api/invites/')) return json({ error: 'Signed out' }, 401);
  if (p === '/api/machines') return json(machines);
  if (p === '/api/users') return json([
    { id: 'u1', username: 'sam', isAdmin: true, disabled: false, createdAt: now - 9e8 },
    { id: 'u2', username: 'maya', isAdmin: false, disabled: false, createdAt: now - 5e8 },
    { id: 'u3', username: 'sam', isAdmin: false, disabled: true, createdAt: now - 2e8 },
  ]);
  if (p === '/api/invites' && method === 'GET') return json(invites);
  if (p === '/api/invites' && method === 'POST') {
    const code = 'NEW' + (invites.length + 1);
    invites.push({ code, isAdmin: !!body.isAdmin, createdAt: now, expiresAt: now + 7 * 86400e3, createdBy: 'sam' });
    return json({ code, url: `${location.origin}/invite/${code}`, expiresAt: now + 7 * 86400e3 });
  }
  if (p.startsWith('/api/invites/') && method === 'DELETE') {
    invites.splice(invites.findIndex((i) => i.code === p.slice(13)), 1);
    return json({ ok: true });
  }
  if (p.startsWith('/api/invites/')) return json({ valid: true, isAdmin: false });
  if (p === '/api/audit') {
    const all = [
    { at: now - 60e3, username: 'sam', machineId: 'm1', machineName: 'Studio Mac', action: 'agent.prompt', detail: { sessionId: 's1', text: 'After signing in, users who came from a shared link land on the home page instead of the link.' } },
    { at: now - 5 * 60e3, username: 'sam', machineId: 'm1', machineName: 'Studio Mac', action: 'browser.open', detail: { sessionId: 's1', url: 'http://localhost:5173/' } },
    { at: now - 40 * 60e3, username: 'sam', machineId: null, machineName: null, action: 'invite.create', detail: { isAdmin: false } },
    { at: now - 3600e3, username: 'maya', machineId: 'm1', machineName: 'Studio Mac', action: 'git.commit', detail: { cwd: `${HOME}/code/webapp`, message: 'Add dark mode toggle' } },
    { at: now - 7200e3, username: 'sam', machineId: 'm1', machineName: 'Studio Mac', action: 'term.open', detail: { cwd: `${HOME}/code/webapp`, cols: 120, rows: 30 } },
    { at: now - 26 * 3600e3, username: 'sam', machineId: 'm1', machineName: 'Studio Mac', action: 'grant.set', detail: { userId: 'u2', role: 'operator' } },
    { at: now - 27 * 3600e3, username: 'sam', machineId: 'm1', machineName: 'Studio Mac', action: 'fs.write', detail: { path: `${HOME}/code/webapp/src/App.svelte`, bytes: 2210 } },
    ];
    const sp = url.searchParams;
    const kinds: Record<string, RegExp> = { prompts: /^agent\./, files: /^fs\./, git: /^git\./, terminals: /^(term|harness)\./, access: /^(user|grant|invite|machine|settings)\.|^(password|signup|setup)$/ };
    const rows = all.filter((r) => (!sp.get('user') || r.username === sp.get('user')) && (!sp.get('machine') || r.machineId === sp.get('machine')) && (!kinds[sp.get('kind') ?? ''] || kinds[sp.get('kind')!].test(r.action)));
    const size = Number(sp.get('size') || 50), page = Number(sp.get('page') || 0);
    return json({ rows: rows.slice(page * size, page * size + size), page, size, more: rows.length > (page + 1) * size });
  }
  if (p === '/api/settings') return json({ auditDays: body.auditDays ?? 90 });
  if (/^\/api\/machines\/[^/]+\/grants\/[^/]+$/.test(p)) return json({ ok: true });
  if (/^\/api\/machines\/[^/]+\/grants$/.test(p)) return json([
    { userId: 'u1', username: 'sam', role: 'owner', folders: null, harnesses: null, terminal: true },
    { userId: 'u2', username: 'maya', role: 'operator', folders: [`${HOME}/code/webapp`], harnesses: ['claude-code'], terminal: false },
  ]);
  if (p.startsWith('/api/pair/')) {
    if (method === 'POST') return json({ machineId: 'm1' });
    return json({ code: p.split('/')[3], name: 'Sam’s MacBook', info: { hostname: 'macbook.local', os: 'darwin', arch: 'arm64', user: 'sam', bridgeVersion: '0.1.0', harnesses: info.harnesses }, expiresAt: now + 9 * 60e3 });
  }
  if (p === '/api/push/key') return json({ publicKey: null });
  // (A file's bytes, as the files route streams them: the mock's files are text. A folder can't be zipped here.)
  if (/^\/api\/machines\/[^/]+\/files$/.test(p)) {
    const c = files[url.searchParams.get('path') ?? ''];
    if (c == null) return json({ error: 'No such file' }, 404);
    return new Response(method === 'HEAD' ? null : c, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': url.searchParams.has('download') ? 'attachment' : 'inline' } });
  }
  if (/^\/api\/machines\/[^/]+\/zip$/.test(p)) return json({ error: 'Zipping a folder needs a real computer' }, 501);
  return json({ ok: true });
};

// ---- the machine socket
class MockSocket {
  static readonly CONNECTING = 0; static readonly OPEN = 1; static readonly CLOSING = 2; static readonly CLOSED = 3;
  readyState = 0;
  onopen: ((e: any) => void) | null = null;
  onmessage: ((e: any) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: ((e: any) => void) | null = null;
  private machine: string;
  private topics = new Set<string>();
  constructor(public url: string) {
    this.machine = /\/api\/machines\/([^/]+)\/ws/.exec(url)?.[1] ?? '';
    setTimeout(() => { this.readyState = 1; this.onopen?.({}); }, 150);
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); sockets.delete(this); }
  send(raw: string) {
    const f = JSON.parse(raw);
    if (f.t === 'ping') return this.emit({ t: 'pong' });
    if (f.t !== 'req') return;
    setTimeout(() => {
      try { this.emit({ t: 'res', id: f.id, result: this.handle(f.method, f.params ?? {}) }); }
      catch (e) { this.emit({ t: 'res', id: f.id, error: { code: -32000, message: String((e as Error).message ?? e) } }); }
    }, 60 + Math.random() * 120);
  }
  emit(f: unknown) { if (this.readyState === 1) this.onmessage?.({ data: JSON.stringify(f) }); }
  ev(topic: string, data: unknown) { if (this.topics.has(topic) || topic === 'machine') this.emit({ t: 'ev', topic, data }); }
  private handle(method: string, p: any): any {
    const online = this.machine === 'm1';
    const mach = machines.find((m) => m.id === this.machine)!;
    const at = (path: string) => { if (!online) throw new Error('The computer is offline'); return path; };
    switch (method) {
      case 'sub': for (const t of p.topics) this.topics.add(t); return { ok: true };
      case 'unsub': for (const t of p.topics) this.topics.delete(t); return { ok: true };
      case 'machine.info':
        if (online) setTimeout(() => this.ev('machine', { type: 'auth', harness: 'codex', status: { signedIn: true, label: 'ChatGPT Plus · sam' } }), 300);
        return { online, info: mach.info, scope: mach.scope };
      case 'agent.sessions': return online ? sessions : [];
      case 'agent.approvals': return online ? approvals : [];
      case 'agent.history': {
        const all = (logs[p.sessionId] ?? []).filter((e) => e.seq > (p.after ?? 0));
        return { entries: all, session: sessions.find((s) => s.sessionId === p.sessionId), more: false };
      }
      case 'agent.harnesses': return info.harnesses;
      case 'agent.local': at(''); return p.harness === 'claude-code'
        ? [{ sessionId: 'loc1', harness: 'claude-code', cwd: `${HOME}/code/blog`, title: 'Draft the release notes', updatedAt: new Date(now - 3 * 86400e3).toISOString() }]
        : [{ sessionId: 'loc2', harness: 'codex', cwd: W, title: 'Bump dependencies', updatedAt: new Date(now - 6 * 86400e3).toISOString() }];
      case 'agent.new': case 'agent.open': {
        at('');
        const s: SessionRow = { sessionId: p.sessionId ?? `s${Date.now()}`, harness: p.harness, cwd: p.cwd, title: method === 'agent.open' ? 'Resumed session' : null, state: 'idle', createdBy: 'sam', createdAt: Date.now(), updatedAt: Date.now(), pending: 0, modes, configOptions: p.harness === 'claude-code' ? configOptions : undefined };
        const i = sessions.findIndex((x) => x.sessionId === s.sessionId);
        if (i >= 0) sessions[i] = { ...sessions[i], state: 'idle' }; else { sessions.unshift(s); logs[s.sessionId] = []; }
        broadcast('machine', { type: 'session', session: sessions.find((x) => x.sessionId === s.sessionId) });
        return sessions.find((x) => x.sessionId === s.sessionId);
      }
      case 'agent.prompt': at(''); setTimeout(() => turn(p.sessionId, p.prompt), 10); return { ok: true };
      case 'agent.cancel': stopTurn(p.sessionId); return { ok: true };
      case 'agent.answer': {
        const a = approvals.find((x) => x.id === p.approvalId);
        approvals = approvals.filter((x) => x.id !== p.approvalId);
        if (a) {
          push(a.sessionId, 'answer', { approvalId: a.id, optionId: p.optionId, by: 'sam' });
          broadcast('machine', { type: 'approval_done', approvalId: a.id, sessionId: a.sessionId });
          if (p.optionId && p.optionId !== 'reject') {
            push(a.sessionId, 'update', { sessionUpdate: 'tool_call', toolCallId: 'run' + Date.now(), title: '`npm test -- auth`', kind: 'execute', status: 'completed', rawInput: { command: 'npm test -- auth' }, content: [{ type: 'content', content: { type: 'text', text: ' ✓ tests/auth.test.ts (6)\n\n Test Files  1 passed (1)\n      Tests  6 passed (6)' } }] });
            push(a.sessionId, 'update', chunk('All 6 auth tests pass. The loop is fixed: `next` must be a same-site path and can’t be `/login`.'));
          } else push(a.sessionId, 'update', chunk('Okay, I won’t run the tests. The fix is in `src/auth/redirect.ts`.'));
          push(a.sessionId, 'turn', { stopReason: 'end_turn' });
          setState(a.sessionId, 'idle');
        }
        return { ok: true };
      }
      case 'agent.set_mode': case 'agent.set_config': case 'agent.set_model': at(''); return { ok: true };
      case 'agent.close': setState(p.sessionId, 'closed'); return { ok: true };
      case 'agent.retitle': { const s = sessions.find((x) => x.sessionId === p.sessionId); if (s) s.title = 'Fix login redirect loop'; return { title: 'Fix login redirect loop' }; }
      case 'agent.limits': {
        const h = 3600_000;
        return { plan: 'Max (20x)', at: Date.now(), windows: [
          { id: 'five_hour', label: '5-hour limit', used: 42, resetsAt: Date.now() + 3 * h },
          { id: 'seven_day', label: 'Weekly · all models', used: 59, resetsAt: Date.now() + 70 * h },
        ] };
      }
      case 'agent.rename': { const s = sessions.find((x) => x.sessionId === p.sessionId); const title = String(p.title ?? '').trim() || null; if (s) s.title = title; return { ok: true, title }; }
      case 'agent.forget': { const i = sessions.findIndex((s) => s.sessionId === p.sessionId); if (i >= 0) sessions.splice(i, 1); return { ok: true }; }
      case 'fs.home': at(''); return { home: HOME, roots: [HOME] };
      case 'fs.list': {
        at('');
        // (Like the bridge: a folder that isn't there, and one macOS keeps CodeRail out of.)
        if (p.path.startsWith('/private')) throw new Error(`EPERM: operation not permitted, scandir '${p.path}'`);
        if (p.path !== HOME && !dirs.has(p.path.replace(/\/+$/, '')) && !list(p.path).length) throw new Error(`ENOENT: no such file or directory, scandir '${p.path}'`);
        return { path: p.path, parent: p.path.slice(0, p.path.lastIndexOf('/')) || null, entries: list(p.path).filter((e) => p.hidden || !e.name.startsWith('.')), truncated: false };
      }
      case 'fs.read': {
        at('');
        const c = files[p.path];
        if (c == null) throw new Error('No such file');
        return { path: p.path, size: c.length, mtime: now, mime: p.path.endsWith('.md') ? 'text/markdown' : 'text/plain', encoding: 'utf8', content: c, truncated: false };
      }
      case 'fs.write': {
        at('');
        const text = p.encoding === 'base64' ? new TextDecoder().decode(Uint8Array.from(atob(p.content), (c) => c.charCodeAt(0))) : p.content;
        files[p.path] = (p.append ? files[p.path] ?? '' : '') + text;
        return { name: p.path.split('/').pop(), path: p.path, kind: 'file', size: files[p.path].length, mtime: Date.now() };
      }
      case 'fs.chunk': {
        at('');
        const c = files[p.path];
        if (c == null) throw new Error('No such file');
        const bytes = new TextEncoder().encode(c);
        const part = bytes.subarray(p.offset ?? 0, (p.offset ?? 0) + (p.length ?? 0));
        return { size: bytes.length, mtime: now, mime: 'text/plain', data: btoa(String.fromCharCode(...part)) };
      }
      case 'fs.zip': throw new Error('Zipping a folder needs a real computer');
      case 'fs.mkdir': at(''); dirs.add(p.path.replace(/\/+$/, '')); return { name: p.path.split('/').pop(), path: p.path, kind: 'dir', size: 0, mtime: Date.now() };
      case 'fs.rename': {
        at('');
        const from = p.from.replace(/\/+$/, ''), to = p.to.replace(/\/+$/, '');
        const move = (x: string) => (x === from ? to : x.startsWith(from + '/') ? to + x.slice(from.length) : x);
        for (const f of Object.keys(files)) { const n = move(f); if (n !== f) { files[n] = files[f]; delete files[f]; } }
        for (const d of [...dirs]) { const n = move(d); if (n !== d) { dirs.delete(d); dirs.add(n); } }
        return { ok: true };
      }
      case 'fs.trash': {
        at('');
        const x = p.path.replace(/\/+$/, '');
        for (const f of Object.keys(files)) if (f === x || f.startsWith(x + '/')) delete files[f];
        for (const d of [...dirs]) if (d === x || d.startsWith(x + '/')) dirs.delete(d);
        return { ok: true };
      }
      case 'harness.login': {
        at('');
        const h = info.harnesses.find((x) => x.id === p.harness);
        const t: TerminalInfo = { id: 'login' + Date.now(), title: `${h?.name ?? p.harness} sign-in`, cwd: HOME, cols: p.cols, rows: p.rows, startedAt: Date.now(), exited: null, by: 'sam' };
        terminals.push(t);
        this.topics.add(`term:${t.id}`);
        broadcast('machine', { type: 'terminal', terminal: t });
        setTimeout(() => {
          broadcast(`term:${t.id}`, { type: 'output', data: b64u('\r\n\x1b[32m✓\x1b[0m Signed in as sam@example.com\r\n') });
          broadcast('machine', { type: 'auth', harness: p.harness, status: { signedIn: true, label: 'sam@example.com' } });
        }, 3000);
        return { ...t, scrollback: b64u(`Signing in to ${h?.name ?? p.harness}…\r\nOpen this link on any device and enter the code \x1b[1mWXYZ-4821\x1b[0m:\r\n  https://example.com/device\r\n\r\nWaiting…`) };
      }
      case 'git.status': at(''); return p.cwd.startsWith(W) ? git : p.cwd.startsWith(A) ? { ...git, root: A, branch: 'main', ahead: 0, files: [] } : null;
      case 'git.diff':
        if (p.rev) return { diff: DIFF_REDIRECT + DIFF_README, hash: 'rev' };
        { const d = p.path === 'README.md' ? DIFF_README : p.path === 'src/auth/redirect.ts' ? DIFF_REDIRECT : ''; return { diff: d, hash: 'h' + d.length }; }
      case 'git.log': return p.skip ? [] : [
        { hash: 'a1b2c3d4e5', short: 'a1b2c3d', author: 'sam', email: 't@x', at: now - 3600e3, subject: 'Guard the login redirect', refs: 'HEAD -> fix/login-loop', local: true, parents: ['f6e5d4c3b2'] },
        { hash: 'f6e5d4c3b2', short: 'f6e5d4c', author: 'maya', email: 'm@x', at: now - 86400e3, subject: 'Add dark mode toggle', refs: 'origin/main, main' },
        { hash: '0011223344', short: '0011223', author: 'maya', email: 'm@x', at: now - 3 * 86400e3, subject: 'Initial commit', refs: '' },
      ];
      case 'git.branches': {
        const b = (name: string, ago: number, subject: string, upstream: string | null = null) => ({ name, upstream, ahead: 0, behind: 0, gone: false, at: now - ago, subject });
        return { current: git.branch, default: 'main', recent: ['main'].filter((x) => x !== git.branch),
          local: [b('fix/login-loop', 3600e3, 'Guard the login redirect', 'origin/fix/login-loop'), b('main', 86400e3, 'Add dark mode toggle', 'origin/main'), b('feat/dark-mode', 2 * 86400e3, 'Theme tokens')],
          remote: [b('origin/main', 86400e3, 'Add dark mode toggle'), b('origin/fix/login-loop', 3600e3, 'Guard the login redirect'), b('origin/release', 5 * 86400e3, 'Release 1.2')] };
      }
      case 'git.show': return { commit: { hash: p.rev, short: String(p.rev).slice(0, 7), author: 'sam', email: 't@x', at: now - 3600e3, subject: 'Guard the login redirect', refs: '', body: '', parents: ['f6e5d4c3b2'] },
        files: [{ path: 'src/auth/redirect.ts', status: 'M', added: 3, removed: 1 }, { path: 'README.md', status: 'M', added: 1, removed: 1 }] };
      case 'git.compare': return { ahead: 1, behind: 0 };
      case 'git.stashes': case 'gh.pulls': return [];
      case 'git.tags': return [];
      case 'git.undo': git.ahead = Math.max(0, git.ahead - 1); return { message: 'Guard the login redirect' };
      case 'gh.repo': return { host: 'github.com', owner: 'sam', repo: 'webapp', url: 'https://github.com/sam/webapp', gh: 'ok', defaultBranch: 'main', permission: 'ADMIN', mergeMethods: ['squash', 'merge'] };
      case 'gh.pull': return null;
      case 'git.stage': for (const f of git.files) if (p.paths.includes(f.path)) { f.staged = true; f.unstaged = false; f.untracked = false; f.index = f.index === '?' ? 'A' : 'M'; f.worktree = ' '; } return { ok: true };
      case 'git.unstage': for (const f of git.files) if (p.paths.includes(f.path)) { f.staged = false; f.unstaged = true; f.worktree = 'M'; f.index = ' '; } return { ok: true };
      case 'git.discard': git.files = git.files.filter((f) => !p.paths.includes(f.path)); return { ok: true };
      case 'git.commit': { const took = new Set((p.picks ?? git.files.filter((f) => f.staged)).map((k: { path: string }) => k.path)); git.files = git.files.filter((f) => !took.has(f.path)); git.ahead++; return { hash: 'beef' + Date.now().toString(16) }; }
      case 'git.checkout': git.branch = p.branch; return { ok: true };
      case 'git.fetch': case 'git.pull': return { output: 'Already up to date.' };
      case 'git.push': git.ahead = 0; return { output: `To github.com:sam/webapp.git\n   a1b2c3d..beef  ${git.branch} -> ${git.branch}` };
      case 'git.file': return { content: '' };
      // (Camofox, faked: a frame that draws the address and the last click.)
      case 'browser.open': case 'browser.attach': case 'browser.navigate': case 'browser.input': case 'browser.resize': case 'browser.go': {
        const id = p.sessionId;
        // (Each chat has its own browser; attaching to one not opened yet fails, so the card shows its start.)
        if (method === 'browser.open') mockBrowser.open.add(id);
        else if (!mockBrowser.open.has(id)) throw new Error('That browser tab is gone');
        this.topics.add(`browser:${id}`);
        if (p.url) mockBrowser.url = p.url;
        if (p.ev?.type === 'mouse' && p.ev.action === 'mousePressed') mockBrowser.click = `${p.ev.x},${p.ev.y}`;
        if (p.width) mockBrowser.w = p.width, mockBrowser.h = p.height;
        setTimeout(() => {
          const c = document.createElement('canvas'); c.width = mockBrowser.w; c.height = mockBrowser.h;
          const g = c.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.fillStyle = '#111'; g.font = '24px system-ui';
          g.fillText(`Camofox on the computer: ${mockBrowser.url}`, 30, 60); g.fillText(`last click: ${mockBrowser.click}`, 30, 100);
          this.ev(`browser:${id}`, { type: 'frame', data: c.toDataURL('image/jpeg', 0.7).split(',')[1], w: c.width, h: c.height });
          if (p.url || method === 'browser.open') this.ev(`browser:${id}`, { type: 'nav', url: mockBrowser.url, title: new URL(mockBrowser.url).host });
        }, 150);
        return method === 'browser.open' ? { id, url: p.url } : method === 'browser.attach' ? { id, url: mockBrowser.url, title: '' } : { ok: true };
      }
      case 'browser.close': mockBrowser.open.delete(p.sessionId); this.ev(`browser:${p.sessionId}`, { type: 'closed' }); return { ok: true };
      case 'browser.watch': return { ok: true };
      case 'term.list': return terminals;
      case 'term.open': {
        at('');
        const t: TerminalInfo = { id: 'term' + Date.now(), title: 'zsh', cwd: p.cwd ?? HOME, cols: p.cols, rows: p.rows, startedAt: Date.now(), exited: null, by: 'sam' };
        terminals.push(t);
        this.topics.add(`term:${t.id}`);
        broadcast('machine', { type: 'terminal', terminal: t });
        return { ...t, scrollback: b64u(`Last login: ${new Date().toDateString()}\r\n${prompt(t.cwd)}`) };
      }
      case 'term.attach': {
        const t = terminals.find((x) => x.id === p.id);
        if (!t) throw new Error('No such terminal');
        this.topics.add(`term:${t.id}`);
        return { info: t, scrollback: b64u(t.id === 'term1' ? `\r\n  VITE v6.0.0  ready in 312 ms\r\n\r\n  ➜  Local:   http://localhost:5173/\r\n` : prompt(t.cwd)) };
      }
      case 'term.write': {
        const t = terminals.find((x) => x.id === p.id);
        if (!t) return { ok: true };
        const out = String(p.data).replace(/\r/g, `\r\n${prompt(t.cwd)}`).replace(/\x7f/g, '\b \b');
        setTimeout(() => broadcast(`term:${t.id}`, { type: 'output', data: b64u(out) }), 20);
        return { ok: true };
      }
      case 'term.resize': return { ok: true };
      case 'term.close': terminals = terminals.filter((x) => x.id !== p.id); broadcast('machine', { type: 'terminal_closed', id: p.id }); return { ok: true };
      default: throw new Error(`mock: ${method} not faked`);
    }
  }
}
/** Base64 of UTF-8 text. */
const b64u = (t: string) => b64(new TextEncoder().encode(t));
const prompt = (cwd: string) => `\x1b[32msam@studio\x1b[0m \x1b[34m${cwd.replace(HOME, '~')}\x1b[0m % `;
const sockets = new Set<MockSocket>();
function broadcast(topic: string, data: unknown) { for (const s of sockets) s.ev(topic, data); }
function push(sessionId: string, kind: LogEntry['kind'], data: any) {
  const e: LogEntry = { seq: ++seq, at: Date.now(), kind, data };
  (logs[sessionId] ??= []).push(e);
  broadcast(`session:${sessionId}`, e);
}
function setState(sessionId: string, state: SessionRow['state']) {
  const s = sessions.find((x) => x.sessionId === sessionId);
  if (!s) return;
  s.state = state; s.updatedAt = Date.now();
  broadcast('machine', { type: 'session', session: { ...s } });
}
const timers = new Map<string, ReturnType<typeof setTimeout>[]>();
function stopTurn(sid: string) {
  for (const t of timers.get(sid) ?? []) clearTimeout(t);
  timers.delete(sid);
  push(sid, 'turn', { stopReason: 'cancelled' });
  setState(sid, 'idle');
}
function turn(sid: string, promptBlocks: any[]) {
  push(sid, 'user', { prompt: promptBlocks, by: 'sam' });
  setState(sid, 'running');
  const s = sessions.find((x) => x.sessionId === sid);
  if (s && !s.title) { s.title = String(promptBlocks.find((b) => b.type === 'text')?.text ?? 'New session').slice(0, 48); }
  const words = 'I looked at the code and here is what I found. The change is small: one guard in the redirect, and a test for each case. Nothing else needs to move.'.split(' ');
  const list: ReturnType<typeof setTimeout>[] = [];
  let t = 300;
  const at = (ms: number, f: () => void) => { list.push(setTimeout(f, (t += ms))); };
  at(0, () => push(sid, 'update', { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Reading the files the prompt mentions first.' } }));
  const id = 'r' + Date.now();
  at(500, () => push(sid, 'update', { sessionUpdate: 'tool_call', toolCallId: id, title: 'Read src/routes/login.ts', kind: 'read', status: 'in_progress' }));
  at(700, () => push(sid, 'update', { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed' }));
  for (const w of words) at(70, () => push(sid, 'update', chunk(w + ' ')));
  at(200, () => { push(sid, 'turn', { stopReason: 'end_turn' }); setState(sid, 'idle'); });
  timers.set(sid, list);
}
const RealWS = window.WebSocket;
(window as any).WebSocket = function (url: string, protocols?: string | string[]) {
  if (!/\/api\/machines\/[^/]+\/ws/.test(url)) return new RealWS(url, protocols);
  const s = new MockSocket(url);
  sockets.add(s);
  return s;
} as any;
Object.assign((window as any).WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
console.info('[coderail] mock mode: /api and the machine sockets are faked');
