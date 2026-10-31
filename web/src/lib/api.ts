// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The server's HTTP API (docs/api.md): JSON in and out, the session cookie (`__Host-cr_session` over https, `cr_session` over http) for auth. Errors come back as
// `{error}` with a 4xx/5xx status and are thrown as ApiError.
import type { MachineInfo, MachineSummary, Role } from '@coderail/protocol';

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Can’t reach the server');
  }
  const text = await r.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!r.ok) throw new ApiError(r.status, data?.error ?? (r.status === 401 ? 'Signed out' : `Request failed (${r.status})`));
  return data as T;
}

export interface User { id: string; username: string; isAdmin: boolean }
export interface UserRow extends User { disabled: boolean; createdAt: number }
export interface Invite { code: string; isAdmin: boolean; createdAt: number; expiresAt: number; createdBy: string }
export interface Grant { userId: string; username: string; role: Role; folders: string[] | null; harnesses: string[] | null; terminal: boolean }
export interface AuditRow { at: number; username: string; machineId: string | null; machineName: string | null; action: string; detail: Record<string, unknown> | null }
export interface Pairing { code: string; name: string; info: Partial<MachineInfo> | null; expiresAt: number }

export const api = {
  me: () => req<{ user: User | null; setup: boolean }>('GET', '/api/me'),
  setup: (token: string, username: string, password: string) => req<{ user: User }>('POST', '/api/setup', { token, username, password }),
  login: (username: string, password: string) => req<{ user: User }>('POST', '/api/login', { username, password }),
  logout: () => req<{ ok: boolean }>('POST', '/api/logout'),
  password: (current: string, next: string) => req<{ ok: boolean }>('POST', '/api/password', { current, next }),
  invite: (code: string) => req<{ valid: boolean; isAdmin: boolean }>('GET', `/api/invites/${encodeURIComponent(code)}`),
  signup: (code: string, username: string, password: string) => req<{ user: User }>('POST', '/api/signup', { code, username, password }),

  users: () => req<UserRow[]>('GET', '/api/users'),
  patchUser: (id: string, body: { isAdmin?: boolean; disabled?: boolean }) => req<{ ok: boolean }>('PATCH', `/api/users/${id}`, body),
  deleteUser: (id: string) => req<{ ok: boolean }>('DELETE', `/api/users/${id}`),
  invites: () => req<Invite[]>('GET', '/api/invites'),
  newInvite: (isAdmin: boolean) => req<{ code: string; url: string; expiresAt: number }>('POST', '/api/invites', { isAdmin }),
  deleteInvite: (code: string) => req<{ ok: boolean }>('DELETE', `/api/invites/${encodeURIComponent(code)}`),
  /** A page of the audit log, newest first: by computer, person (username) and kind (prompts, files, git, terminals, access). */
  audit: (f: { machine?: string; user?: string; kind?: string; page?: number; size?: number }) =>
    req<{ rows: AuditRow[]; page: number; size: number; more: boolean }>('GET', `/api/audit?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)]))}`),
  settings: () => req<{ auditDays: number }>('GET', '/api/settings'),
  setSettings: (s: { auditDays?: number }) => req<{ auditDays: number }>('PATCH', '/api/settings', s),

  machines: () => req<MachineSummary[]>('GET', '/api/machines'),
  renameMachine: (id: string, name: string) => req<{ ok: boolean }>('PATCH', `/api/machines/${id}`, { name }),
  removeMachine: (id: string) => req<{ ok: boolean }>('DELETE', `/api/machines/${id}`),
  grants: (id: string) => req<Grant[]>('GET', `/api/machines/${id}/grants`),
  putGrant: (id: string, userId: string, g: Omit<Grant, 'userId' | 'username'>) => req<{ ok: boolean }>('PUT', `/api/machines/${id}/grants/${userId}`, g),
  deleteGrant: (id: string, userId: string) => req<{ ok: boolean }>('DELETE', `/api/machines/${id}/grants/${userId}`),
  pairing: (code: string) => req<Pairing>('GET', `/api/pair/${encodeURIComponent(code)}`),
  approvePairing: (code: string, name: string) => req<{ machineId: string }>('POST', `/api/pair/${encodeURIComponent(code)}/approve`, { name }),

  pushKey: () => req<{ publicKey: string | null }>('GET', '/api/push/key'),
  pushSubscribe: (subscription: PushSubscriptionJSON) => req<{ ok: boolean }>('POST', '/api/push/subscribe', { subscription }),
  pushUnsubscribe: (endpoint: string) => req<{ ok: boolean }>('POST', '/api/push/unsubscribe', { endpoint }),
};

/** An error in words for a toast or a form. */
export function plainError(e: unknown): string {
  if (!e) return 'Something went wrong';
  if (typeof e === 'string') return e;
  const m = (e as any).message ?? String(e);
  return String(m).replace(/^Error:\s*/, '');
}
