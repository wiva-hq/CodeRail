// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import source from './command-worker.txt' with { type: 'text' };
import { mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 as p } from 'node:path';
import { launch } from './launcher';
import { ensurePrivateDirectory, writePrivateFile } from './private-fs';
import { contains, error, nativeRealpath, retry } from './paths';
import { ProcessRef } from './job';
import type { RunOptions, RunResult } from '../types';

async function until(check: () => boolean, timeout: number, label: string) {
  const deadline = Date.now() + timeout;
  do { if (check()) return; await Bun.sleep(25); } while (Date.now() < deadline);
  throw error('ETIMEDOUT', label);
}

/** The process environment is passed directly to CreateProcessW in memory.
 * It is never serialized to command config/logs. Every command starts in a Job. */
export async function run(command: string[], options: RunOptions = {}): Promise<RunResult> {
  const state = process.env.CODERAIL_HOME ?? p.join(process.env.LOCALAPPDATA ?? p.join(homedir(), 'AppData/Local'), 'CodeRail');
  const runtime = p.join(state, 'runtime'); ensurePrivateDirectory(runtime);
  const root = await nativeRealpath(runtime), dir = p.join(root, `command-${crypto.randomUUID()}`);
  await mkdir(dir); ensurePrivateDirectory(dir);
  const config = p.join(dir, 'config.json'), output = p.join(dir, 'result.json'), worker = p.join(dir, 'worker.js');
  let child: ReturnType<typeof launch> | undefined, drained = false;
  const drain = async () => {
    if (!child || drained) return;
    const refs: ProcessRef[] = [];
    try {
      for (const pid of child.members()) { const ref = ProcessRef.open(pid); if (ref) refs.push(ref); }
      child.closeJob();
      await until(() => !child!.alive() && refs.every(ref => !ref.alive()), 10000, 'Entire command Job did not drain');
      drained = true;
    } finally { for (const ref of refs) ref.close(); }
  };
  try {
    const cwd = await nativeRealpath(options.cwd ?? homedir());
    writePrivateFile(worker, source);
    writePrivateFile(config, JSON.stringify({ argv: command, input: options.input, cwd, output }));
    child = launch([process.execPath, worker, config], cwd, { ...(options.env ?? process.env as Record<string, string>), BUN_BE_BUN: '1' });
    // Worker writes result before exiting; wait for exit to ensure the JSON file is complete.
    await until(() => !child!.alive(), options.timeout ?? 30000, 'Managed command timed out');
    if (!existsSync(output)) throw error('EIO', 'Command worker exited without result');
    const result = await Bun.file(output).json();
    await drain();
    if (result.error) throw error('EIO', result.error);
    return result;
  } finally {
    try { await drain(); }
    finally {
      child?.dispose();
      if (!contains(root, dir) || !p.basename(dir).startsWith('command-')) throw error('EACCES', 'Unsafe runtime cleanup');
      await retry(() => rm(dir, { recursive: true }));
    }
  }
}
