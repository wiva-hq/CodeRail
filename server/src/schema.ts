// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import type { Db } from './db';
import m0001 from '../migrations/0001_init.sql' with { type: 'text' };
import m0002 from '../migrations/0002_audit_at.sql' with { type: 'text' };

/** The database's tables: each file in migrations/ is applied once, in order, at start, and recorded. */
const MIGRATIONS: [string, string][] = [['0001_init.sql', m0001], ['0002_audit_at.sql', m0002]];

export function migrate(db: Db) {
  const sqlite = db.sqlite;
  sqlite.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const done = new Set(sqlite.query<{ name: string }, []>('SELECT name FROM migrations').all().map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.query('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(name, Date.now());
    })();
  }
}
