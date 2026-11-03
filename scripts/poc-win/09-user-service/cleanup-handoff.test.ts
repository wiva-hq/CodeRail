// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect,test } from 'bun:test';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { existsSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts,baseline,until } from '../common';
import { contains,retry } from '../04-filesystem/paths';
import { run } from '../../../bridge/src/platform/win32/process';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';
import { normalizeEnvironment,utf8 } from '../../../bridge/src/platform/win32/shell';
import { ensurePrivateDirectory,writePrivateFile } from '../08-runtime-integration/private-fs';
import { launch } from '../08-runtime-integration/launcher';
import { deployBinary } from './install-files';
import { handoff } from './handoff';
import { stopActor } from './actor-control';

baseline();
for(const mode of ['remove','unknown','cancel'])test(`self-owned memory cleanup actor: ${mode}`,async()=>{
  const fail=mode==='unknown';
  const base=realpathSync.native(await mkdtemp(join(artifacts,'cleanup-handoff-'))),root=join(base,'CodeRail 中文😀'),source=join(base,'source.exe'),helper=join(base,'candidate.exe'),nonce=crypto.randomUUID().replaceAll('-','');
  let old:ReturnType<typeof launch>|undefined,actor:ReturnType<typeof handoff>|undefined;const refs:ProcessRef[]=[];
  try {
    ensurePrivateDirectory(base);const pe=Buffer.alloc(512);pe.write('MZ');pe.writeUInt32LE(0x80,0x3c);pe.writeUInt32LE(0x4550,0x80);pe.writeUInt16LE(0x8664,0x84);await writeFile(source,pe);
    const installed=await deployBinary(root,source,'0.0.1+1');
    const build=await run([join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),'/nologo','/target:winexe','/platform:x64','/r:System.Web.Extensions.dll','/out:'+helper,join(import.meta.dir,'../../../bridge/src/platform/win32/cleanup.cs')]);if(build.code)throw new Error(build.stdout+build.stderr);
    const image=new Uint8Array(await Bun.file(helper).arrayBuffer());writePrivateFile(join(root,'supervisor.exe'),image);writePrivateFile(join(root,'config.json'),'private config 中文😀');if(fail)writePrivateFile(join(root,'personal.txt'),'must stay');
    old=launch([process.execPath,'-e',"Bun.spawn(['ping.exe','-t','127.0.0.1'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});setInterval(()=>{},1000)"],base);
    await until(()=>old!.members().length>=2);for(const pid of old.members()){const ref=ProcessRef.open(pid);if(ref)refs.push(ref);}
    const host=refs.find(ref=>ref.pid===old!.pid)!,caller=refs.find(ref=>ref.pid!==old!.pid)!;
    const script=utf8+`$ErrorActionPreference='Stop';try{$bytes=[IO.File]::ReadAllBytes($env:CR_IMAGE);$sha=[Security.Cryptography.SHA256]::Create();try{$hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($hash -ne $env:CR_SHA){throw 'Helper hash mismatch'};$asm=[Reflection.Assembly]::Load($bytes);$asm.GetType('OwnedCleanup').GetMethod('Run').Invoke($null,@($env:CR_ROOT,$env:CR_ID,$env:CR_NONCE,[int]$env:CR_HOST,$env:CR_HOST_CREATED,[int]$env:CR_CALLER,$env:CR_CALLER_CREATED))}catch{exit 1}`;
    actor=handoff([join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],base,{...normalizeEnvironment(process.env),CR_IMAGE:join(root,'supervisor.exe'),CR_SHA:new Bun.CryptoHasher('sha256').update(image).digest('hex'),CR_ROOT:root,CR_ID:installed.id,CR_NONCE:nonce,CR_HOST:String(host.pid),CR_HOST_CREATED:String(host.created),CR_CALLER:String(caller.pid),CR_CALLER_CREATED:String(caller.created)});
    const ready=join(root,'cleanup-ready-'+nonce),error=join(root,'cleanup-error-'+nonce+'.txt');
    await until(()=>existsSync(ready)||!actor!.alive(),10000,'Cleanup actor ready');
    if(!existsSync(ready))throw new Error(existsSync(error)?await readFile(error,'utf8'):'Cleanup actor exited before ready');
    const state=JSON.parse(await readFile(ready,'utf8'));expect(state.pid).toBe(actor.pid);expect(BigInt(state.created)).toBe(actor.created);
    actor.releaseOwner();await Bun.sleep(100);expect(actor.alive()).toBe(true);expect(existsSync(root)).toBe(true);
    if(mode==='cancel') {
      await expect(stopActor({...state,created:String(BigInt(state.created)+1n)})).rejects.toMatchObject({code:'EACCES'});expect(actor.alive()).toBe(true);
      await stopActor(state);expect(actor.alive()).toBe(false);expect(old.alive()).toBe(true);expect(await readFile(join(root,'config.json'),'utf8')).toBe('private config 中文😀');return;
    }
    old.closeJob();await until(()=>refs.every(ref=>!ref.alive()));await until(()=>!actor!.alive(),15000,'Cleanup actor completed');
    if(fail){expect(await readFile(join(root,'config.json'),'utf8')).toBe('private config 中文😀');expect(await readFile(error,'utf8')).toContain('Unknown installation entry');expect(await readFile(join(root,'personal.txt'),'utf8')).toBe('must stay');}
    else if(existsSync(root))throw new Error(existsSync(error)?await readFile(error,'utf8'):'Installation root still exists');
    else expect(existsSync(root)).toBe(false);
  } finally {
    await actor?.dispose();if(old){old.closeJob();await until(()=>refs.every(ref=>!ref.alive()));old.dispose();}for(const ref of refs)ref.close();
    if(!contains(artifacts,realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));
  }
},30000);
