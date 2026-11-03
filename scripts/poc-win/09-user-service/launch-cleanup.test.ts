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
import {deployBinary} from './install-files';
import {UserService} from './service';
import {stopActor,type ActorIdentity} from './actor-control';

baseline();
test('inactive install cleanup survives actual local CLI exit and removes its loaded helper without a permanent supervisor',async()=>{
  const base=realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()),'crlocalremove-'))),root=join(base,'CodeRail 中文😀'),source=join(base,'fixture.exe'),entry=join(base,'cli.ts'),witness=join(base,'ack.json');
  let actor:ActorIdentity|undefined,ref:ProcessRef|null=null;
  try {
    const pe=Buffer.alloc(512);pe.write('MZ');pe.writeUInt32LE(0x80,0x3c);pe.writeUInt32LE(0x4550,0x80);pe.writeUInt16LE(0x8664,0x84);await writeFile(source,pe);await deployBinary(root,source,'0.0.1+1');
    await new UserService().prepare({command:[source,'run'],stateDir:root,home:homedir(),logPath:join(root,'bridge.log')});
    await writeFile(entry,`import{launchCleanup}from ${JSON.stringify(join(import.meta.dir,'launch-cleanup.ts'))};const fs=require('node:fs');const ack=await launchCleanup(${JSON.stringify(root)});fs.writeFileSync(${JSON.stringify(witness)},JSON.stringify(ack),'utf8');`,'utf8');
    // No extra per-command Job: simulate a local CLI, not a managed Bridge command.
    // The actor still inherits the test's outer Job, whose lifetime is retained.
    const child=Bun.spawn([process.execPath,entry],{stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
    expect(await child.exited).toBe(0);expect(await new Response(child.stderr).text()).toBe('');
    actor=JSON.parse(await readFile(witness,'utf8'));ref=ProcessRef.open(actor!.pid);
    if(ref)expect(String(ref.created)).toBe(actor!.created);
    await until(()=>!existsSync(root)&&(!ref||!ref.alive()),15000,'Local CLI exited; cleanup actor removed owned installation');
    expect(existsSync(root)).toBe(false);
    console.log(JSON.stringify({localCliExit:true,inactiveInstallationRemoved:true,outerJobEscape:false}));
  }finally{
    if(actor)await stopActor(actor);ref?.close();
    if(!contains(realpathSync.native(tmpdir()),realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));
  }
},30000);
