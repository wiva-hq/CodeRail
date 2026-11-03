// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,readdir,rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {baseline} from '../common';
import {contains,retry} from '../04-filesystem/paths';
import {deployBinary,readInstallation} from '../09-user-service/install-files';
import {fetchManifest,downloadAndStage,validateManifest} from './manifest';

baseline();
test('HTTPS manifest contract and streamed download: valid stage, corrupt/oversize bodies, redirects and stalled bodies fail without candidate/temp leaks',async()=>{
  const base=realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()),'crdownload-'))),root=join(base,'CodeRail 中文😀'),source=join(base,'source.exe');
  const bytes=Buffer.alloc(512);bytes.write('MZ');bytes.writeUInt32LE(0x80,0x3c);bytes.writeUInt32LE(0x4550,0x80);bytes.writeUInt16LE(0x8664,0x84);
  let mode='valid';const sockets=new Set<ReadableStreamDefaultController<Uint8Array>>();
  const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,ws){
    const path=new URL(req.url).pathname;
    if(path==='/manifest')return Response.json({schema:1,target:'windows-x64',helperProtocol:1,version:'0.0.1+2',size:bytes.length,sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),url:`http://127.0.0.1:${ws.port}/artifact`});
    if(path==='/redirect')return Response.redirect('http://example.com/untrusted.exe',302);
    if(path==='/large-manifest')return new Response(' '.repeat(16385));
    if(path==='/artifact'){
      if(mode==='stall')return new Response(new ReadableStream<Uint8Array>({start(controller){sockets.add(controller);controller.enqueue(bytes.subarray(0,100));},cancel(){}}));
      if(mode==='oversize')return new Response(Buffer.concat([bytes,Buffer.from('overlay')]));
      const body=Buffer.from(bytes);if(mode==='corrupt')body[511]=42;return new Response(body);
    }
    return new Response('Not found',{status:404});
  }});
  try {
    await writeFile(source,bytes);const installed=await deployBinary(root,source,'0.0.1+1'),url=`http://127.0.0.1:${server.port}`,manifest=await fetchManifest(url+'/manifest');
    expect(()=>validateManifest({...manifest,target:'windows-arm64'})).toThrow();expect(()=>validateManifest({...manifest,helperProtocol:2})).toThrow();expect(()=>validateManifest({...manifest,url:'http://example.com/update.exe'})).toThrow();
    await expect(fetchManifest(url+'/redirect')).rejects.toMatchObject({code:'EINVAL'});await expect(fetchManifest(url+'/large-manifest')).rejects.toMatchObject({code:'EFBIG'});
    for(mode of ['corrupt','oversize','stall']){
      await expect(downloadAndStage(root,manifest,200)).rejects.toThrow();
      expect(await readdir(join(root,'updates'))).toEqual([]);expect(readInstallation(root)).toEqual(installed);
    }
    mode='valid';const staged=await downloadAndStage(root,manifest);expect(staged.sha256).toBe(manifest.sha256);
    expect((await readdir(join(root,'updates'))).filter(name=>name.startsWith('download-'))).toEqual([]);expect(readInstallation(root)).toEqual(installed);
  }finally{
    await server.stop(true);if(!contains(realpathSync.native(tmpdir()),realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));
  }
},15000);
