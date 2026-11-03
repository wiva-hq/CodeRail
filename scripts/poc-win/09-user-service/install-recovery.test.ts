// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect,test } from 'bun:test';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseline } from '../common';
import { contains,retry } from '../04-filesystem/paths';
import { run } from '../../../bridge/src/platform/win32/process';
import { UserAutorun } from './autorun';
import { UserEnvironmentValue } from './user-path';
import { recoverRegistration } from './install-recovery';
import { writePrivateFile } from '../08-runtime-integration/private-fs';

baseline();
test('real installer crash after registry commit: journal recovery removes only owned startup/PATH and is repeatable',async()=>{
  const base=realpathSync.native(tmpdir()),root=await mkdtemp(join(base,'crrecover-')),target=join(root,'CodeRail'),binary=join(root,'fixture.exe'),fixture=join(root,'crash.ts');
  const startupName=`CodeRail-PoC-${crypto.randomUUID()}`,envName=`CodeRail-PoC-${crypto.randomUUID()}`;
  const startup=new UserAutorun(startupName),environment=new UserEnvironmentValue(envName),realPath=new UserEnvironmentValue(),before=realPath.read();
  try {
    const bytes=Buffer.alloc(512);bytes.write('MZ');bytes.writeUInt32LE(0x80,0x3c);bytes.writeUInt32LE(0x4550,0x80);bytes.writeUInt16LE(0x8664,0x84);await writeFile(binary,bytes);
    const module=(name:string)=>JSON.stringify(join(import.meta.dir,name));
    await writeFile(fixture,`import {installPrepared} from ${module('install-transaction.ts')};import{UserAutorun}from ${module('autorun.ts')};import{UserEnvironmentValue}from ${module('user-path.ts')};class Crash extends UserEnvironmentValue{write(value:any){super.write(value);process.exit(42);}}await installPrepared(${JSON.stringify(target)},${JSON.stringify(binary)},'0.0.1+3',{startup:new UserAutorun(${JSON.stringify(startupName)}),environment:new Crash(${JSON.stringify(envName)})});`,'utf8');
    expect((await run([process.execPath,fixture])).code).toBe(42);
    expect(startup.read()).not.toBeNull();expect(environment.read()?.text).toBe(join(target,'bin/current'));
    const journalPath=join(target,'ownership.txt'),journal=JSON.parse(await readFile(journalPath,'utf8'));
    expect(journal.status).toBe('prepared');
    const ownedCommand=startup.read(),ownedPath=environment.read();
    writePrivateFile(journalPath,JSON.stringify({...journal,path:{...journal.path,entry:'C:\\NotCodeRail'}}));
    await expect(recoverRegistration(target,{startup,environment})).rejects.toMatchObject({code:'EINVAL'});
    expect(startup.read()).toBe(ownedCommand);expect(environment.read()).toEqual(ownedPath);
    writePrivateFile(journalPath,JSON.stringify({...journal,installationId:'0'.repeat(32)}));
    await expect(recoverRegistration(target,{startup,environment})).rejects.toMatchObject({code:'EINVAL'});
    writePrivateFile(journalPath,JSON.stringify(journal));
    expect((await recoverRegistration(target,{startup,environment})).filesRetained).toBe(true);
    expect(startup.read()).toBeNull();expect(environment.read()).toBeNull();
    expect((await recoverRegistration(target,{startup,environment})).status).toBe('rolled-back');
    environment.write({type:1,text:join(target,'bin/current')});
    await recoverRegistration(target,{startup,environment});
    expect(environment.read()).toEqual({type:1,text:join(target,'bin/current')});
    const unrelated='"C:\\unrelated-poc.exe"';startup.install(unrelated);
    await expect(recoverRegistration(target,{startup,environment})).rejects.toMatchObject({code:'EEXIST'});expect(startup.read()).toBe(unrelated);startup.uninstall(unrelated);
    expect(realPath.read()).toEqual(before);
  } finally {
    const current=startup.read();if(current)startup.uninstall(current);environment.write(null);
    if(!contains(base,realpathSync.native(root)))throw new Error('Unsafe cleanup');await retry(()=>rm(root,{recursive:true}));
  }
},30000);
