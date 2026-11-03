// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { rename } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { ServiceSpec } from '../types';
import sourceText from './supervisor.cs' with { type: 'text' };
import cleanupText from './cleanup.cs' with { type: 'text' };
import updateText from './update.cs' with { type: 'text' };
import ownedLogText from './owned-log.cs' with { type: 'text' };
import startupText from './startup.cs' with { type: 'text' };
import { readInstallation } from './install-files';
import { captureTree, ProcessRef, snapshot } from './job';
import { NativeFile } from './native';
import { ensurePrivateDirectory, writePrivateFile } from './private-fs';
import { quoteArgument } from './launcher';
import { run } from './process';
import { retry } from './paths';
import { UserAutorun } from './autorun';
import { normalizeEnvironment } from './shell';
declare global { var __CODERAIL_SUPERVISOR__: string | undefined; }

async function until(check: () => boolean | Promise<boolean>, timeout: number, label: string) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
  throw new Error(`Timeout waiting for ${label}`);
}

/** Current-user lifecycle. Each command child is kernel-bound to its supervisor Job. */
export class UserService {
  constructor(private autorun = new UserAutorun()) {}
  async prepare(spec: ServiceSpec) {
    ensurePrivateDirectory(spec.stateDir);
    const root = realpathSync.native(spec.stateDir), source = join(root, 'supervisor.cs'), exe = join(root, 'supervisor.exe');
    if (globalThis.__CODERAIL_SUPERVISOR__) {
      const bytes = new Uint8Array(await Bun.file(globalThis.__CODERAIL_SUPERVISOR__).arrayBuffer());
      writePrivateFile(exe, bytes); return exe;
    }
    writePrivateFile(source, sourceText);
    const cleanup = join(root, 'cleanup.cs'); writePrivateFile(cleanup, cleanupText);
    const update = join(root, 'update.cs'); writePrivateFile(update, updateText);
    const ownedLog = join(root, 'owned-log.cs'); writePrivateFile(ownedLog, ownedLogText);
    const startup = join(root, 'startup.cs'); writePrivateFile(startup, startupText);
    const compiler = join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    if (!existsSync(compiler)) throw new Error('Native user supervisor compiler unavailable; install the packaged supervisor artifact');
    const temp = join(root, `supervisor-${crypto.randomUUID()}.exe`);
    const build = await run([compiler, '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/r:System.Web.Extensions.dll', '/main:Supervisor', '/out:' + temp, source, cleanup, update, ownedLog, startup], { timeout: 60000 });
    if (build.code) throw new Error('Supervisor compilation failed: ' + build.stdout + build.stderr);
    await retry(() => rename(temp, exe)); return exe;
  }
  private readIdentity(spec: ServiceSpec) {
    if (!existsSync(spec.stateDir)) return null;
    const root = realpathSync.native(spec.stateDir), lease = new NativeFile(root, true);
    try {
      let file: NativeFile;
      try { file = lease.child('supervisor.txt', false); } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
      let text: string; try { text = file.read(root, 2048).toString('utf8'); } finally { file.close(); }
      const [pid, child, nonce, created] = text.trim().split('\n');
      if (!/^\d+$/.test(pid) || !/^\d+$/.test(child) || !/^[a-f0-9]{32}$/.test(nonce) || !/^\d+$/.test(created)) throw new Error('Invalid supervisor identity');
      const ref = ProcessRef.open(Number(pid));
      if (!ref) return null;
      if (!ref.alive() || ref.created !== BigInt(created)) { ref.close(); return null; }
      return { root, pid: Number(pid), childPid: Number(child), nonce, ref };
    } finally { lease.close(); }
  }
  private identity(spec: ServiceSpec) { return retry(async () => this.readIdentity(spec)); }
  async status(spec: ServiceSpec) {
    const identity = await this.identity(spec);
    try { return identity ? { running: true, pid: identity.pid, childPid: identity.childPid } : { running: false }; }
    finally { identity?.ref.close(); }
  }
  async details(spec: ServiceSpec) {
    const identity = await this.identity(spec);
    if (!identity) return { running: false as const };
    try {
      const { resources } = await import('./resources');
      const sample = await resources(identity.ref);
      return sample ? { running: true as const, ...sample } : { running: false as const };
    } finally { identity.ref.close(); }
  }
  command(spec: ServiceSpec) {
    const root = realpathSync.native(spec.stateDir), exe = realpathSync.native(join(root, 'supervisor.exe'));
    const installed = readInstallation(root);
    if (installed && spec.command.length === 2 && spec.command[0] === installed.executable && spec.command[1] === 'run') return [exe, '--installed'].map(quoteArgument).join(' ');
    return [exe, root, realpathSync.native(spec.command[0]), ...spec.command.slice(1)].map(quoteArgument).join(' ');
  }
  async start(spec: ServiceSpec) {
    if ((await this.status(spec)).running) return;
    const exe = realpathSync.native(join(spec.stateDir, 'supervisor.exe'));
    // This is the intentionally persistent supervisor root. It owns all command
    // children in its own Job before they run; the installing CLI may exit.
    // Existing pre-release helpers retain their legacy startup arguments. Only
    // an installation registered with the new short command selects this mode.
    const installedCommand = [exe, '--installed'].map(quoteArgument).join(' ');
    const argv = this.autorun.read() === installedCommand ? [exe, '--installed'] : [exe, realpathSync.native(spec.stateDir), ...spec.command];
    const root = Bun.spawn(argv, { env: normalizeEnvironment(process.env), stdin: 'ignore', stdout: 'ignore', stderr: 'ignore', windowsHide: true, detached: true }); root.unref();
    let code: number | undefined;
    void root.exited.then(value => { code = value; });
    try {
      await until(async () => {
        if ((await this.status(spec)).running) return true;
        if (code !== undefined) throw new Error(`User supervisor failed during startup (exit ${code}); inspect supervisor-error.txt`);
        return false;
      }, 10000, 'User supervisor startup');
    } catch (error) {
      // This is our exact child handle, never a PID discovered from stale state.
      // Supervisor owns its Job; ending this root closes that Job in the kernel.
      if (code === undefined) root.kill();
      await root.exited; throw error;
    }
  }
  async stop(spec: ServiceSpec) {
    const identity = await this.identity(spec); if (!identity) return;
    const refs: ProcessRef[] = [identity.ref];
    try {
      refs.push(...captureTree(identity.ref, snapshot()));
      writePrivateFile(join(identity.root, 'stop-' + identity.nonce), 'requested');
      const nonces=new Set([identity.nonce]),captured=new Set(refs.map(ref=>`${ref.pid}@${ref.created}`));
      try { await until(() => {
        if(identity.ref.alive()) {
          const current=this.readIdentity(spec);
          if(current)try {
            if(current.pid!==identity.pid||current.ref.created!==identity.ref.created)throw new Error('Service root changed while stopping; retry against the current instance');
            if(!nonces.has(current.nonce)) {
              for(const child of captureTree(identity.ref,snapshot())){const key=`${child.pid}@${child.created}`;if(captured.has(key))child.close();else{captured.add(key);refs.push(child);}}
              writePrivateFile(join(current.root,'stop-'+current.nonce),'requested');nonces.add(current.nonce);
            }
          } finally {current.ref.close();}
        }
        return refs.every(ref=>!ref.alive());
      }, 10000, 'Entire user service tree drained'); }
      catch (cause) { throw new Error(`Service stop failed; remaining handles: ${refs.filter(ref => ref.alive()).map(ref => `${ref.pid}@${ref.created}`).join(', ')}`, { cause }); }
    } finally { for (const ref of refs) ref.close(); }
  }
  async install(spec: ServiceSpec, options: { start?: boolean } = {}) {
    await this.stop(spec); await this.prepare(spec);
    const command = this.command(spec); this.autorun.install(command);
    if (options.start !== false) try { await this.start(spec); } catch (error) { this.autorun.uninstall(command); throw error; }
  }
  async restart(spec: ServiceSpec) {
    const identity = await this.identity(spec);
    if (!identity) { await this.start(spec); return; }
    try {
      writePrivateFile(join(identity.root, 'restart-' + identity.nonce), 'requested');
      await until(async () => {
        if (!identity.ref.alive()) throw new Error('Supervisor stopped during restart');
        const next = await this.status(spec);
        return next.running && next.childPid !== identity.childPid;
      }, 15000, 'Supervisor-owned Bridge restart');
    } finally { identity.ref.close(); }
  }
  async uninstall(spec: ServiceSpec) {
    if (this.autorun.read() !== null) this.autorun.uninstall(this.command(spec));
    await this.stop(spec);
  }
}
