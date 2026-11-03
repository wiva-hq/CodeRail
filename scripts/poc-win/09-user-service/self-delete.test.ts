// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, baseline, until } from '../common';
import { NativeFile } from '../04-filesystem/native';
import { contains, retry } from '../04-filesystem/paths';
import { launch } from '../08-runtime-integration/launcher';

baseline();
test('capability probe: mapped executable deletion determines whether uninstall needs an external cleanup actor', async()=>{
  const root=await mkdtemp(join(artifacts,'mapped-delete-')),exe=join(root,'owned-ping.exe');
  const api=dlopen('kernel32.dll',{
    CreateFileW:{args:['ptr','u32','u32','ptr','u32','u32','ptr'],returns:'ptr'},
    SetFileInformationByHandle:{args:['ptr','i32','ptr','u32'],returns:'i32'},
    GetLastError:{args:[],returns:'u32'},CloseHandle:{args:['ptr'],returns:'i32'},
  });
  let process:ReturnType<typeof launch>|undefined,lease:NativeFile|undefined;
  try {
    // Only a private copy is executed/deleted, never the Windows system image.
    await copyFile(realpathSync.native(join(globalThis.process.env.SystemRoot!,'System32/ping.exe')),exe);
    lease=new NativeFile(realpathSync.native(root),true);process=launch([realpathSync.native(exe),'-t','127.0.0.1'],root);
    await Bun.sleep(150);expect(process.alive()).toBe(true);
    const path=Buffer.from('\\\\?\\'+realpathSync.native(exe)+'\0','utf16le');
    const raw=api.symbols.CreateFileW(ptr(path),0x10000,7,null,3,0x200080,null);
    let deleted=false,win32=0;
    if(!raw||Number(raw)===-1||Number(raw)===0xffffffffffffffff)win32=api.symbols.GetLastError();
    else {
      try {const flags=new Uint32Array([3]);deleted=!!api.symbols.SetFileInformationByHandle(Number(raw) as Pointer,21,ptr(flags),4);if(!deleted)win32=api.symbols.GetLastError();}
      finally {api.symbols.CloseHandle(Number(raw) as Pointer);}
    }
    if(deleted){expect(existsSync(exe)).toBe(false);expect(process.alive()).toBe(true);}
    else {expect([5,32,50,87]).toContain(win32);expect(existsSync(exe)).toBe(true);}
    console.log(JSON.stringify({mappedExecutableUnlinked:deleted,win32,externalCleanupRequired:!deleted,gate3Passed:false}));
  } finally {
    if(process){process.closeJob();await until(()=>!process!.alive());process.dispose();}lease?.close();api.close();
    if(!contains(artifacts,realpathSync.native(root)))throw new Error('Unsafe cleanup');await retry(()=>rm(root,{recursive:true}));
  }
});
