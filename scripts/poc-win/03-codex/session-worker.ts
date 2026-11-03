// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { assert, until } from '../common';
import { ProcessJob, ProcessRef } from './process-jobs';
import { Rpc } from './rpc';

/** One independently owned runtime per logical session. Bind before initialize:
 * no client approval or model work can run before Job ownership is established. */
export class SessionWorker {
  private job!: ProcessJob;
  private root!: ProcessRef;
  rpc!: Rpc;
  private baseline = new Set<number>();
  private approved = false;
  constructor(readonly cwd: string, readonly protocol: 'app-server' | 'acp') {}
  async start() {
    this.job = new ProcessJob();
    const codex = process.env.POC_CODEX_PATH!;
    const require = createRequire(join(import.meta.dir, '../../../bridge/package.json'));
    const argv = this.protocol === 'app-server' ? [codex, 'app-server', '--stdio'] : [process.execPath, require.resolve('@agentclientprotocol/codex-acp')];
    const env = { ...process.env, BUN_BE_BUN: '1', CODEX_PATH: codex, NO_BROWSER: '1', INITIAL_AGENT_MODE: 'read-only' };
    if (process.env.POC_MANAGED_STREAM === '1') {
      const { spawnStream } = await import('../08-runtime-integration/stream');
      const stream = await spawnStream(argv, { cwd: this.cwd, env: env as Record<string, string>, keepBun: true });
      this.rpc = new Rpc(argv, this.cwd, env, { pid: stream.pid, stdin: { write: text => stream.write(text), flush() {} }, stdout: stream.stdout, stderr: stream.stderr, exited: stream.exited });
    } else this.rpc = new Rpc(argv, this.cwd, env);
    const root = ProcessRef.open(this.rpc.proc.pid); assert(root); this.root = root;
    try {
      this.job.assign(root);
      if (this.protocol === 'app-server') {
        await this.rpc.call('initialize', { clientInfo: { name: 'coderail_isolated_poc', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }); this.rpc.notify('initialized');
      } else await this.rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'coderail_isolated_poc', version: '0.1.0' } });
    } catch (error) { await this.stop(); throw error; }
  }
  armApproval() {
    if (this.approved) return; // All approvals in the active turn share this session lease.
    this.baseline = new Set(this.job.members()); this.approved = true;
  }
  get commandPids() { assert(this.approved); return this.job.members().filter(pid => !this.baseline.has(pid)); }
  get allPids() { return this.job.members(); }
  async cancelAndRecover(id: { threadId?: string; turnId?: string; sessionId?: string }, graceMs = 500) {
    assert(this.approved, 'Cancellation requires the active command lease');
    const oldPid = this.rpc.proc.pid;
    const protocol = this.protocol === 'app-server'
      ? this.rpc.call('turn/interrupt', { threadId: id.threadId, turnId: id.turnId }).then(() => true, () => false)
      : Promise.resolve().then(() => { this.rpc.notify('session/cancel', { sessionId: id.sessionId }); return true; });
    await Bun.sleep(graceMs);
    const remaining = this.commandPids;
    if (remaining.length === 0) {
      this.approved = false;
      return { graceMs, oldPid, newPid: oldPid, restarted: false, remainingBeforeClose: remaining, entireJobPids: [] as number[], cleanupMs: 0, protocolSent: true, protocolAcknowledged: await protocol, restored: true, remaining: 0 };
    }
    const captured = this.allPids.map(pid => ProcessRef.open(pid)).filter((p): p is ProcessRef => p !== null);
    const beforeClose = captured.map(p => p.pid);
    const closeAt = performance.now();
    this.job.close();
    try {
      await until(() => captured.every(p => !p.alive()), 10000, 'entire isolated session Job gone');
      await this.rpc.proc.exited;
    } finally { for (const p of captured) p.close(); this.root.close(); }
    const cleanupMs = performance.now() - closeAt;
    this.approved = false;
    await this.start();
    const restored = this.protocol === 'app-server'
      ? await this.rpc.call('thread/resume', { threadId: id.threadId, cwd: this.cwd, sandbox: 'workspace-write', approvalPolicy: 'untrusted' })
      : await this.rpc.call('session/load', { sessionId: id.sessionId, cwd: this.cwd, mcpServers: [] }, 60000);
    return { graceMs, oldPid, newPid: this.rpc.proc.pid, restarted: true, remainingBeforeClose: remaining, entireJobPids: beforeClose, cleanupMs, protocolSent: true, protocolAcknowledged: await protocol, restored: !!restored, remaining: 0 };
  }
  async stop() {
    if (!this.rpc) return;
    this.job.close(); await this.rpc.proc.exited; this.root.close();
  }
}
