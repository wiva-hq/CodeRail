// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect,test } from 'bun:test';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { existsSync,realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts,baseline,until } from '../common';
import { contains,retry } from '../04-filesystem/paths';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';
import { handoff } from './handoff';

baseline();
test('self-owned actor Job survives creator handoff; natural actor exit closes the Job and clears descendants',async()=>{
  const root=await mkdtemp(join(artifacts,'actor-handoff-')),entry=join(root,'actor.ts'),ready=join(root,'ready.json'),finish=join(root,'finish');
  let actor:ReturnType<typeof handoff>|undefined,descendant:ProcessRef|null=null;
  try {
    await writeFile(entry,`import{dlopen}from'bun:ffi';const k=dlopen('kernel32.dll',{SetHandleInformation:{args:['ptr','u32','u32'],returns:'i32'}}).symbols;if(!k.SetHandleInformation(Number(process.env.CODERAIL_ACTOR_JOB),1,0))throw Error('Clear inheritance');delete process.env.CODERAIL_ACTOR_JOB;const child=Bun.spawn(['ping.exe','-t','127.0.0.1'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true});const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready+'.tmp')},JSON.stringify({child:child.pid}),'utf8');fs.renameSync(${JSON.stringify(ready+'.tmp')},${JSON.stringify(ready)});setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)}))process.exit(0)},25);`,'utf8');
    actor=handoff([process.execPath,entry],realpathSync.native(root));await until(()=>existsSync(ready));
    descendant=ProcessRef.open(JSON.parse(await readFile(ready,'utf8')).child);expect(descendant?.alive()).toBe(true);
    actor.releaseOwner();await Bun.sleep(100);expect(actor.alive()).toBe(true);expect(descendant?.alive()).toBe(true);
    await writeFile(finish,'finish','utf8');await until(()=>!actor!.alive()&&!descendant!.alive(),10000,'Natural actor exit kills entire Job');
    expect(descendant?.alive()).toBe(false);
  } finally {await actor?.dispose();descendant?.close();if(!contains(artifacts,realpathSync.native(root)))throw new Error('Unsafe cleanup');await retry(()=>rm(root,{recursive:true}));}
});

test('actor controller can reacquire the handed-off Job from its exact process handle and terminate the whole tree',async()=>{
  const root=await mkdtemp(join(artifacts,'actor-stop-'));let actor:ReturnType<typeof handoff>|undefined;
  try {actor=handoff([process.execPath,'-e',"setInterval(()=>{},1000)"],root);actor.releaseOwner();expect(actor.alive()).toBe(true);await actor.stop();expect(actor.alive()).toBe(false);}
  finally{await actor?.dispose();if(!contains(artifacts,realpathSync.native(root)))throw new Error('Unsafe cleanup');await retry(()=>rm(root,{recursive:true}));}
});
