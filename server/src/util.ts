// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Db } from './db';

/** The server's database and settings (from the environment, see main.ts). */
export interface Env {
  DB: Db;
  SETUP_TOKEN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
}

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export async function body<T = any>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new HttpError(400, 'Expected a JSON body');
  }
}

export const now = () => Date.now();

export function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(Buffer.from(s, 'base64url'));
}

export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomId(): string {
  return randomToken(12);
}

/** A short code people read and type: XXXX-XXXX without look-alike letters. */
export function pairCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint8Array(8));
  const c = Array.from(r, (b) => alphabet[b % alphabet.length]).join('');
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return b64url(new Uint8Array(d));
}

const PBKDF2_ITERATIONS = 100_000;

export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  const s = salt ?? randomToken(16);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64urlDecode(s), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: b64url(new Uint8Array(bits)), salt: s };
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** The request's cookies. A name sent twice keeps its first value (the browser's most specific, oldest one), and a
 * cookie that doesn't decode is skipped rather than failing the request. */
export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (k in out) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return out;
}

/** The address each request came from (main.ts records it: the proxy's X-Forwarded-For, else the socket's). */
export const clientIp = new WeakMap<Request, string>();

const LIMIT = 10; // tries a minute
const tries = new Map<string, { n: number; until: number }>();

/** At most a few tries a minute from one address at sign-in, sign-up and linking. */
export async function limit(req: Request, what: string) {
  const key = `${what}:${clientIp.get(req) ?? 'unknown'}`;
  const t = now();
  const w = tries.get(key);
  if (!w || w.until < t) {
    if (tries.size > 10_000) for (const [k, v] of tries) if (v.until < t) tries.delete(k);
    // (Still full: many addresses at once. Forget them all rather than grow.)
    if (tries.size > 10_000) tries.clear();
    tries.set(key, { n: 1, until: t + 60_000 });
    return;
  }
  if (++w.n > LIMIT) throw new HttpError(429, 'Too many tries; wait a minute and try again');
}
