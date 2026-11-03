// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { NativeFile } from '../04-filesystem/native';
import { ensurePrivateDirectory, writePrivateFile } from '../08-runtime-integration/private-fs';
import { run } from '../../../bridge/src/platform/win32/process';
import { normalizeEnvironment, utf8 } from '../../../bridge/src/platform/win32/shell';

baseline();
test('hash-verified in-memory managed helper can release its on-disk image while executing without elevation',async()=>{
  const root=await mkdtemp(join(artifacts,'memory-cleanup-')),source=join(root,'probe.cs'),exe=join(root,'probe.exe');
  let lease:NativeFile|undefined;
  try {
    ensurePrivateDirectory(root);
    writePrivateFile(source,'public class MemoryProbe { public static void Main() {} public static string Read() { return "memory-ready"; } }');
    const compiler=realpathSync.native(join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'));
    expect((await run([compiler,'/nologo','/target:winexe','/platform:x64','/out:'+exe,source])).code).toBe(0);
    const digest=new Bun.CryptoHasher('sha256').update(await Bun.file(exe).arrayBuffer()).digest('hex');
    lease=new NativeFile(realpathSync.native(root),true);
    const script=utf8+`$ErrorActionPreference='Stop';$bytes=[IO.File]::ReadAllBytes($env:CR_MEMORY_IMAGE);$sha=[Security.Cryptography.SHA256]::Create();try{$actual=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($actual -ne $env:CR_MEMORY_SHA){throw 'Helper hash mismatch'};$assembly=[Reflection.Assembly]::Load($bytes);[IO.File]::Delete($env:CR_MEMORY_IMAGE);$value=$assembly.GetType('MemoryProbe').GetMethod('Read').Invoke($null,@());@{value=$value;deleted=(-not [IO.File]::Exists($env:CR_MEMORY_IMAGE))}|ConvertTo-Json -Compress;`;
    const result=await run([realpathSync.native(join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe')),'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{env:{...normalizeEnvironment(process.env),CR_MEMORY_IMAGE:realpathSync.native(exe),CR_MEMORY_SHA:digest}});
    expect(result.code).toBe(0);expect(JSON.parse(result.stdout)).toEqual({value:'memory-ready',deleted:true});expect(existsSync(exe)).toBe(false);
    console.log(JSON.stringify({memoryLoadedHelper:true,verifiedBeforeLoad:true,imageRemovedWhileCodeRuns:true,userContext:true,productionUninstallImplemented:false}));
  } finally {lease?.close();if(!contains(artifacts,realpathSync.native(root)))throw new Error('Unsafe cleanup');await retry(()=>rm(root,{recursive:true}));}
});
