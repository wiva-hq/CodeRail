// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { buildPushPayload, type PushSubscription } from '@block65/webcrypto-web-push';
import type { Approval, SessionRow } from '@coderail/protocol';
import { inFolders } from '@coderail/protocol';
import type { Env } from './util';

export function pushEnabled(env: Env): boolean {
  return !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

/** Tell everyone who may answer an approval that it is waiting. */
export async function notifyApproval(env: Env, machineId: string, s: SessionRow, a: Approval) {
  if (!pushEnabled(env)) return;
  const m = await env.DB.prepare('SELECT name, owner_id FROM machines WHERE id = ?').bind(machineId).first<{ name: string; owner_id: string }>();
  if (!m) return;
  const users = new Set<string>([m.owner_id]);
  const admins = await env.DB.prepare('SELECT id FROM users WHERE is_admin = 1 AND disabled = 0').all<{ id: string }>();
  for (const r of admins.results) users.add(r.id);
  const grants = await env.DB.prepare("SELECT user_id, role, folders, harnesses FROM grants WHERE machine_id = ? AND role IN ('owner', 'operator')")
    .bind(machineId)
    .all<{ user_id: string; folders: string | null; harnesses: string | null }>();
  for (const g of grants.results) {
    const folders = g.folders ? JSON.parse(g.folders) : null;
    const harnesses = g.harnesses ? JSON.parse(g.harnesses) : null;
    if (inFolders(s.cwd, folders) && (!harnesses || harnesses.includes(s.harness))) users.add(g.user_id);
  }
  const title = a.toolCall?.title ?? 'An agent needs your approval';
  const body = `${m.name} · ${s.title ?? s.cwd.split('/').pop()}`;
  const url = `/m/${machineId}/s/${s.sessionId}`;
  await sendTo(env, [...users], { title: `Approve: ${title}`.slice(0, 120), body, url, tag: a.id });
}

export async function sendTo(env: Env, userIds: string[], payload: { title: string; body: string; url: string; tag?: string }) {
  if (!userIds.length) return;
  const q = `SELECT p.endpoint, p.sub FROM push_subs p JOIN users u ON u.id = p.user_id WHERE u.disabled = 0 AND p.user_id IN (${userIds.map(() => '?').join(',')})`;
  const subs = await env.DB.prepare(q).bind(...userIds).all<{ endpoint: string; sub: string }>();
  const vapid = { subject: env.VAPID_SUBJECT ?? 'mailto:admin@example.com', publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY };
  await Promise.all(
    subs.results.map(async (row) => {
      try {
        const sub = JSON.parse(row.sub) as PushSubscription;
        const req = await buildPushPayload({ data: payload, options: { ttl: 3600, urgency: 'high' } }, sub, vapid);
        const res = await fetch(sub.endpoint, req);
        if (res.status === 404 || res.status === 410) {
          await env.DB.prepare('DELETE FROM push_subs WHERE endpoint = ?').bind(row.endpoint).run();
        }
      } catch (e) {
        console.error('push failed', e);
      }
    }),
  );
}
