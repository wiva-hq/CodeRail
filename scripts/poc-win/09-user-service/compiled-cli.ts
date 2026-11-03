// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { baseline, until } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { run } from '../../../bridge/src/platform/win32/process';
import { normalizeEnvironment } from '../../../bridge/src/platform/win32/shell';
import { ensurePrivateDirectory, writePrivateFile } from '../08-runtime-integration/private-fs';
import { spawnStream } from '../../../bridge/src/platform/win32/stream';

baseline();
const executable=realpathSync.native(resolve(process.argv[2]??'bridge/build/coderail-windows-x64.exe'));
const base=realpathSync.native(tmpdir()), root=await mkdtemp(join(base,'crcli-'));
const previousHome=process.env.CODERAIL_HOME;process.env.CODERAIL_HOME=root;
try {
  ensurePrivateDirectory(root);
  const env={...normalizeEnvironment(process.env),CODERAIL_HOME:root,PATH:join(process.env.SystemRoot!,'System32')};
  const version=await run([executable,'version'],{env}); assert.equal(version.code,0); assert.match(version.stdout.trim(),/^\d+\.\d+\.\d+\+\d+$/);
  writePrivateFile(join(root,'bridge.log'),'compiled 中文日志😀\n');
  const logs=await run([executable,'logs'],{env}); assert.equal(logs.code,0); assert.equal(logs.stdout,'compiled 中文日志😀\n');
  const status=await run([executable,'status','--json'],{env}); assert.equal(status.code,0);
  const state=JSON.parse(status.stdout); assert.equal(state.version,version.stdout.trim()); assert.equal(state.link,null); assert.equal(state.service,'stopped');
  const secret=crypto.randomUUID(), token=crypto.randomUUID();let hello=false;
  const server=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req,server){
    const path=new URL(req.url).pathname;
    if(path==='/api/pair/start')return Response.json({code:'CLI-POC',secret,url:`http://127.0.0.1:${server.port}/approve`});
    if(path==='/api/pair/poll') { const body=await req.json() as any; if(body.code!=='CLI-POC'||body.secret!==secret)return new Response('Unauthorized',{status:401});return Response.json({token,machineId:'compiled-cli-poc',name:'配对 中文😀'}); }
    if(path==='/api/bridge'&&req.headers.get('authorization')==='Bearer '+token)return server.upgrade(req)?undefined:new Response('Upgrade',{status:426});
    return new Response('Not found',{status:404});
  },websocket:{message(ws,data){const frame=JSON.parse(String(data));if(frame.t==='hello')hello=true;if(frame.t==='ping')ws.send(JSON.stringify({t:'pong'}));}}});
  let child:Awaited<ReturnType<typeof spawnStream>>|undefined;
  try {
    child=await spawnStream([executable,'pair',`http://127.0.0.1:${server.port}`,'--no-service','--json'],{cwd:root,env:{...env,CODERAIL_NO_OPEN:'1'}});
    const output=new Response(child.stdout).text(),errors=new Response(child.stderr).text();
    try {
      await until(()=>hello,30000,'Compiled CLI pair followed by foreground Bridge hello');
      const config=JSON.parse(await readFile(join(root,'config.json'),'utf8'));assert.equal(config.machineId,'compiled-cli-poc');assert.equal(config.name,'配对 中文😀');assert.equal(config.token,token);
    } finally {child.stop();await child.exited;await output;await errors;}
  } finally {if(child){child.stop();await child.exited;}await server.stop(true);}
  const hasher=new Bun.CryptoHasher('sha256'); for await(const chunk of Bun.file(executable).stream())hasher.update(chunk);
  console.log(JSON.stringify({compiledCli:true,noNodeBunOnPath:true,version:state.version,utf8Logs:true,unpairedStatus:true,localPairProtocol:true,cloudflareE2E:false,sha256:hasher.digest('hex'),bytes:Bun.file(executable).size}));
} finally {
  if(previousHome===undefined)delete process.env.CODERAIL_HOME;else process.env.CODERAIL_HOME=previousHome;
  if(!contains(base,realpathSync.native(root))||!root.includes('crcli-'))throw new Error('Unsafe cleanup');
  await retry(()=>rm(root,{recursive:true}));
}
