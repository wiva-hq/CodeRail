// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { watch, type FSWatcher } from 'node:fs';
import { createHash } from 'node:crypto';
import { win32 as p } from 'node:path';
import { ScopedWindowsFs } from './fs';
import { error } from './paths';

export type Snapshot = ReadonlyMap<string, string>;
/** Never follow reparse entries. Restricted watch snapshots cannot read a link's external target. */
export async function snapshot(fs: ScopedWindowsFs, limit = 10000): Promise<Snapshot> {
  const result = new Map<string, string>();
  const walk = async (directory: string) => {
    for (const entry of await fs.list(directory)) {
      const path = p.join(directory, entry.name), relative = p.relative(fs.root, path);
      if (result.size >= limit) throw error('E2BIG', 'Snapshot entry limit exceeded');
      try {
        if (entry.isSymbolicLink()) { result.set(relative, 'reparse'); continue; }
        if (entry.isDirectory()) { result.set(relative, 'directory'); await walk(path); }
        else {
          const digest = entry.size <= 1048576n ? createHash('sha256').update(await fs.read(path, 1048576, true)).digest('hex') : '';
          result.set(relative, `${entry.size}:${entry.mtimeNs}:${digest}`);
        }
      } catch (e: any) { if (e.code !== 'ENOENT') throw e; } // A rename/delete during enumeration is reconciled next scan.
    }
  };
  await walk(fs.root); return result;
}
export class SnapshotWatcher {
  private native: FSWatcher | undefined;
  private tick: ReturnType<typeof setInterval> | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private dirty = false;
  private stopped = false;
  private previous: Snapshot = new Map();
  events = 0;
  scans = 0;
  constructor(private fs: ScopedWindowsFs, private onChange: (snapshot: Snapshot, changes: string[]) => void, private onError: (error: Error) => void, private pollMs = 1000) {}
  async start() {
    if (this.tick || this.stopped) throw error('EINVAL', 'Watcher cannot be started twice');
    this.native = watch(this.fs.root, { recursive: true }, (_kind, _name) => { this.events++; this.invalidate(); });
    this.native.on('error', e => { this.onError(e); this.native?.close(); this.native = undefined; this.invalidate(); });
    this.tick = setInterval(() => this.invalidate(), this.pollMs);
    await this.scan();
  }
  /** A null filename or overflow means a full rescan, never an ignored event. */
  invalidate() {
    if (this.stopped) return;
    this.dirty = true;
    if (!this.timer && !this.running) this.timer = setTimeout(() => { this.timer = undefined; void this.scan(); }, 75);
  }
  private async scan() {
    if (this.stopped) return;
    if (this.running) { this.dirty = true; return this.running; }
    this.dirty = false;
    this.running = (async () => {
      try {
        const next = await snapshot(this.fs); this.scans++;
        const names = new Set([...this.previous.keys(), ...next.keys()]);
        const changed = [...names].filter(name => this.previous.get(name) !== next.get(name));
        this.previous = next;
        if (changed.length && !this.stopped) this.onChange(next, changed);
      } catch (e) { this.onError(e as Error); }
    })();
    await this.running; this.running = undefined;
    if (this.dirty && !this.stopped) this.invalidate();
  }
  async close() {
    this.stopped = true; this.native?.close();
    if (this.tick) clearInterval(this.tick);
    if (this.timer) clearTimeout(this.timer);
    await this.running;
  }
}
