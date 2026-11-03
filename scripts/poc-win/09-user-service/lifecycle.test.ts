// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {tmpdir,homedir} from 'node:os';
import {join} from 'node:path';
import {baseline,until} from '../common';
import {contains,retry} from '../04-filesystem/paths';
import {ProcessRef} from '../../../bridge/src/platform/win32/job';
import {installPrepared} from './install-transaction';
import {UserService} from './service';
import {UserAutorun} from './autorun';
import {UserEnvironmentValue} from './user-path';
import {stopActor,type ActorIdentity} from './actor-control';

baseline();
for(const running of [false,true])test(`install -> CLI uninstall with ${running?'running':'inactive'} supervisor: own registry and files removed`,async()=>{
  const base=realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()),'crlifecycle-'))),root=join(base,'CodeRail 中文'),source=join(base,'fixture.exe'),entry=join(base,'cli.ts'),witness=join(base,'ack.json'),bridge=join(base,'bridge.ts');
  const startup=new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`),environment=new UserEnvironmentValue(`CodeRail-PoC-${crypto.randomUUID()}`),realPath=new UserEnvironmentValue(),original=realPath.read(),service=new UserService(startup),spec={command:[process.execPath,bridge],stateDir:root,home:homedir(),logPath:join(root,'bridge.log')};
  const refs:ProcessRef[]=[];let actor:ActorIdentity|undefined;
  try {
    const pe=Buffer.alloc(512);pe.write('MZ');pe.writeUInt32LE(0x80,0x3c);pe.writeUInt32LE(0x4550,0x80);pe.writeUInt16LE(0x8664,0x84);await writeFile(source,pe);
    environment.write({type:2,text:'C:\\Before'});
    await installPrepared(root,source,'0.0.1+1',{startup,environment});
    if(running){
      await writeFile(bridge,`const fs=require('node:fs');Bun.spawn(['ping.exe','-t','127.0.0.1'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});setInterval(()=>{if(fs.existsSync(process.env.CODERAIL_STOP_FILE))process.exit(0)},25);`,'utf8');
      await service.start(spec);const state=await service.status(spec);for(const pid of [state.pid!,state.childPid!]){const ref=ProcessRef.open(pid);if(ref)refs.push(ref);}
    }
    const module=(name:string)=>JSON.stringify(join(import.meta.dir,name));
    await writeFile(entry,`import{uninstallOwned}from ${module('lifecycle.ts')};import{UserAutorun}from ${module('autorun.ts')};import{UserEnvironmentValue}from ${module('user-path.ts')};const fs=require('node:fs');const result=await uninstallOwned(${JSON.stringify(root)},{startup:new UserAutorun(${JSON.stringify(startup.name)}),environment:new UserEnvironmentValue(${JSON.stringify(environment.name)})});fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify(result),'utf8');`,'utf8');
    const child=Bun.spawn([process.execPath,entry],{stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});expect(await child.exited).toBe(0);expect(await new Response(child.stderr).text()).toBe('');
    const result=JSON.parse(await readFile(witness,'utf8'));actor=result.actor;expect(result.status).toBe('cleanup-scheduled');const actorRef=ProcessRef.open(actor!.pid);if(actorRef)refs.push(actorRef);
    await until(()=>!existsSync(root)&&refs.every(ref=>!ref.alive()),20000,'Uninstall caller exited; actor and owned processes/files gone');
    expect(startup.read()).toBeNull();expect(environment.read()).toEqual({type:2,text:'C:\\Before'});expect(realPath.read()).toEqual(original);expect(existsSync(root)).toBe(false);
  } finally {
    await service.stop(spec);if(actor)await stopActor(actor);for(const ref of refs)ref.close();
    const command=startup.read();if(command)startup.uninstall(command);environment.write(null);
    if(!contains(realpathSync.native(tmpdir()),realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));
  }
},45000);
