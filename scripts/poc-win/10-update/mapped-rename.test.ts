// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {copyFile,mkdtemp,mkdir,rm} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {baseline,until} from '../common';
import {NativeFile} from '../04-filesystem/native';
import {contains,retry} from '../04-filesystem/paths';
import {launch} from '../../../bridge/src/platform/win32/launcher';
baseline();
test('capability probe: mapped image read/delete access and generation rename without deleting a running image',async()=>{
  const base=realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()),'crmappedrename-'))),current=join(base,'current'),exe=join(current,'coderail.exe');
  let process:ReturnType<typeof launch>|undefined,parent:NativeFile|undefined,directory:NativeFile|undefined;
  try{
    await mkdir(current);await copyFile(join(globalThis.process.env.SystemRoot!,'System32/ping.exe'),exe);parent=new NativeFile(base,true);process=launch([exe,'-t','127.0.0.1'],base);await Bun.sleep(100);expect(process.alive()).toBe(true);
    directory=parent.child('current',true,false,true);let deleteHandle=false,renamed=false,code:string|undefined;
    try{const image=directory.child('coderail.exe',false,false,true);image.close();deleteHandle=true;}catch(cause:any){expect(['EACCES','EBUSY']).toContain(cause.code);code=cause.code;}
    try{directory.renameTo(parent,'previous',false);renamed=true;expect(existsSync(join(base,'previous/coderail.exe'))).toBe(true);}catch(cause:any){expect(['EACCES','EBUSY']).toContain(cause.code);code=cause.code;}
    expect(process.alive()).toBe(true);console.log(JSON.stringify({mappedImageDeleteHandle:deleteHandle,mappedDirectoryRename:renamed,code,executingImageDeleted:false}));
  }finally{
    if(process){process.closeJob();await until(()=>!process!.alive());process.dispose();}directory?.close();parent?.close();
    if(!contains(realpathSync.native(tmpdir()),realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));
  }
},15000);
