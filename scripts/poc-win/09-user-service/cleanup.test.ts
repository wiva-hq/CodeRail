// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect,test } from 'bun:test';
import { link,mkdir,mkdtemp,readFile,rm,symlink,writeFile } from 'node:fs/promises';
import { existsSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts,baseline } from '../common';
import { contains,retry } from '../04-filesystem/paths';
import { run } from '../../../bridge/src/platform/win32/process';
import { normalizeEnvironment,utf8 } from '../../../bridge/src/platform/win32/shell';
import { ensurePrivateDirectory,writePrivateFile } from '../08-runtime-integration/private-fs';
import { deployBinary } from './install-files';
import { NativeFile } from '../04-filesystem/native';

baseline();
async function fixture() {
  const base=realpathSync.native(await mkdtemp(join(artifacts,'owned-cleanup-'))),root=join(base,'应用 中文😀'),source=join(base,'source.exe'),helper=join(base,'candidate.exe');
  ensurePrivateDirectory(base);
  try {
    const bytes=Buffer.alloc(512);bytes.write('MZ');bytes.writeUInt32LE(0x80,0x3c);bytes.writeUInt32LE(0x4550,0x80);bytes.writeUInt16LE(0x8664,0x84);await writeFile(source,bytes);
    const install=await deployBinary(root,source,'0.0.1+1');
    const compile=await run([join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),'/nologo','/target:winexe','/platform:x64','/r:System.Web.Extensions.dll','/out:'+helper,join(import.meta.dir,'../../../bridge/src/platform/win32/cleanup.cs')]);
    if(compile.code)throw new Error(compile.stdout+compile.stderr);
    writePrivateFile(join(root,'supervisor.exe'),new Uint8Array(await Bun.file(helper).arrayBuffer()));writePrivateFile(join(root,'config.json'),'用户状态😀');
    const invoke=async(id=install.id)=>{
      const script=utf8+`$ErrorActionPreference='Stop';try{$bytes=[IO.File]::ReadAllBytes($env:CR_CLEANUP_IMAGE);$sha=[Security.Cryptography.SHA256]::Create();try{$actual=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($actual -ne $env:CR_CLEANUP_SHA){throw 'Helper hash mismatch'};$asm=[Reflection.Assembly]::Load($bytes);$asm.GetType('OwnedCleanup').GetMethod('Remove').Invoke($null,@($env:CR_CLEANUP_ROOT,$env:CR_CLEANUP_ID));Write-Output 'removed'}catch{$e=$_.Exception;while($e.InnerException){$e=$e.InnerException};[Console]::Error.WriteLine($e.Message);exit 1}`;
      return run([join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:base,env:{...normalizeEnvironment(process.env),CR_CLEANUP_IMAGE:join(root,'supervisor.exe'),CR_CLEANUP_SHA:new Bun.CryptoHasher('sha256').update(await Bun.file(helper).arrayBuffer()).digest('hex'),CR_CLEANUP_ROOT:root,CR_CLEANUP_ID:id}});
    };
    return {base,root,install,invoke,async close(){if(!contains(artifacts,realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));}};
  } catch(cause){if(!contains(artifacts,base))throw new Error('Unsafe fixture cleanup');await retry(()=>rm(base,{recursive:true}));throw cause;}
}

test('memory-loaded cleanup removes its owned image and full tree using native handles, including long Unicode paths',async()=>{
  const f=await fixture();try {
    const long=join(f.root,'runtime',...Array.from({length:5},(_,i)=>`${i}-中文😀-${'x'.repeat(70)}`));ensurePrivateDirectory(long);writePrivateFile(join(long,'worker.js'),'运行😀');
    const result=await f.invoke();expect(result.code).toBe(0);expect(result.stdout.trim()).toBe('removed');expect(existsSync(f.root)).toBe(false);
  } finally {await f.close();}
},30000);

test('cleanup preflight refuses unknown top-level files and wrong installation identity without deleting any owned state',async()=>{
  const f=await fixture();try {
    let result=await f.invoke('0'.repeat(32));expect(result.code).toBe(1);expect(result.stderr).toContain('ownership');expect(await readFile(join(f.root,'config.json'),'utf8')).toBe('用户状态😀');
    await writeFile(join(f.root,'personal.txt'),'keep');result=await f.invoke();expect(result.code).toBe(1);expect(result.stderr).toContain('Unknown');expect(await readFile(join(f.root,'config.json'),'utf8')).toBe('用户状态😀');expect(await readFile(join(f.root,'personal.txt'),'utf8')).toBe('keep');
  } finally {await f.close();}
},30000);

test('cleanup refuses external Junctions, hardlinks and active file locks before changing installation bytes',async()=>{
  const f=await fixture();try {
    const outside=join(f.base,'outside');await mkdir(outside);await writeFile(join(outside,'sentinel.txt'),'outside stays');
    await symlink(outside,join(f.root,'runtime'),'junction');let result=await f.invoke();expect(result.code).toBe(1);expect(result.stderr).toContain('Reparse');await rm(join(f.root,'runtime'));
    await mkdir(join(f.root,'runtime'));await link(join(outside,'sentinel.txt'),join(f.root,'runtime','linked.txt'));result=await f.invoke();expect(result.code).toBe(1);expect(result.stderr).toContain('Hard-linked');await rm(join(f.root,'runtime','linked.txt'));
    const lease=new NativeFile(f.root,true),locked=lease.child('config.json',false);
    try {result=await f.invoke();expect(result.code).toBe(1);expect(result.stderr).toContain('Open owned child');}finally{locked.close();lease.close();}
    expect(await readFile(join(f.root,'config.json'),'utf8')).toBe('用户状态😀');expect(await readFile(join(outside,'sentinel.txt'),'utf8')).toBe('outside stays');
  } finally {await f.close();}
},30000);
