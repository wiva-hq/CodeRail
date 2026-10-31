// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The machines' hubs, by id: each made on first use, with its SQLite file in <data>/machines/.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Machine, type SockData } from './machine';
import { type Env, HttpError, now } from './util';

export class Hub {
  private machines = new Map<string, Machine>();
  /** Machines removed while this process runs: a request already past its check can't bring one back. */
  private gone = new Set<string>();
  private dir: string;

  constructor(private env: Env, dataDir: string) {
    this.dir = join(dataDir, 'machines');
    mkdirSync(this.dir, { recursive: true });
  }

  get(id: string): Machine {
    if (this.gone.has(id)) throw new HttpError(404, 'This machine was removed');
    let m = this.machines.get(id);
    if (!m) {
      m = new Machine(id, this.env, join(this.dir, `${id.replace(/[^\w-]/g, '_')}.sqlite`));
      this.machines.set(id, m);
    }
    return m;
  }

  /** The hub if it is running (one no socket has used since the start has nothing to tell). */
  loaded(id: string): Machine | undefined {
    return this.machines.get(id);
  }

  revoke(id: string) {
    this.machines.get(id)?.revoke();
    this.machines.delete(id);
    this.gone.add(id);
  }

  /** Closes the clients opened with this sign-in, everywhere. */
  closeAuth(auth: string) {
    for (const m of this.machines.values()) m.closeAuth(auth);
  }

  /** Closes the clients whose sign-in ended (signed out, expired, its person disabled). */
  async sweepAuth() {
    const all = [...new Set([...this.machines.values()].flatMap((m) => m.auths()))];
    if (!all.length) return;
    const valid = new Set(
      (await this.env.DB.prepare(
        `SELECT s.id_hash FROM auth_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.expires_at > ? AND u.disabled = 0 AND s.id_hash IN (${all.map(() => '?').join(',')})`,
      ).bind(now(), ...all).all<{ id_hash: string }>()).results.map((r) => r.id_hash),
    );
    for (const a of all) if (!valid.has(a)) this.closeAuth(a);
  }
}

/** A route's answer when the request becomes a WebSocket on a machine's hub (main.ts upgrades it). */
export class Upgrade {
  constructor(readonly data: SockData) {}
}
