// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import type { ServiceSpec } from '../../../bridge/src/platform/types';
import { baseline, until, assertGone } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { runWindows } from '../05-git/process';
import { UserAutorun } from './autorun';
import { UserService } from './service';

baseline();
test('actual user lifecycle candidate: install, idempotence, restart, remove startup and zero remaining processes', async () => {
  const base = realpathSync.native(tmpdir()), root = await mkdtemp(join(base, 'crs-'));
  const startup = new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`), service = new UserService(startup);
  const exe = join(root, 'bridge.exe'), entry = join(root, 'fixture.ts'), pids = join(root, 'fixture-pids.json');
  const spec: ServiceSpec = { command: [exe], home: homedir(), stateDir: root, logPath: join(root, 'bridge.log') };
  let registered: string | undefined;
  try {
    await writeFile(entry, `const child=Bun.spawn(['ping.exe','-t','127.0.0.1'],{stdout:'ignore',windowsHide:true});console.log('当前用户 后台😀');const fs=require('node:fs'),ready=${JSON.stringify(pids)};fs.writeFileSync(ready+'.tmp',JSON.stringify([process.pid,child.pid]),'utf8');fs.renameSync(ready+'.tmp',ready);setInterval(()=>{if(fs.existsSync(process.env.CODERAIL_STOP_FILE))process.exit(0)},50);`);
    const build = await runWindows([process.execPath, 'build', '--compile', '--outfile', exe, entry], { timeout: 90000 }); expect(build.code).toBe(0);
    await service.install(spec, { start: false }); registered = service.command(spec); expect(startup.read()).toBe(registered);
    expect((await service.status(spec)).running).toBe(false); await service.start(spec);
    await until(() => Bun.file(pids).exists()); const first = await service.status(spec); expect(first.running).toBe(true);
    const details = await service.details(spec);
    expect(details.running).toBe(true);
    if (!details.running) throw new Error('Expected a running resource sample');
    expect(details.rootPid).toBe(first.pid!);
    expect(details.processes.some(item => item.pid === first.childPid)).toBe(true);
    expect(details.workingSetBytes).toBeGreaterThan(0);
    const oldPids = JSON.parse(await readFile(pids, 'utf8')); await service.start(spec); expect((await service.status(spec)).pid).toBe(first.pid);
    await service.restart(spec); await assertGone(oldPids); expect((await service.status(spec)).pid).toBe(first.pid);
    expect((await service.status(spec)).childPid).not.toBe(first.childPid);
    await until(async () => JSON.parse(await readFile(pids, 'utf8'))[0] !== oldPids[0]);
    const newPids = JSON.parse(await readFile(pids, 'utf8')); await service.uninstall(spec); registered = undefined;
    expect(startup.read()).toBeNull(); expect((await service.status(spec)).running).toBe(false); await assertGone(newPids);
    expect(await service.details(spec)).toEqual({ running: false });
    console.log(JSON.stringify({ userLifecycle: true, installRestartUninstall: true, startupRemoved: true, remaining: 0 }));
  } finally {
    await service.stop(spec); if (registered) startup.uninstall(registered);
    if (!contains(base, realpathSync.native(root)) || !root.includes('crs-')) throw new Error('Unsafe temp cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
}, 120000);
