// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect,test } from 'bun:test';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { existsSync,realpathSync } from 'node:fs';
import { homedir,tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseline,until } from '../common';
import { contains,retry } from '../04-filesystem/paths';
import { run } from '../../../bridge/src/platform/win32/process';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';
import { ensurePrivateDirectory,writePrivateFile } from '../08-runtime-integration/private-fs';
import { deployBinary } from './install-files';
import { UserService } from './service';
import { UserAutorun } from './autorun';
import { stopActor,type ActorIdentity } from './actor-control';

baseline();
test('actual supervisor launches a separate self-owned cleanup Job before draining Bridge/CLI and deleting its mapped helper',async()=>{
  const base=realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()),'crcleanup-'))),root=join(base,'CodeRail 中文😀'),source=join(base,'source.exe'),entry=join(base,'bridge.ts'),cli=join(base,'cli.ts'),trigger=join(base,'trigger'),sent=join(base,'sent.json'),pids=join(base,'pids.json');
  const service=new UserService(new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`)),spec={command:[process.execPath,entry],home:homedir(),stateDir:root,logPath:join(root,'bridge.log')};
  const refs:ProcessRef[]=[];let actor:ActorIdentity|undefined;
  try {
    ensurePrivateDirectory(base);const pe=Buffer.alloc(512);pe.write('MZ');pe.writeUInt32LE(0x80,0x3c);pe.writeUInt32LE(0x4550,0x80);pe.writeUInt16LE(0x8664,0x84);await writeFile(source,pe);const installed=await deployBinary(root,source,'0.0.1+1');
    const result=await run([join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),'/nologo','/target:winexe','/platform:x64','/r:System.Web.Extensions.dll','/main:Supervisor','/out:'+join(root,'supervisor.exe'),join(import.meta.dir,'../../../bridge/src/platform/win32/supervisor.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/cleanup.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/update.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/owned-log.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/startup.cs')]);if(result.code)throw new Error(result.stdout+result.stderr);
    const module=(path:string)=>JSON.stringify(join(import.meta.dir,path));
    await writeFile(cli,`import{requestCleanup}from ${module('./cleanup-request.ts')};const fs=require('node:fs');const actor=await requestCleanup(${JSON.stringify(root)});fs.writeFileSync(${JSON.stringify(sent+'.tmp')},JSON.stringify({...actor,callerPid:process.pid}),'utf8');fs.renameSync(${JSON.stringify(sent+'.tmp')},${JSON.stringify(sent)});setInterval(()=>{},1000);`,'utf8');
    await writeFile(entry,`const fs=require('node:fs'),child=Bun.spawn(['ping.exe','-t','127.0.0.1'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(pids+'.tmp')},JSON.stringify([process.pid,child.pid]),'utf8');fs.renameSync(${JSON.stringify(pids+'.tmp')},${JSON.stringify(pids)});let launched=false,stopping=false;setInterval(()=>{if(!launched&&fs.existsSync(${JSON.stringify(trigger)})){launched=true;Bun.spawn([process.execPath,${JSON.stringify(cli)}],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});}if(!stopping&&fs.existsSync(process.env.CODERAIL_STOP_FILE)){stopping=true;setTimeout(()=>process.exit(0),300)}},25);`,'utf8');
    await service.start(spec);await until(()=>existsSync(pids));const state=await service.status(spec);for(const pid of [state.pid!,...JSON.parse(await readFile(pids,'utf8'))]){const ref=ProcessRef.open(pid);if(ref)refs.push(ref);}
    const metadata=(await readFile(join(root,'supervisor.txt'),'utf8')).trim().split('\n'),badNonce=crypto.randomUUID().replaceAll('-',''),self=ProcessRef.open(process.pid)!;
    try {writePrivateFile(join(root,'cleanup-'+metadata[2]),JSON.stringify({schema:1,installationId:'0'.repeat(32),nonce:badNonce,callerPid:process.pid,callerCreated:String(self.created)}));}finally{self.close();}
    await until(()=>existsSync(join(root,'cleanup-error-'+badNonce+'.txt')));expect((await service.status(spec)).pid).toBe(state.pid);expect(refs.every(ref=>ref.alive())).toBe(true);
    writePrivateFile(join(root,'cleanup-'+metadata[2]),'{"schema":');await until(()=>existsSync(join(root,'cleanup-error-'+metadata[2]+'.txt')));expect(existsSync(join(root,'cleanup-'+metadata[2]))).toBe(false);expect((await service.status(spec)).running).toBe(true);
    await writeFile(trigger,'go','utf8');await until(()=>existsSync(sent));const request=JSON.parse(await readFile(sent,'utf8'));const caller=ProcessRef.open(request.callerPid);if(caller)refs.push(caller);
    const ready=join(root,'cleanup-ready-'+request.nonce),error=join(root,'cleanup-error-'+request.nonce+'.txt');
    await until(()=>existsSync(ready)||existsSync(error)||!existsSync(root),15000,'Supervisor cleanup actor handoff');if(existsSync(error))throw new Error(await readFile(error,'utf8'));
    actor=JSON.parse(await readFile(ready,'utf8'));expect(actor?.nonce).toBe(request.nonce);const actorRef=ProcessRef.open(actor!.pid);if(actorRef){expect(String(actorRef.created)).toBe(actor!.created);refs.push(actorRef);}
    await until(()=>refs.every(ref=>!ref.alive()),20000,'Old supervisor, Bridge, CLI, ping and cleanup actor exited');
    if(existsSync(root))throw new Error(existsSync(error)?await readFile(error,'utf8'):'Installation still exists');expect(existsSync(root)).toBe(false);
    console.log(JSON.stringify({supervisorCleanupHandoff:true,callerInsideBridgeJob:true,mappedHelperRemoved:true,rootRemoved:true,remaining:0}));
  } finally {
    await service.stop(spec);if(actor)await stopActor(actor);for(const ref of refs)ref.close();
    if(!contains(realpathSync.native(tmpdir()),realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));
  }
},45000);
