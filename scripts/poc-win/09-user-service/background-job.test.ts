// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, baseline, until } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { launch } from '../08-runtime-integration/launcher';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';

baseline();
test('a detached background child still inherits its installer Job; installer Job close cannot be used for service persistence',async()=>{
  const root=await mkdtemp(join(artifacts,'background-job-')),source=join(root,'installer.ts'),ready=join(root,'ready.json');
  let installer:ReturnType<typeof launch>|undefined,child:ProcessRef|null=null;
  try {
    await writeFile(source,`const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdin:'ignore',stdout:'ignore',stderr:'ignore',windowsHide:true,detached:true});child.unref();const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready+'.tmp')},JSON.stringify({pid:child.pid}),'utf8');fs.renameSync(${JSON.stringify(ready+'.tmp')},${JSON.stringify(ready)});`,'utf8');
    installer=launch([process.execPath,source],realpathSync.native(root));
    await until(()=>existsSync(ready)&&!installer!.alive(),10000,'Installer exited after starting detached child');
    const record=JSON.parse(await readFile(ready,'utf8'));child=ProcessRef.open(record.pid);expect(child?.alive()).toBe(true);expect(installer.members()).toContain(record.pid);
    if(!child)throw new Error('Detached child exited before identity capture');
    installer.closeJob();await until(()=>!child!.alive());expect(child.alive()).toBe(false);
    console.log(JSON.stringify({detachedStillInheritsJob:true,installerJobCloseEndsBackgroundChild:true,supervisorActorRequiredForManagedInstall:true,gate3Passed:false}));
  } finally {
    if(installer){installer.closeJob();if(child)await until(()=>!child!.alive());installer.dispose();}child?.close();
    if(!contains(artifacts,realpathSync.native(root)))throw new Error('Unsafe cleanup');await retry(()=>rm(root,{recursive:true}));
  }
});
