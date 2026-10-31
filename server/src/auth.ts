// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Role, Scope } from '@coderail/protocol';
import { type Env, HttpError, hashPassword, now, parseCookies, randomId, randomToken, sha256, timingSafeEqual } from './util';

export interface User {
  id: string;
  username: string;
  isAdmin: boolean;
}

const SESSION_DAYS = 30;

/** The session cookie: __Host- over https, so no other site under the same domain can set it. */
const cookieName = (req: Request) => (new URL(req.url).protocol === 'https:' ? '__Host-cr_session' : 'cr_session');

/** The session token this request carries, if any. */
export function sessionToken(req: Request): string | null {
  return parseCookies(req)[cookieName(req)] ?? bearer(req);
}

export function publicUser(u: User) {
  return { id: u.id, username: u.username, isAdmin: u.isAdmin };
}

export function checkUsername(name: unknown): string {
  if (typeof name !== 'string' || !/^[a-z0-9_.-]{2,32}$/.test(name)) {
    throw new HttpError(400, 'Usernames are 2-32 lowercase letters, digits, _ . or -');
  }
  return name;
}

export function checkPassword(pw: unknown): string {
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 256) throw new HttpError(400, 'Passwords need at least 8 characters');
  return pw;
}

export async function createUser(env: Env, username: string, password: string, isAdmin: boolean, id = randomId()): Promise<User> {
  const existing = await env.DB.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first();
  if (existing) throw new HttpError(409, 'That username is taken');
  const { hash, salt } = await hashPassword(password);
  await env.DB.prepare('INSERT INTO users (id, username, pw_hash, pw_salt, is_admin, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(id, username, hash, salt, isAdmin ? 1 : 0, now())
    .run();
  return { id, username, isAdmin };
}

export async function verifyLogin(env: Env, username: string, password: string): Promise<User> {
  const row = await env.DB.prepare('SELECT id, username, pw_hash, pw_salt, is_admin, disabled FROM users WHERE username = ?')
    .bind(username)
    .first<{ id: string; username: string; pw_hash: string; pw_salt: string; is_admin: number; disabled: number }>();
  // Hash even when the user does not exist, so timing does not tell which usernames exist.
  const { hash } = await hashPassword(password, row?.pw_salt ?? 'AAAAAAAAAAAAAAAAAAAAAA');
  if (!row || !timingSafeEqual(hash, row.pw_hash) || row.disabled) throw new HttpError(401, 'Wrong username or password');
  return { id: row.id, username: row.username, isAdmin: !!row.is_admin };
}

export async function startSession(env: Env, user: User, req: Request): Promise<string> {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(t).run();
  await env.DB.prepare('INSERT INTO auth_sessions (id_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(token), user.id, t, t + SESSION_DAYS * 86400_000)
    .run();
  return sessionCookie(token, req, SESSION_DAYS * 86400);
}

function sessionCookie(value: string, req: Request, maxAge: number): string {
  const secure = new URL(req.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(req)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function endSession(env: Env, req: Request): Promise<string> {
  const token = parseCookies(req)[cookieName(req)];
  if (token) await env.DB.prepare('DELETE FROM auth_sessions WHERE id_hash = ?').bind(await sha256(token)).run();
  return sessionCookie('', req, 0);
}

export async function currentUser(env: Env, req: Request): Promise<User | null> {
  const token = sessionToken(req);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.is_admin FROM auth_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id_hash = ? AND s.expires_at > ? AND u.disabled = 0`,
  )
    .bind(await sha256(token), now())
    .first<{ id: string; username: string; is_admin: number }>();
  return row ? { id: row.id, username: row.username, isAdmin: !!row.is_admin } : null;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('authorization');
  return h?.startsWith('Bearer ') ? h.slice(7) : null;
}

export async function requireUser(env: Env, req: Request): Promise<User> {
  const u = await currentUser(env, req);
  if (!u) throw new HttpError(401, 'Sign in first');
  return u;
}

export function requireAdmin(u: User) {
  if (!u.isAdmin) throw new HttpError(403, 'Only admins can do that');
}

const OWNER_SCOPE: Scope = { role: 'owner', folders: null, harnesses: null, terminal: true };

/** The user's scope on a machine, or null when they have none. Admins act as owners everywhere. */
export async function machineScope(env: Env, user: User, machineId: string): Promise<Scope | null> {
  const m = await env.DB.prepare('SELECT owner_id FROM machines WHERE id = ?').bind(machineId).first<{ owner_id: string }>();
  if (!m) return null;
  if (user.isAdmin || m.owner_id === user.id) return OWNER_SCOPE;
  const g = await env.DB.prepare('SELECT role, folders, harnesses, terminal FROM grants WHERE machine_id = ? AND user_id = ?')
    .bind(machineId, user.id)
    .first<{ role: Role; folders: string | null; harnesses: string | null; terminal: number }>();
  if (!g) return null;
  return grantScope(g);
}

export function grantScope(g: { role: Role; folders: string | null; harnesses: string | null; terminal: number }): Scope {
  if (g.role === 'owner') return OWNER_SCOPE;
  return {
    role: g.role,
    folders: g.folders ? JSON.parse(g.folders) : null,
    harnesses: g.harnesses ? JSON.parse(g.harnesses) : null,
    terminal: g.role === 'operator' && !!g.terminal,
  };
}

export async function audit(env: Env, user: { id: string; username: string } | null, machineId: string | null, action: string, detail?: unknown) {
  await env.DB.prepare('INSERT INTO audit (at, user_id, username, machine_id, action, detail) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(now(), user?.id ?? null, user?.username ?? null, machineId, action, detail === undefined ? null : JSON.stringify(detail).slice(0, 2000))
    .run();
}
