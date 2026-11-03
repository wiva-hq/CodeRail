// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { baseline, until } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { launch } from '../08-runtime-integration/launcher';
import { UserService } from './service';
import { UserAutorun } from './autorun';

baseline();
test('real user supervisor survives the installing CLI exiting, then drains through its control file',async()=>{
  const base=realpathSync.native(tmpdir()),root=await mkdtemp(join(base,'crparent-')),entry=join(root,'installer.ts');
  const spec={command:[process.execPath,'-e','setInterval(()=>{},1000)'],home:homedir(),stateDir:root,logPath:join(root,'bridge.log')};
  const service=new UserService(new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`));
  let parent:ReturnType<typeof launch>|undefined;
  try {
    await writeFile(entry,`import {UserService} from ${JSON.stringify(join(import.meta.dir,'../../../bridge/src/platform/win32/service.ts'))};const spec=${JSON.stringify(spec)};const service=new UserService();await service.prepare(spec);await service.start(spec);`,'utf8');
    parent=launch([process.execPath,entry],root);
    await until(()=>!parent!.alive(),15000,'Installer CLI exited'); await Bun.sleep(200);
    expect((await service.status(spec)).running).toBe(true);
    await service.stop(spec);expect((await service.status(spec)).running).toBe(false);
  } finally {
    await service.stop(spec);parent?.closeJob();parent?.dispose();
    if(!contains(base,realpathSync.native(root)))throw new Error('Unsafe cleanup');await retry(()=>rm(root,{recursive:true}));
  }
},30000);
