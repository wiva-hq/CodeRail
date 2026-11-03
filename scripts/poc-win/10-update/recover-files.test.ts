// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {baseline} from '../common';
import {contains,retry} from '../04-filesystem/paths';
import {run} from '../../../bridge/src/platform/win32/process';
import {deployBinary,readInstallation} from '../09-user-service/install-files';
import {stageUpdate} from '../09-user-service/update-stage';
import {recoverFiles} from './recover-files';

baseline();
test('actual updater crash at each rename/marker boundary restores hash-verified old generation; modified layout refuses mutation',async()=>{
  const base=realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()),'cruprecover-'))),image=join(base,'old.exe'),download=join(base,'new.exe');
  try {
    const bytes=Buffer.alloc(512);bytes.write('MZ');bytes.writeUInt32LE(0x80,0x3c);bytes.writeUInt32LE(0x4550,0x80);bytes.writeUInt16LE(0x8664,0x84);await writeFile(image,bytes);bytes[511]=42;await writeFile(download,bytes);
    const manifest={version:'0.0.1+2',size:bytes.length,sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')};
    for(const phase of ['prepared','old-renamed','old-moved','candidate-renamed','candidate-active','marker-updated']){
      const root=join(base,phase),old=await deployBinary(root,image,'0.0.1+1'),stage=await stageUpdate(root,download,manifest),script=join(base,phase+'.ts');
      await writeFile(script,`import{activateFiles}from ${JSON.stringify(join(import.meta.dir,'activate-files.ts'))};await activateFiles(${JSON.stringify(root)},${JSON.stringify(stage)},async()=>{},step=>{if(step===${JSON.stringify(phase)})process.exit(42)});throw new Error('Crash boundary was not reached');`,'utf8');
      expect((await run([process.execPath,script])).code).toBe(42);
      expect((await recoverFiles(root)).status).toBe('rolled-back');expect(readInstallation(root)).toEqual(old);expect(await readFile(old.executable)).toEqual(await readFile(image));
      expect((await recoverFiles(root)).status).toBe('rolled-back');
      if(phase==='candidate-active'){
        const marker=JSON.parse(await readFile(join(root,'update.json'),'utf8'));
        marker.old.sha256='0'.repeat(64);await writeFile(join(root,'update.json'),JSON.stringify(marker),'utf8');
        await expect(recoverFiles(root)).rejects.toMatchObject({code:'EACCES'});expect(await readFile(old.executable)).toEqual(await readFile(image));
      }
    }
  }finally{if(!contains(realpathSync.native(tmpdir()),realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));}
},30000);
