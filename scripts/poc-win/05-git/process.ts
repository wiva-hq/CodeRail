// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, until } from '../common';
import { spawnNative } from '../02-conpty-terminal/win32';
import { contains, error, nativeRealpath, retry } from '../04-filesystem/paths';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';

/** The suspended worker is Job-bound before it can execute arbitrary commands.
 * Serialize only explicit safe environment patches, never the inherited user environment. */
export async function runWindows(argv: string[], options: { cwd?: string; envPatch?: Record<string, string>; clearEnv?: string[]; input?: string; timeout?: number; maxOutputBytes?: number } = {}) {
  const dir = join(artifacts, `command-${crypto.randomUUID()}`); await mkdir(dir);
  const config = join(dir, 'config.json'), output = join(dir, 'result.json');
  const cwd = await nativeRealpath(options.cwd ?? artifacts);
  await Bun.write(config, JSON.stringify({ ...options, cwd, argv, output }));
  let child: ReturnType<typeof spawnNative> | undefined;
  const drain=async()=>{
    if(!child)return;
    const refs=child.members().map(pid=>ProcessRef.open(pid)).filter((ref):ref is ProcessRef=>ref!==null);
    child.closeJob();
    try{await until(()=>!child!.alive()&&refs.every(ref=>!ref.alive()),10000,'entire command Job drained');}
    finally{for(const ref of refs)ref.close();}
  };
  try {
    child = spawnNative([process.execPath, join(import.meta.dir, 'worker.ts'), config], { cwd, job: true });
    try { await until(() => existsSync(output) || !child!.alive(), options.timeout ?? 30000, 'managed command'); }
    catch (e) { await drain(); throw e; }
    if (!existsSync(output)) throw error('EIO', 'Command worker exited without a result');
    const result = await Bun.file(output).json();
    await drain();
    if (result.error) throw error('EIO', result.error);
    return result as { code: number; stdout: string; stderr: string };
  } finally {
    child?.dispose();
    if (!contains(artifacts, dir)) throw error('EACCES', 'Unsafe command cleanup');
    await retry(()=>rm(dir, { recursive: true }));
  }
}
