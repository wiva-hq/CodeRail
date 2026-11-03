// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, baseline, until, assertGone } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { launch } from './launcher';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';

baseline();
test('suspended launcher quotes Unicode/empty/trailing-slash arguments, Job captures all descendants', async () => {
  const root = await mkdtemp(join(artifacts, 'launcher-')), script = join(root, 'worker 空格.ts'), output = join(root, 'args.json');
  const args = ['', '中文 😀', 'with"quote', 'C:\\trailing\\', 'space \\"quote'];
  let child: ReturnType<typeof launch> | undefined;
  const refs: ProcessRef[] = [];
  try {
    await writeFile(script, 'await Bun.write(process.argv[2],JSON.stringify(process.argv.slice(3)));Bun.spawn([process.execPath,"-e",\'Bun.spawn(["ping.exe","-t","127.0.0.1"],{stdout:"ignore"});setInterval(()=>{},1000)\'],{stdout:"ignore"});setInterval(()=>{},1000);');
    child = launch([process.execPath, script, output, ...args], root);
    await until(async () => (await Bun.file(output).exists()) && child!.members().length >= 3);
    expect(await Bun.file(output).json()).toEqual(args);
    const pids = child.members(); expect(pids).toContain(child.pid); expect(pids.length).toBeGreaterThanOrEqual(3);
    for (const pid of pids) { const ref = ProcessRef.open(pid); if (ref) refs.push(ref); }
    child.closeJob(); await until(() => refs.every(ref => !ref.alive())); await assertGone(pids);
    expect(child.alive()).toBe(false);
    console.log(JSON.stringify({ kernelAssignedBeforeResume: true, memberCount: pids.length, gone: true }));
  } finally {
    child?.dispose(); for (const ref of refs) ref.close();
    if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
}, 30000);
