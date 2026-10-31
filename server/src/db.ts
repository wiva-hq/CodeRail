// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The database: SQLite in one file, behind the small prepare/bind/first/all/run/batch API the routes are written
// against (it was Cloudflare D1's), so each query reads the same as it did there.
import { Database, type SQLQueryBindings } from 'bun:sqlite';

/** For every database here: a write-ahead log (readers never wait on the writer), syncs only at checkpoints (a
 *  crash can lose the last moment, never corrupt), and pages kept in memory. */
export const PERFORMANCE =
  'PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -16000; PRAGMA mmap_size = 268435456;';

export interface RunResult {
  meta: { changes: number };
}

export class Statement {
  constructor(private db: Database, private sql: string, private args: SQLQueryBindings[] = []) {}

  bind(...args: unknown[]): Statement {
    return new Statement(this.db, this.sql, args.map((a) => (a === undefined ? null : a)) as SQLQueryBindings[]);
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    return (this.db.query(this.sql).get(...this.args) as T | null) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: this.db.query(this.sql).all(...this.args) as T[] };
  }

  async run(): Promise<RunResult> {
    return { meta: { changes: this.db.query(this.sql).run(...this.args).changes } };
  }

  /** Runs now, for batch(). */
  runSync(): RunResult {
    return { meta: { changes: this.db.query(this.sql).run(...this.args).changes } };
  }
}

export class Db {
  readonly sqlite: Database;

  constructor(path: string) {
    this.sqlite = new Database(path, { create: true });
    this.sqlite.exec(PERFORMANCE + 'PRAGMA foreign_keys = ON;');
  }

  prepare(sql: string): Statement {
    return new Statement(this.sqlite, sql);
  }

  /** The statements in one transaction: all of them or none. */
  async batch(statements: Statement[]): Promise<RunResult[]> {
    return this.sqlite.transaction(() => statements.map((s) => s.runSync()))();
  }
}
