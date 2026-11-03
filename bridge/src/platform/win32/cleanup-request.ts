// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { win32 as p } from 'node:path';
import { NativeFile } from './native';
import { error } from './paths';
import { ProcessRef } from './job';
import { writePrivateFile } from './private-fs';
import { guardInstallationRoot, readInstallation } from './install-files';
import type { ActorIdentity } from './actor-control';

/** Hand off before the caller exits. The independent actor waits for this exact
 * caller identity; returning an acknowledgement does not claim files are gone. */
export async function requestCleanup(input: string): Promise<ActorIdentity> {
  const root = await guardInstallationRoot(input), installed = readInstallation(root);
  if (!installed) throw error('EACCES', 'No owned installation to remove');
  const directory = new NativeFile(root, true);
  const read = (name: string) => {
    const file = directory.child(name, false);
    try { return file.read(root, 16384).toString('utf8'); } finally { file.close(); }
  };
  let host: ProcessRef | null = null, caller: ProcessRef | null = null;
  try {
    const [pid, child, nonce, created] = read('supervisor.txt').trim().split('\n');
    if (!/^\d+$/.test(pid) || !/^\d+$/.test(child) || !/^[a-f0-9]{32}$/.test(nonce) || !/^\d+$/.test(created)) throw error('EINVAL', 'Invalid supervisor identity');
    host = ProcessRef.open(Number(pid));
    if (!host || !host.alive() || String(host.created) !== created) throw error('ESRCH', 'No live owned supervisor for cleanup handoff');
    caller = ProcessRef.open(process.pid);
    if (!caller) throw error('ESRCH', 'Cannot pin cleanup caller');
    const requestNonce = crypto.randomUUID().replaceAll('-', '');
    writePrivateFile(p.join(root, 'cleanup-' + nonce), JSON.stringify({schema: 1, installationId: installed.id, nonce: requestNonce, callerPid: process.pid, callerCreated: String(caller.created)}));
    const deadline = performance.now() + 15000;
    while (performance.now() < deadline) {
      try { throw error('EIO', read('cleanup-error-' + requestNonce + '.txt')); }
      catch (cause: any) { if (cause.code !== 'ENOENT') throw cause; }
      try {
        const actor = JSON.parse(read('cleanup-ready-' + requestNonce)) as ActorIdentity;
        if (actor.nonce !== requestNonce || !Number.isInteger(actor.pid) || actor.pid <= 0 || !/^\d+$/.test(actor.created) || !/^\d+$/.test(actor.jobHandle) || !Number.isSafeInteger(Number(actor.jobHandle)) || Number(actor.jobHandle) <= 0) throw error('EINVAL', 'Invalid cleanup acknowledgement');
        const ref = ProcessRef.open(actor.pid);
        try { if (!ref || !ref.alive() || String(ref.created) !== actor.created) throw error('ESRCH', 'Cleanup actor exited before acknowledgement'); }
        finally { ref?.close(); }
        return actor;
      } catch (cause: any) { if (cause.code !== 'ENOENT') throw cause; }
      await Bun.sleep(25);
    }
    throw error('ETIMEDOUT', 'Cleanup handoff was not acknowledged; inspect retained installation logs');
  } finally { host?.close(); caller?.close(); directory.close(); }
}
