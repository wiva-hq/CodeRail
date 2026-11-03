// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { appendFile, link, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { LogTail, printLogs } from './logs';

baseline();
test('native UTF-8 log tail: split codepoints, append, truncate, rotation and bounded first read', async () => {
  const root=await mkdtemp(join(artifacts,'log-tail-')), path=join(root,'bridge.log');
  try {
    const tail=new LogTail(root); expect(tail.poll()).toBe('');
    await writeFile(path,''); expect(tail.poll()).toBe('');
    const text=Buffer.from('中文😀\n','utf8');
    await appendFile(path,text.subarray(0,2)); expect(tail.poll()).toBe('');
    await appendFile(path,text.subarray(2)); expect(tail.poll()).toBe('中文😀\n'); expect(tail.poll()).toBe('');
    await writeFile(path,'new'); expect(tail.poll()).toBe('new');
    await rename(path,join(root,'bridge.log.1')); await writeFile(path,'轮转😀'); expect(tail.poll()).toBe('轮转😀');
    await writeFile(path,'a'.repeat(5000)+'中文😀'); const bounded=new LogTail(root,'bridge.log',11); expect(bounded.poll()).toBe('a中文😀');
  } finally { if(!contains(artifacts,root))throw new Error('Unsafe cleanup'); await retry(()=>rm(root,{recursive:true})); }
});

test('log tail refuses final file symlinks and hardlinks without reading outside bytes', async () => {
  const root=await mkdtemp(join(artifacts,'log-scope-')), outside=join(root,'outside.txt'), dir=join(root,'owned');
  const {mkdir}=await import('node:fs/promises'); await mkdir(dir); await writeFile(outside,'private outside');
  try {
    const path=join(dir,'bridge.log'); await link(outside,path);
    expect(()=>new LogTail(dir).poll()).toThrow('one link'); await rm(path);
    try { await symlink(outside,path,'file'); }
    catch(cause:any) { if(cause.code!=='EPERM')throw cause; console.log(JSON.stringify({fileSymlinkNotAvailable:true,hardlinkRejection:true})); return; }
    expect(()=>new LogTail(dir).poll()).toThrow('non-reparse');
  } finally { if(!contains(artifacts,root))throw new Error('Unsafe cleanup'); await retry(()=>rm(root,{recursive:true})); }
});

test('log CLI follows UTF-8 output until abort without spawning a helper process', async () => {
  const root=await mkdtemp(join(artifacts,'log-follow-')),path=join(root,'bridge.log');
  try {
    await writeFile(path,'old\n'); const controller=new AbortController(), output:string[]=[];
    const following=printLogs(path,{follow:true,signal:controller.signal,write:text=>output.push(text)});
    await appendFile(path,'新日志😀\n'); await Bun.sleep(250); controller.abort(); await following;
    expect(output.join('')).toBe('old\n新日志😀\n');
  } finally { if(!contains(artifacts,root))throw new Error('Unsafe cleanup'); await retry(()=>rm(root,{recursive:true})); }
});
