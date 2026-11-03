// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { link, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../../../bridge/src/platform/win32/process';
import { contains } from '../../../bridge/src/platform/win32/paths';
import { artifacts, baseline } from '../common';
baseline();

test('native single writer rotates bounded UTF-8 logs and rejects linked files before writes', async () => {
  const base=realpathSync.native(artifacts),root=await mkdtemp(join(base,'rotate-中文😀-'));
  const exe=join(root,'probe.exe'),dir=join(root,'owned');await mkdir(dir);
  const compiler=join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const input=Array.from({length:2500},(_,i)=>`${i}:中文日志😀 ANSI\x1b[32m green\x1b[0m\n`).join('');
  try {
    const build=await run([compiler,'/nologo','/target:exe','/platform:x64','/out:'+exe,join(import.meta.dir,'../../../bridge/src/platform/win32/owned-log.cs'),join(import.meta.dir,'log-probe.cs')],{timeout:60000});expect(build.code).toBe(0);
    const result=await run([exe,dir,'1024'],{input,timeout:30000});expect(result.code).toBe(0);
    const current=await readFile(join(dir,'bridge.log')),backup=await readFile(join(dir,'bridge.log.1'));
    expect(current.length).toBeLessThanOrEqual(1024);expect(backup.length).toBeLessThanOrEqual(1024);
    const retained=Buffer.concat([backup,current]);new TextDecoder('utf-8',{fatal:true}).decode(retained);
    expect(Buffer.from(input,'utf8').subarray(-retained.length).equals(retained)).toBe(true);
    expect(current.toString('utf8')).toContain('2499:中文日志😀');
    // Restart appends safely and continues rotating an existing log.
    const next=await run([exe,dir,'1024'],{input:'恢复后😀\n'.repeat(150),timeout:30000});expect(next.code).toBe(0);
    expect((await stat(join(dir,'bridge.log'))).size).toBeLessThanOrEqual(1024);
    await writeFile(join(dir,'bridge.log'),'历史中文😀\n'.repeat(1000));await writeFile(join(dir,'bridge.log.1'),'旧备份😀\n'.repeat(1000));
    const legacy=await run([exe,dir,'1024'],{input:'',timeout:30000});expect(legacy.code).toBe(0);
    for(const name of ['bridge.log','bridge.log.1']){const bytes=await readFile(join(dir,name));expect(bytes.length).toBeLessThanOrEqual(1024);new TextDecoder('utf8',{fatal:true}).decode(bytes);}
    const outside=join(root,'private.txt');await writeFile(outside,'outside untouched');
    await rm(join(dir,'bridge.log'));await link(outside,join(dir,'bridge.log'));
    const rejected=await run([exe,dir,'1024'],{input:'must not write',timeout:30000});expect(rejected.code).not.toBe(0);
    expect(await readFile(outside,'utf8')).toBe('outside untouched');
    await rm(join(dir,'bridge.log'));await writeFile(join(dir,'bridge.log'),'a'.repeat(1024));
    await rm(join(dir,'bridge.log.1'));await link(outside,join(dir,'bridge.log.1'));
    const backupRejected=await run([exe,dir,'1024'],{input:'rotate',timeout:30000});expect(backupRejected.code).not.toBe(0);
    expect(await readFile(outside,'utf8')).toBe('outside untouched');
    console.log(JSON.stringify({nativeRotation:true,utf8SplitInput:true,boundedTwoFiles:true,restartAppend:true,currentAndBackupHardlinksRejected:true}));
  } finally {
    if(!contains(base,realpathSync.native(root)))throw new Error('Unsafe rotation cleanup');await rm(root,{recursive:true});
  }
},60000);
