// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Caller } from '../../../protocol/src';
import { ERR } from '../../../protocol/src';
import * as files from '../../../bridge/src/files';
import { artifacts, baseline } from '../common';
import { contains } from './paths';

baseline();
test('production file RPCs: native scoped I/O, forward-slash wire paths, binary read, .git and Junction protection', async () => {
  const dir=await mkdtemp(join(artifacts,'fs-win32-rpc-')),root=join(dir,'项目 中文'),outside=join(dir,'outside');
  await mkdir(root);await mkdir(outside);await writeFile(join(outside,'secret.txt'),'outside');
  const caller:Caller={userId:'gate',username:'gate',role:'owner',terminal:true,folders:[root],harnesses:null};
  try{
    const folder=await files.makeDir({path:join(root,'nested')},caller);expect(folder.path).not.toContain('\\');
    const path=join(root,'nested','中文 空格.txt');
    const result=await files.write({path,content:'RPC 中文😀\r\n'},caller);expect(result.name).toBe('中文 空格.txt');
    const read=await files.read({path},caller);expect(read.content).toBe('RPC 中文😀\r\n');expect(read.encoding).toBe('utf8');expect(read.path).not.toContain('\\');
    expect(read.size).toBe(Buffer.byteLength(read.content,'utf8'));
    const listing=await files.list({path:join(root,'nested')},caller);expect(listing.entries[0].path).toBe(result.path);
    const moved=await files.renamePath({from:path,to:join(root,'nested','重命名.txt')},caller);expect(moved.name).toBe('重命名.txt');
    const binary=join(root,'binary.bin');await files.write({path:binary,content:Buffer.from([0,1,2,255]).toString('base64'),encoding:'base64'},caller);
    expect((await files.read({path:binary},caller)).encoding).toBe('base64');
    await expect(files.read({path:root},caller)).rejects.toMatchObject({code:ERR.invalid});
    await mkdir(join(root,'.git'));await expect(files.write({path:join(root,'.git','config'),content:'bad'},caller)).rejects.toMatchObject({code:ERR.forbidden});
    await symlink(outside,join(root,'escape'),'junction');
    await expect(files.read({path:join(root,'escape','secret.txt')},caller)).rejects.toMatchObject({code:ERR.forbidden});
    await expect(files.write({path:join(root,'escape','new.txt'),content:'bad'},caller)).rejects.toMatchObject({code:ERR.forbidden});
    const linked=await files.list({path:root},caller);expect(linked.entries.find(e=>e.name==='escape')?.kind).toBe('link');
  }finally{if(!contains(artifacts,dir))throw new Error('Unsafe RPC test cleanup');await rm(dir,{recursive:true});}
});
