// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { link, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { baseline, assertGone, until } from '../common';
import { runWindows } from '../05-git/process';
import { UserService } from './service';
import { UserAutorun } from './autorun';
import { ensurePrivateDirectory, writePrivateFile } from '../08-runtime-integration/private-fs';
import { launch } from '../08-runtime-integration/launcher';
import { contains, retry } from '../04-filesystem/paths';

baseline();
test('supervisor-owned restart keeps parent alive and clears old child Job before replacement', async () => {
  const base = realpathSync.native(tmpdir()), root = await mkdtemp(join(base, 'crr-'));
  const candidate = join(root, 'candidate.exe'), bridge = join(root, 'bridge.exe'), entry = join(root, 'fixture.ts'), ready = join(root, 'ready.json');
  const service = new UserService(new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`));
  const spec = { command: [bridge], stateDir: root, home: homedir(), logPath: join(root, 'bridge.log') };
  const previousAsset = globalThis.__CODERAIL_SUPERVISOR__, previousHome = process.env.CODERAIL_HOME;
  process.env.CODERAIL_HOME = root;
  try {
    const compiler = join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    expect((await runWindows([compiler, '/nologo', '/target:winexe', '/platform:x64', '/r:System.Web.Extensions.dll', '/main:Supervisor', '/out:' + candidate, join(import.meta.dir, '../../../bridge/src/platform/win32/supervisor.cs'), join(import.meta.dir, '../../../bridge/src/platform/win32/cleanup.cs'), join(import.meta.dir, '../../../bridge/src/platform/win32/update.cs'),join(import.meta.dir, '../../../bridge/src/platform/win32/owned-log.cs'),join(import.meta.dir, '../../../bridge/src/platform/win32/startup.cs')])).code).toBe(0);
    globalThis.__CODERAIL_SUPERVISOR__ = candidate;
    await writeFile(entry, `const child=Bun.spawn(['ping.exe','-t','127.0.0.1'],{stdout:'ignore'});const fs=require('node:fs'),ready=${JSON.stringify(ready)};fs.writeFileSync(ready+'.tmp',JSON.stringify([process.pid,child.pid]),'utf8');fs.renameSync(ready+'.tmp',ready);setInterval(()=>{if(fs.existsSync(process.env.CODERAIL_STOP_FILE))process.exit(0)},50);`);
    expect((await runWindows([process.execPath, 'build', '--compile', '--outfile', bridge, entry], { timeout: 90000 })).code).toBe(0);
    await service.prepare(spec); await service.start(spec);
    await until(() => Bun.file(ready).exists()); const before = await service.status(spec), old = JSON.parse(await readFile(ready, 'utf8'));
    const nonce = (await readFile(join(root, 'supervisor.txt'), 'utf8')).trim().split('\n')[2];
    writePrivateFile(join(root, 'restart-' + nonce), 'requested');
    await until(async () => (await service.status(spec)).childPid !== before.childPid, 10000, 'new child started');
    await assertGone(old); const after = await service.status(spec); expect(after.pid).toBe(before.pid); expect(after.childPid).not.toBe(before.childPid);
    await service.stop(spec);
    const outside = join(root, 'outside'), unsafe = join(root, 'unsafe'); ensurePrivateDirectory(outside); ensurePrivateDirectory(unsafe);
    const sentinel = join(outside, 'sentinel.txt'); await writeFile(sentinel, 'outside must remain');
    await link(sentinel, join(unsafe, 'bridge.log'));
    const hardlink = launch([candidate, unsafe, bridge], root);
    try { await until(() => !hardlink.alive()); expect(await readFile(sentinel, 'utf8')).toBe('outside must remain'); }
    finally { hardlink.dispose(); }
    const junction = join(root, 'state-junction'); await symlink(outside, junction, 'junction');
    const escaped = launch([candidate, junction, bridge], root);
    try { await until(() => !escaped.alive()); expect(await readdir(outside)).toEqual(['sentinel.txt']); }
    finally { escaped.dispose(); }
    console.log(JSON.stringify({ supervisorPidStable: true, oldJobGone: true, prebuiltHelperExtraction: true }));
  } finally {
    await service.stop(spec); globalThis.__CODERAIL_SUPERVISOR__ = previousAsset;
    if (previousHome === undefined) delete process.env.CODERAIL_HOME; else process.env.CODERAIL_HOME = previousHome;
    if (!contains(base, realpathSync.native(root))) throw new Error('Unsafe cleanup'); await retry(() => rm(root, { recursive: true }));
  }
}, 120000);
