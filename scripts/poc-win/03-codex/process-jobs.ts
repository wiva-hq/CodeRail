// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { assert, until } from '../common';
import { ProcessJob, ProcessRef, snapshot, type ProcessRow } from '../../../bridge/src/platform/win32/job';
export { ProcessJob, ProcessRef, snapshot, type ProcessRow } from '../../../bridge/src/platform/win32/job';

/** One exclusive approval lease per runtime. It never accepts a fixture PID,
 * executable name, command-line substring, or PID file as ownership evidence. */
export class ApprovalCommandScope {
  private static leases = new Set<number>();
  static async acquire(runtimePid: number, itemId: string, timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!this.leases.has(runtimePid)) return new ApprovalCommandScope(runtimePid, itemId);
      await Bun.sleep(10);
    }
    throw new Error('Approval lease busy; do not grant concurrent commands in a shared runtime');
  }
  private readonly job = new ProcessJob();
  private readonly protected = new Map<number, ProcessRef>();
  private readonly captured = new Map<number, { ref: ProcessRef; row: ProcessRow }>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private failure: Error | undefined;
  private sealed = false;
  private leaseOwned = false;
  constructor(readonly runtimePid: number, readonly itemId: string) {
    if (ApprovalCommandScope.leases.has(runtimePid)) { this.job.close(); throw new Error('Approval lease already active'); }
    ApprovalCommandScope.leases.add(runtimePid); this.leaseOwned = true;
    try {
      const rows = snapshot(), ids = new Set([runtimePid]);
      let changed = true;
      while (changed) { changed = false; for (const row of rows) if (ids.has(row.parentPid) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; } }
      for (const id of ids) { const ref = ProcessRef.open(id); if (ref) this.protected.set(id, ref); }
      assert(this.protected.has(runtimePid), 'Runtime must be alive before approval');
      this.timer = setInterval(() => { try { this.sample(); } catch (e) { this.failure = e as Error; } }, 10);
    } catch (error) { this.dispose(); throw error; }
  }
  sample() {
    if (this.failure) throw this.failure;
    if (this.sealed) return;
    const rows = snapshot();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        const existing = this.captured.get(row.pid);
        if (existing) { existing.row = row; continue; }
        if (this.protected.has(row.pid)) continue;
        const parent = this.protected.get(row.parentPid) ?? this.captured.get(row.parentPid)?.ref;
        if (!parent) continue;
        const ref = ProcessRef.open(row.pid); if (!ref) continue;
        if (ref.created < parent.created) { ref.close(); continue; }
        this.captured.set(row.pid, { ref, row });
        this.job.assign(ref); changed = true;
      }
    }
    // Job inheritance is authoritative even if a root exits between snapshots.
    for (const pid of this.job.members()) if (!this.captured.has(pid)) {
      assert(!this.protected.has(pid), 'Never capture runtime / pre-existing infrastructure');
      const ref = ProcessRef.open(pid); if (!ref) continue;
      this.captured.set(pid, { ref, row: rows.find(row => row.pid === pid) ?? { pid, parentPid: 0, name: '<job member>' } });
    }
  }
  get processes() { this.sample(); return [...this.captured.values()].map(({ ref, row }) => ({ ...row, created: ref.created.toString(), alive: ref.alive() })); }
  async interrupt(sendProtocolCancel: () => Promise<unknown>, graceMs = 1500) {
    const start = performance.now();
    // Do not wait for the RPC reply before starting the grace timer.
    const protocol = sendProtocolCancel().then(value => ({ value }), error => ({ error: String(error) }));
    await Bun.sleep(graceMs); this.sample();
    assert(this.captured.size > 0, 'No command ownership captured: isolated worker recovery required');
    const residual = [...this.captured.values()].filter(p => p.ref.alive()).map(p => p.ref.pid);
    this.sealed = true;
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.job.close(); // only command members; runtime is deliberately outside this Job
    await until(() => [...this.captured.values()].every(p => !p.ref.alive()), 10000, 'all captured command handles signalled');
    const response = await protocol;
    if ('error' in response) throw new Error(response.error);
    return { graceMs, residualBeforeJobClose: residual, elapsedMs: performance.now() - start, protocolResponded: true, remaining: 0 };
  }
  dispose() {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.job.close();
    for (const { ref } of this.captured.values()) ref.close(); this.captured.clear();
    for (const ref of this.protected.values()) ref.close(); this.protected.clear();
    if (this.leaseOwned) { ApprovalCommandScope.leases.delete(this.runtimePid); this.leaseOwned = false; }
  }
}

