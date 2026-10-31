// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Caller, MachineSummary, Role, Scope } from '@coderail/protocol';
import {
  type User,
  audit,
  bearer,
  checkPassword,
  checkUsername,
  createUser,
  endSession,
  grantScope,
  machineScope,
  publicUser,
  requireAdmin,
  requireUser,
  startSession,
  verifyLogin,
  currentUser,
  sessionToken,
} from './auth';
import { pushEnabled } from './push';
import { type Env, HttpError, body, hashPassword, json, limit, now, pairCode, randomId, randomToken, sha256, timingSafeEqual } from './util';
import { installScript } from './install';
import { latest } from './downloads';
import { type Hub, Upgrade } from './hub';
import { fileRoute, zipRoute, zipStart } from './files';

/** What a request gets: a response, a WebSocket upgrade, or null for the web app's files (main.ts serves those). */
export async function site(req: Request, env: Env, hub: Hub, url: URL): Promise<Response | Upgrade | null> {
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, env, hub, url);
    if (url.pathname === '/install.sh' || url.pathname === '/download/CodeRail.zip' || url.pathname === '/download/latest.json') {
      const l = await latest();
      if (!l) return new Response('No build has been published yet', { status: 503 });
      if (url.pathname === '/download/latest.json') return json(l);
      if (url.pathname === '/download/CodeRail.zip') return Response.redirect(l.mac.url, 302);
      return new Response(installScript(url.origin, l), { headers: { 'content-type': 'text/x-shellscript; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    return null;
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: 'Something went wrong' }, 500);
  }
}

// ---- The audit log's length --------------------------------------------------------------------------------

/** How long the audit log may keep an entry, in days (0: for good), and the default: a log that grows forever is
 *  a database that costs more every month. */
const AUDIT_DAYS = [30, 90, 365, 0];
const AUDIT_DEFAULT_DAYS = 90;
/** The log's kinds of action, as the filter offers them: LIKE patterns on `action`. */
const AUDIT_KINDS: Record<string, string[]> = {
  prompts: ['agent.%'],
  files: ['fs.%'],
  git: ['git.%'],
  terminals: ['term.%', 'harness.%', 'preview.%'], // (preview.%: entries from before the preview proxy was removed)
  access: ['user.%', 'grant.%', 'invite.%', 'machine.%', 'settings.%', 'password', 'signup', 'setup'],
};

async function auditDays(env: Env): Promise<number> {
  const r = await env.DB.prepare('SELECT v FROM settings WHERE k = ?').bind('audit_days').first<{ v: string }>().catch(() => null);
  const d = r ? Number(r.v) : AUDIT_DEFAULT_DAYS;
  return AUDIT_DAYS.includes(d) ? d : AUDIT_DEFAULT_DAYS;
}

/** Once a day (main.ts): the audit log loses what's older than it keeps. */
export async function trimAudit(env: Env) {
  const d = await auditDays(env);
  if (d) await env.DB.prepare('DELETE FROM audit WHERE at < ?').bind(now() - d * 86_400_000).run();
}


// ---- The API -------------------------------------------------------------------------------------------

async function api(req: Request, env: Env, hub: Hub, url: URL): Promise<Response | Upgrade> {
  const path = url.pathname.slice(4); // keep the leading /
  const m = req.method;
  if (m !== 'GET' && m !== 'HEAD') checkOrigin(req, url);

  // -- no sign-in needed
  if (path === '/me' && m === 'GET') {
    const user = await currentUser(env, req);
    const any = await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first();
    return json({ user: user ? publicUser(user) : null, setup: !any });
  }
  if (path === '/setup' && m === 'POST') {
    const b = await body(req);
    if (!env.SETUP_TOKEN) throw new HttpError(503, 'This server has no SETUP_TOKEN; set it in its environment and restart it');
    await limit(req, 'setup');
    if (typeof b.token !== 'string' || !timingSafeEqual(await sha256(b.token), await sha256(env.SETUP_TOKEN))) throw new HttpError(403, 'Wrong setup token');
    if (await env.DB.prepare('SELECT 1 FROM users LIMIT 1').first()) throw new HttpError(409, 'Setup is already done');
    const username = checkUsername(b.username);
    const password = checkPassword(b.password);
    // (Claimed first, so two setups at once can't both make an admin.)
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO settings (k, v) VALUES ('setup', ?)").bind(String(now())).run();
    if (!claim.meta.changes) throw new HttpError(409, 'Setup is already done');
    const user = await createUser(env, username, password, true).catch(async (e) => {
      await env.DB.prepare("DELETE FROM settings WHERE k = 'setup'").run();
      throw e;
    });
    await audit(env, user, null, 'setup');
    return json({ user: publicUser(user) }, 200, { 'set-cookie': await startSession(env, user, req) });
  }
  if (path === '/login' && m === 'POST') {
    const b = await body(req);
    await limit(req, 'login');
    const user = await verifyLogin(env, String(b.username ?? '').toLowerCase(), String(b.password ?? ''));
    return json({ user: publicUser(user) }, 200, { 'set-cookie': await startSession(env, user, req) });
  }
  if (path === '/logout' && m === 'POST') {
    const auth = await sha256(sessionToken(req) ?? '');
    const cookie = await endSession(env, req);
    hub.closeAuth(auth);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }
  let r = path.match(/^\/invites\/([\w-]+)$/);
  if (r && m === 'GET') {
    const inv = await env.DB.prepare('SELECT is_admin FROM invites WHERE code = ? AND used_by IS NULL AND expires_at > ?').bind(r[1], now()).first<{ is_admin: number }>();
    return json({ valid: !!inv, isAdmin: !!inv?.is_admin });
  }
  if (path === '/signup' && m === 'POST') {
    const b = await body(req);
    await limit(req, 'signup');
    const username = checkUsername(b.username);
    const password = checkPassword(b.password);
    // The invite is claimed in one step, so one link can't make two accounts.
    const id = randomId();
    const inv = await env.DB.prepare('UPDATE invites SET used_by = ? WHERE code = ? AND used_by IS NULL AND expires_at > ? RETURNING is_admin')
      .bind(id, String(b.code), now())
      .first<{ is_admin: number }>();
    if (!inv) throw new HttpError(410, 'This invite link is used up or expired');
    const user = await createUser(env, username, password, !!inv.is_admin, id).catch(async (e) => {
      await env.DB.prepare('UPDATE invites SET used_by = NULL WHERE code = ? AND used_by = ?').bind(String(b.code), id).run();
      throw e;
    });
    await audit(env, user, null, 'signup');
    return json({ user: publicUser(user) }, 200, { 'set-cookie': await startSession(env, user, req) });
  }

  // -- the bridge
  if (path === '/pair/start' && m === 'POST') {
    const b = await body(req);
    await limit(req, 'pair');
    const code = pairCode();
    const secret = randomToken(24);
    const t = now();
    await env.DB.prepare('DELETE FROM pair_requests WHERE expires_at < ?').bind(t).run();
    const waiting = await env.DB.prepare('SELECT COUNT(*) AS n FROM pair_requests').first<{ n: number }>();
    if ((waiting?.n ?? 0) >= 200) throw new HttpError(429, 'Too many computers are waiting to be linked; try again in a few minutes');
    await env.DB.prepare('INSERT INTO pair_requests (code, secret_hash, name, info, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(code, await sha256(secret), String(b.name ?? 'Computer').slice(0, 64), JSON.stringify(b.info ?? null).slice(0, 8000), t, t + 15 * 60_000)
      .run();
    return json({ code, secret, url: `${url.origin}/link?code=${code}`, expiresAt: t + 15 * 60_000 });
  }
  if (path === '/pair/poll' && m === 'POST') {
    const b = await body(req);
    const row = await env.DB.prepare('SELECT * FROM pair_requests WHERE code = ?').bind(String(b.code)).first<any>();
    if (!row || row.secret_hash !== (await sha256(String(b.secret)))) throw new HttpError(404, 'No such link request');
    if (row.machine_id && row.token) {
      await env.DB.prepare('DELETE FROM pair_requests WHERE code = ?').bind(row.code).run();
      const mrow = await env.DB.prepare('SELECT name FROM machines WHERE id = ?').bind(row.machine_id).first<{ name: string }>();
      return json({ machineId: row.machine_id, token: row.token, name: mrow?.name ?? row.name });
    }
    if (row.expires_at < now()) throw new HttpError(410, 'The code expired; run coderail link again');
    return json({ pending: true });
  }
  if (path === '/bridge' && m === 'GET') {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'No machine token');
    const mrow = await env.DB.prepare('SELECT id FROM machines WHERE token_hash = ?').bind(await sha256(token)).first<{ id: string }>();
    if (!mrow) throw new HttpError(401, 'This machine was removed or its token is wrong; run coderail link again');
    if (req.headers.get('upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
    return new Upgrade(hub.get(mrow.id).bridgeData());
  }

  // -- signed in from here
  const user = await requireUser(env, req);

  if (path === '/password' && m === 'POST') {
    const b = await body(req);
    await limit(req, 'login');
    await verifyLogin(env, user.username, String(b.current ?? ''));
    const { hash, salt } = await hashPassword(checkPassword(b.next));
    await env.DB.prepare('UPDATE users SET pw_hash = ?, pw_salt = ? WHERE id = ?').bind(hash, salt, user.id).run();
    // Signed out everywhere else, open sockets included.
    const mine = await sha256(sessionToken(req) ?? '');
    const others = await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ? AND id_hash != ? RETURNING id_hash').bind(user.id, mine).all<{ id_hash: string }>();
    for (const o of others.results) hub.closeAuth(o.id_hash);
    await audit(env, user, null, 'password');
    return json({ ok: true });
  }

  // users and invites
  if (path === '/users' && m === 'GET') {
    // Everyone sees who they can share a computer with; only admins see who is an admin or disabled.
    const rows = await env.DB.prepare(`SELECT id, username, is_admin, disabled, created_at FROM users ${user.isAdmin ? '' : 'WHERE disabled = 0'} ORDER BY username`).all<any>();
    return json(
      rows.results.map((u) =>
        user.isAdmin ? { id: u.id, username: u.username, isAdmin: !!u.is_admin, disabled: !!u.disabled, createdAt: u.created_at } : { id: u.id, username: u.username, isAdmin: false, disabled: false, createdAt: u.created_at },
      ),
    );
  }
  r = path.match(/^\/users\/([\w-]+)$/);
  if (r && (m === 'PATCH' || m === 'DELETE')) {
    requireAdmin(user);
    const target = r[1];
    if (target === user.id) throw new HttpError(400, 'You cannot change or remove yourself here');
    if (m === 'PATCH') {
      const b = await body(req);
      if (typeof b.isAdmin === 'boolean') await env.DB.prepare('UPDATE users SET is_admin = ? WHERE id = ?').bind(b.isAdmin ? 1 : 0, target).run();
      if (typeof b.disabled === 'boolean') {
        await env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?').bind(b.disabled ? 1 : 0, target).run();
        if (b.disabled) await dropUser(env, hub, target);
      }
      if (typeof b.isAdmin === 'boolean' || b.disabled === false) await rescopeUser(env, hub, target);
      await audit(env, user, null, 'user.update', { target, ...b });
    } else {
      await dropUser(env, hub, target);
      await env.DB.prepare('UPDATE machines SET owner_id = ? WHERE owner_id = ?').bind(user.id, target).run();
      await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(target).run();
      await audit(env, user, null, 'user.delete', { target });
    }
    return json({ ok: true });
  }
  if (path === '/invites' && m === 'GET') {
    requireAdmin(user);
    const rows = await env.DB.prepare(
      'SELECT i.code, i.is_admin, i.created_at, i.expires_at, u.username AS by FROM invites i LEFT JOIN users u ON u.id = i.created_by WHERE i.used_by IS NULL AND i.expires_at > ? ORDER BY i.created_at DESC',
    )
      .bind(now())
      .all<any>();
    return json(rows.results.map((i) => ({ code: i.code, isAdmin: !!i.is_admin, createdAt: i.created_at, expiresAt: i.expires_at, createdBy: i.by })));
  }
  if (path === '/invites' && m === 'POST') {
    requireAdmin(user);
    const b = await body(req);
    const code = randomToken(18);
    const expiresAt = now() + 7 * 86400_000;
    await env.DB.prepare('INSERT INTO invites (code, is_admin, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').bind(code, b.isAdmin ? 1 : 0, user.id, now(), expiresAt).run();
    await audit(env, user, null, 'invite.create', { isAdmin: !!b.isAdmin });
    return json({ code, url: `${url.origin}/invite/${code}`, expiresAt });
  }
  r = path.match(/^\/invites\/([\w-]+)$/);
  if (r && m === 'DELETE') {
    requireAdmin(user);
    await env.DB.prepare('DELETE FROM invites WHERE code = ?').bind(r[1]).run();
    return json({ ok: true });
  }

  // linking a computer
  r = path.match(/^\/pair\/([A-Z0-9-]+)$/);
  if (r && m === 'GET') {
    const row = await env.DB.prepare('SELECT code, name, info, expires_at, machine_id FROM pair_requests WHERE code = ?').bind(r[1].toUpperCase()).first<any>();
    if (!row || row.expires_at < now()) throw new HttpError(404, 'That code is wrong or expired');
    return json({ code: row.code, name: row.name, info: row.info ? JSON.parse(row.info) : null, expiresAt: row.expires_at, approved: !!row.machine_id });
  }
  r = path.match(/^\/pair\/([A-Z0-9-]+)\/approve$/);
  if (r && m === 'POST') {
    const b = await body(req);
    const row = await env.DB.prepare('SELECT code, name, info, expires_at, machine_id FROM pair_requests WHERE code = ?').bind(r[1].toUpperCase()).first<any>();
    if (!row || row.expires_at < now()) throw new HttpError(404, 'That code is wrong or expired');
    if (row.machine_id) throw new HttpError(409, 'That computer is already linked');
    const id = randomId();
    const token = 'crm_' + randomToken(32);
    const name = String(b.name || row.name).slice(0, 64);
    // (The request is claimed and the machine made in one transaction; a second approval at the same time makes nothing.)
    const [claimed] = await env.DB.batch([
      env.DB.prepare('UPDATE pair_requests SET machine_id = ?, token = ? WHERE code = ? AND machine_id IS NULL').bind(id, token, row.code),
      env.DB.prepare('INSERT INTO machines (id, name, token_hash, owner_id, created_at, info) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM pair_requests WHERE code = ? AND machine_id = ?)')
        .bind(id, name, await sha256(token), user.id, now(), row.info, row.code, id),
    ]);
    if (!claimed.meta.changes) throw new HttpError(409, 'That computer is already linked');
    await audit(env, user, id, 'machine.link', { name });
    return json({ machineId: id });
  }

  // machines
  if (path === '/machines' && m === 'GET') return json(await listMachines(env, user));
  r = path.match(/^\/machines\/([\w-]+)(\/.*)?$/);
  if (r) return machineApi(req, env, hub, url, user, r[1], r[2] ?? '');

  if (path === '/audit' && m === 'GET') {
    // A page of the log, newest first, by computer, person and kind of action (see AUDIT_KINDS). One row past the
    // page says whether there is another.
    const sp = url.searchParams;
    const size = Math.min(Math.max(Number(sp.get('size')) || 50, 10), 200);
    const page = Math.max(Number(sp.get('page')) || 0, 0);
    let q = 'SELECT a.at, a.username, a.machine_id, a.action, a.detail, m.name AS machine_name FROM audit a LEFT JOIN machines m ON m.id = a.machine_id';
    const where: string[] = [];
    const binds: any[] = [];
    if (!user.isAdmin) where.push('m.owner_id = ?'), binds.push(user.id);
    if (sp.get('machine')) where.push('a.machine_id = ?'), binds.push(sp.get('machine'));
    if (sp.get('user')) where.push('a.username = ?'), binds.push(sp.get('user'));
    const kind = AUDIT_KINDS[sp.get('kind') ?? ''];
    if (kind) where.push('(' + kind.map(() => 'a.action LIKE ?').join(' OR ') + ')'), binds.push(...kind);
    if (where.length) q += ' WHERE ' + where.join(' AND ');
    q += ' ORDER BY a.id DESC LIMIT ? OFFSET ?';
    const rows = (await env.DB.prepare(q).bind(...binds, size + 1, page * size).all<any>()).results;
    return json({
      rows: rows.slice(0, size).map((a) => ({ at: a.at, username: a.username, machineId: a.machine_id, machineName: a.machine_name, action: a.action, detail: a.detail ? JSON.parse(a.detail) : null })),
      page, size, more: rows.length > size,
    });
  }

  // settings for the whole deployment (admins)
  if (path === '/settings' && m === 'GET') {
    requireAdmin(user);
    return json({ auditDays: await auditDays(env) });
  }
  if (path === '/settings' && m === 'PATCH') {
    requireAdmin(user);
    const b = await body(req);
    if (b.auditDays !== undefined) {
      const d = Number(b.auditDays);
      if (!AUDIT_DAYS.includes(d)) throw new HttpError(400, 'Keep the audit log for 30, 90 or 365 days, or for good');
      await env.DB.prepare('INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v').bind('audit_days', String(d)).run();
      await audit(env, user, null, 'settings.update', { auditDays: d });
      await trimAudit(env);
    }
    return json({ auditDays: await auditDays(env) });
  }

  // push
  if (path === '/push/key' && m === 'GET') return json({ publicKey: pushEnabled(env) ? env.VAPID_PUBLIC_KEY : null });
  if (path === '/push/subscribe' && m === 'POST') {
    const b = await body(req);
    const sub = b.subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth || !/^https:\/\//.test(String(sub.endpoint))) throw new HttpError(400, 'Not a push subscription');
    await env.DB.prepare('INSERT OR REPLACE INTO push_subs (endpoint, user_id, sub, created_at) VALUES (?, ?, ?, ?)').bind(sub.endpoint, user.id, JSON.stringify(sub), now()).run();
    return json({ ok: true });
  }
  if (path === '/push/unsubscribe' && m === 'POST') {
    const b = await body(req);
    await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?').bind(String(b.endpoint), user.id).run();
    return json({ ok: true });
  }

  throw new HttpError(404, 'No such API');
}

async function machineApi(req: Request, env: Env, hub: Hub, url: URL, user: User, id: string, rest: string): Promise<Response | Upgrade> {
  const scope = await machineScope(env, user, id);
  if (!scope) throw new HttpError(404, 'No such machine');
  const m = req.method;
  const owner = () => {
    if (scope.role !== 'owner') throw new HttpError(403, 'Only the owner can do that');
  };

  if (rest === '/ws' && m === 'GET') {
    if (req.headers.get('upgrade') !== 'websocket') throw new HttpError(426, 'Expected a WebSocket');
    checkOrigin(req, url); // a socket upgrade is a GET, but it carries the cookie like a write would
    const caller: Caller = { ...scope, userId: user.id, username: user.username };
    return new Upgrade(hub.get(id).clientData(caller, await sha256(sessionToken(req) ?? '')));
  }
  // (A file's bytes for the browser's own viewers and downloads; a folder as a zip: server/src/files.ts.)
  if (rest === '/files' && (m === 'GET' || m === 'HEAD')) {
    return fileRoute(req, hub.get(id), { ...scope, userId: user.id, username: user.username }, url);
  }
  if (rest === '/zip' && m === 'POST') {
    return zipStart(hub.get(id), { ...scope, userId: user.id, username: user.username }, (await body(req)).path);
  }
  const zip = rest.match(/^\/zip\/([\w-]+)$/);
  if (zip && (m === 'GET' || m === 'HEAD')) {
    return zipRoute(req, hub.get(id), { ...scope, userId: user.id, username: user.username }, zip[1], url);
  }
  if (rest === '' && m === 'PATCH') {
    owner();
    const b = await body(req);
    const name = String(b.name ?? '').trim().slice(0, 64);
    if (!name) throw new HttpError(400, 'Give it a name');
    await env.DB.prepare('UPDATE machines SET name = ? WHERE id = ?').bind(name, id).run();
    await audit(env, user, id, 'machine.rename', { name });
    return json({ ok: true });
  }
  if (rest === '' && m === 'DELETE') {
    owner();
    // (The row goes first, so the bridge can't reconnect between the two.)
    await env.DB.prepare('DELETE FROM machines WHERE id = ?').bind(id).run();
    hub.revoke(id);
    await audit(env, user, id, 'machine.remove');
    return json({ ok: true });
  }
  if (rest === '/grants' && m === 'GET') {
    owner();
    const rows = await env.DB.prepare('SELECT g.*, u.username FROM grants g JOIN users u ON u.id = g.user_id WHERE g.machine_id = ? ORDER BY u.username').bind(id).all<any>();
    return json(
      rows.results.map((g) => ({
        userId: g.user_id,
        username: g.username,
        role: g.role,
        folders: g.folders ? JSON.parse(g.folders) : null,
        harnesses: g.harnesses ? JSON.parse(g.harnesses) : null,
        terminal: !!g.terminal,
      })),
    );
  }
  const g = rest.match(/^\/grants\/([\w-]+)$/);
  if (g && m === 'PUT') {
    owner();
    const b = await body(req);
    const role = b.role as Role;
    if (!['owner', 'operator', 'viewer'].includes(role)) throw new HttpError(400, 'Role is owner, operator or viewer');
    const target = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(g[1]).first();
    if (!target) throw new HttpError(404, 'No such user');
    const list = (v: unknown) => (Array.isArray(v) && v.length ? JSON.stringify(v.map(String).filter(Boolean).slice(0, 50)) : null);
    if (b.folders != null && !Array.isArray(b.folders)) throw new HttpError(400, 'Folders are a list');
    const named: string[] = (b.folders ?? []).map((f: unknown) => String(f).trim()).filter(Boolean);
    // (A folder limit that can't be read is refused, never widened to everywhere.)
    if (named.some((f) => !f.startsWith('/'))) throw new HttpError(400, 'Folders are absolute paths, starting with /');
    const folders = list(named.map((f) => f.replace(/\/+$/, '') || '/'));
    await env.DB.prepare(
      `INSERT INTO grants (machine_id, user_id, role, folders, harnesses, terminal) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(machine_id, user_id) DO UPDATE SET role = excluded.role, folders = excluded.folders, harnesses = excluded.harnesses, terminal = excluded.terminal`,
    )
      .bind(id, g[1], role, folders, list(b.harnesses), b.terminal ? 1 : 0)
      .run();
    await audit(env, user, id, 'grant.set', { userId: g[1], role, folders: b.folders, harnesses: b.harnesses, terminal: !!b.terminal });
    await rescope(env, hub, id, g[1]);
    return json({ ok: true });
  }
  if (g && m === 'DELETE') {
    owner();
    await env.DB.prepare('DELETE FROM grants WHERE machine_id = ? AND user_id = ?').bind(id, g[1]).run();
    await audit(env, user, id, 'grant.remove', { userId: g[1] });
    await rescope(env, hub, id, g[1]);
    return json({ ok: true });
  }
  throw new HttpError(404, 'No such API');
}

async function listMachines(env: Env, user: User): Promise<MachineSummary[]> {
  const rows = user.isAdmin
    ? await env.DB.prepare('SELECT m.*, u.username AS owner_name, NULL AS role, NULL AS folders, NULL AS harnesses, 0 AS terminal FROM machines m LEFT JOIN users u ON u.id = m.owner_id ORDER BY m.name').all<any>()
    : await env.DB.prepare(
        `SELECT m.*, u.username AS owner_name, g.role, g.folders, g.harnesses, g.terminal FROM machines m
         LEFT JOIN users u ON u.id = m.owner_id
         LEFT JOIN grants g ON g.machine_id = m.id AND g.user_id = ?1
         WHERE m.owner_id = ?1 OR g.user_id = ?1 ORDER BY m.name`,
      )
        .bind(user.id)
        .all<any>();
  return rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    online: !!r.online,
    lastSeen: r.last_seen,
    info: r.info ? JSON.parse(r.info) : null,
    scope: user.isAdmin || r.owner_id === user.id ? { role: 'owner', folders: null, harnesses: null, terminal: true } : grantScope(r),
    createdAt: r.created_at,
  }));
}

/** Tell a machine's hub what a user may now do there (or that they may not connect at all). */
async function rescope(env: Env, hub: Hub, machineId: string, userId: string) {
  const m = hub.loaded(machineId);
  if (!m) return;
  const u = await env.DB.prepare('SELECT id, username, is_admin, disabled FROM users WHERE id = ?').bind(userId).first<any>();
  const scope: Scope | null = u && !u.disabled ? await machineScope(env, { id: u.id, username: u.username, isAdmin: !!u.is_admin }, machineId) : null;
  m.updateScope(userId, scope ? { ...scope, userId, username: u.username } : null);
}

async function rescopeUser(env: Env, hub: Hub, userId: string) {
  const rows = await env.DB.prepare('SELECT id FROM machines').all<{ id: string }>();
  await Promise.all(rows.results.map((r) => rescope(env, hub, r.id, userId)));
}

async function dropUser(env: Env, hub: Hub, userId: string) {
  await env.DB.prepare('DELETE FROM auth_sessions WHERE user_id = ?').bind(userId).run();
  const rows = await env.DB.prepare('SELECT id FROM machines').all<{ id: string }>();
  for (const r of rows.results) hub.loaded(r.id)?.updateScope(userId, null);
}

/** Cookie-authenticated writes must come from this site's own pages. */
function checkOrigin(req: Request, url: URL) {
  const origin = req.headers.get('origin');
  if (origin && origin !== url.origin) throw new HttpError(403, 'Cross-site request refused');
}
