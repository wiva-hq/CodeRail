// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assertGone, baseline, until } from '../common';
import { ensurePrivateDirectory, writePrivateFile } from '../08-runtime-integration/private-fs';
import { launch } from '../08-runtime-integration/launcher';
import { runWindows } from '../05-git/process';
import { contains, retry } from '../04-filesystem/paths';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';

baseline();
test('user-context WinExe supervisor: hidden image, inherited UTF-8 log, graceful stop and kernel cleanup after abnormal supervisor exit', async () => {
  const root = await mkdtemp(join(artifacts, 'user-supervisor-')), exe = join(root, 'supervisor.exe');
  const compiler = join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  try {
    expect(existsSync(compiler)).toBe(true);
    const build = await runWindows([compiler, '/nologo', '/define:CODERAIL_POC', '/target:winexe', '/platform:x64', '/optimize+', '/r:System.Web.Extensions.dll', '/main:Supervisor', '/out:' + exe, join(import.meta.dir, '../../../bridge/src/platform/win32/supervisor.cs'), join(import.meta.dir, '../../../bridge/src/platform/win32/cleanup.cs'), join(import.meta.dir, '../../../bridge/src/platform/win32/update.cs'),join(import.meta.dir, '../../../bridge/src/platform/win32/owned-log.cs'),join(import.meta.dir, '../../../bridge/src/platform/win32/startup.cs')], { timeout: 60000 });
    expect(build.code).toBe(0);
    const pe = await readFile(exe), optionalHeader = pe.readUInt32LE(0x3c) + 24;
    expect(pe.readUInt16LE(optionalHeader + 68)).toBe(2); // IMAGE_SUBSYSTEM_WINDOWS_GUI
    for (const mode of ['stop', 'crash']) {
      const state = join(root, mode + ' 中文'); ensurePrivateDirectory(state);
      const fixture = join(root, mode + '.ts'), ready = join(state, 'ready.json');
      await writeFile(fixture, `const child=Bun.spawn(['ping.exe','-t','127.0.0.1'],{stdout:'ignore',windowsHide:true});console.log('后台 中文😀');const fs=require('node:fs'),ready=${JSON.stringify(ready)};fs.writeFileSync(ready+'.tmp',JSON.stringify([process.pid,child.pid]),'utf8');fs.renameSync(ready+'.tmp',ready);setInterval(()=>{if(fs.existsSync(process.env.CODERAIL_STOP_FILE))process.exit(0)},50);`);
      const supervisor = launch([exe, state, process.execPath, fixture], root);
      try {
        await until(() => existsSync(ready) && existsSync(join(state, 'supervisor.txt')), 15000, 'hidden supervisor ready');
        const [ownerPid, childPid, nonce, created] = (await readFile(join(state, 'supervisor.txt'), 'utf8')).trim().split('\n');
        const identity = ProcessRef.open(Number(ownerPid));
        try { expect(identity?.created).toBe(BigInt(created)); } finally { identity?.close(); }
        const pids = JSON.parse(await readFile(ready, 'utf8')) as number[];
        expect(pids[0]).toBe(Number(childPid));
        expect(await readFile(join(state, 'bridge.log'), 'utf8')).toContain('后台 中文😀');
        writePrivateFile(join(state, `${mode}-${nonce}`), 'requested');
        await until(() => !supervisor.alive(), 5000, 'supervisor stopped');
        // The outer harness Job remains OPEN: only the supervisor's own Job can
        // account for its descendants disappearing here. No PID cleanup input.
        await assertGone(pids);
        if (mode === 'stop') expect(existsSync(join(state, `bridge-stop-${nonce}`))).toBe(true);
      } finally { supervisor.dispose(); }
    }
    console.log(JSON.stringify({ winExeBytes: pe.length, subsystem: 'GUI', userContext: true, utf8Log: true, gracefulStop: true, abnormalExitJobCleanup: true }));
  } finally {
    if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup'); await retry(() => rm(root, { recursive: true }));
  }
}, 90000);
