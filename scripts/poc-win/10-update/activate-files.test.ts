// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {baseline} from '../common';
import {contains,retry} from '../04-filesystem/paths';
import {run} from '../../../bridge/src/platform/win32/process';
import {deployBinary,readInstallation} from '../09-user-service/install-files';
import {stageUpdate} from '../09-user-service/update-stage';
import {activateFiles} from './activate-files';

baseline();
test('native dual-directory switch executes verified new image; failed health restores exact old image and marker',async()=>{
  const base=realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()),'cractivate-')));
  try {
    const images:string[]=[];
    for(const build of [1,2]){
      const source=join(base,`image-${build}.cs`),exe=join(base,`image-${build}.exe`);
      await writeFile(source,`using System;using System.Text;class Image{static int Main(string[] args){Console.OutputEncoding=new UTF8Encoding(false);Console.WriteLine("0.0.1+${build}");return 0;}}`,'utf8');
      const compiled=await run([join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),'/nologo','/target:exe','/platform:x64','/out:'+exe,source]);if(compiled.code)throw new Error(compiled.stdout+compiled.stderr);images.push(exe);
    }
    const bytes=await Bun.file(images[1]).arrayBuffer(),manifest={version:'0.0.1+2',size:bytes.byteLength,sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')};
    for(const failure of [false,true]){
      const root=join(base,failure?'rollback':'success'),old=await deployBinary(root,images[0],'0.0.1+1'),stage=await stageUpdate(root,images[1],manifest);
      const activate=()=>activateFiles(root,stage,async(exe,version)=>{
        const result=await run([exe,'version']);expect(result.code).toBe(0);expect(result.stdout.trim()).toBe(version);
        if(failure)throw new Error('Injected unhealthy candidate after executing the new image');
      });
      if(failure){
        await expect(activate()).rejects.toThrow('unhealthy candidate');
        expect(readInstallation(root)).toEqual(old);
        expect((await run([old.executable,'version'])).stdout.trim()).toBe('0.0.1+1');
        expect(new Bun.CryptoHasher('sha256').update(await Bun.file(old.executable).arrayBuffer()).digest('hex')).toBe(old.sha256);
        expect(existsSync(join(root,'bin/previous'))).toBe(false);expect(existsSync(stage.executable)).toBe(true);
        expect(JSON.parse(await readFile(join(root,'update.json'),'utf8')).status).toBe('rolled-back');
      }else{
        expect((await activate()).version).toBe(manifest.version);
        expect(readInstallation(root)?.sha256).toBe(manifest.sha256);expect(readInstallation(root)?.id).toBe(old.id);
        expect((await run([join(root,'bin/previous/coderail.exe'),'version'])).stdout.trim()).toBe('0.0.1+1');
        expect(JSON.parse(await readFile(join(root,'update.json'),'utf8')).status).toBe('committed');
      }
    }
  }finally{if(!contains(realpathSync.native(tmpdir()),realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));}
},30000);
