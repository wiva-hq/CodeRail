// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {baseline,until} from '../common';
import {contains,retry} from '../04-filesystem/paths';
import {run} from '../../../bridge/src/platform/win32/process';
import {normalizeEnvironment,utf8} from '../../../bridge/src/platform/win32/shell';
import {ensurePrivateDirectory,writePrivateFile} from '../08-runtime-integration/private-fs';
import {readInstallation} from '../09-user-service/install-files';
import {UserAutorun} from '../09-user-service/autorun';
import {UserEnvironmentValue} from '../09-user-service/user-path';
import {unregisterInstallation} from '../09-user-service/uninstall-registration';
import {UserService} from '../09-user-service/service';
import {ProcessRef} from '../../../bridge/src/platform/win32/job';
import {homedir} from 'node:os';

// Explicit opt-in script, deliberately not part of the normal test discovery:
// briefly registers real HKCU CodeRail/PATH, and refuses existing ownership.
baseline();
const startup=new UserAutorun(),environment=new UserEnvironmentValue(),before=environment.read();
assert.equal(startup.read(),null,'Existing CodeRail startup: do not touch it');
const binary=realpathSync.native(resolve(process.argv[2]??'scripts/poc-win/artifacts/update-cli/old.exe'));
const candidate=realpathSync.native(resolve(process.argv[3]??'scripts/poc-win/artifacts/update-cli/new.exe'));
const candidateFile=Bun.file(candidate),candidateHash=new Bun.CryptoHasher('sha256');for await(const chunk of candidateFile.stream())candidateHash.update(chunk);
const candidateSha=candidateHash.digest('hex'),candidateVersion=(await run([candidate,'version'])).stdout.trim();
let corruptManifest=false,artifactRequests=0;const versions=new Set<string>();let lastOpened=0,lastClosed=0;
const temp=realpathSync.native(tmpdir()),base=realpathSync.native(await mkdtemp(join(temp,'crcompiled-'))),root=join(base,'CodeRail 中文'),env={...normalizeEnvironment(process.env),CODERAIL_HOME:root,PATH:join(process.env.SystemRoot!,'System32')};
let installed=false,server:ReturnType<typeof Bun.serve>|undefined;
const refs:ProcessRef[]=[],paired=true,service=new UserService(),spec={command:[],home:homedir(),stateDir:root,logPath:join(root,'bridge.log')};
try {
  ensurePrivateDirectory(base);writePrivateFile(join(base,'registry-before.json'),JSON.stringify({startup:null,path:before}));
  const result=await run([binary,'install'],{env,timeout:20000});assert.equal(result.code,0,result.stderr);installed=true;
  const record=readInstallation(root)!;assert(record);assert.notEqual(startup.read(),null);assert(environment.read()?.text.includes(join(root,'bin/current')));
  assert.equal((await run([record.executable,'version'],{env})).code,0);
  if(paired){
    const secret=crypto.randomUUID(),token=crypto.randomUUID();let hello=false;
    const fixture=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req,ws){
      const path=new URL(req.url).pathname;
      if(path==='/api/version/windows-x64')return Response.json({schema:1,target:'windows-x64',helperProtocol:1,version:candidateVersion,size:candidateFile.size,sha256:corruptManifest?'0'.repeat(64):candidateSha,url:`http://127.0.0.1:${ws.port}/artifact`});
      if(path==='/artifact'){artifactRequests++;return new Response(candidateFile);}
      if(path==='/api/pair/start')return Response.json({code:'LIFECYCLE',secret,url:`http://127.0.0.1:${ws.port}/approve`});
      if(path==='/api/pair/poll'){const body=await req.json() as any;if(body.code!=='LIFECYCLE'||body.secret!==secret)return new Response('Unauthorized',{status:401});return Response.json({token,machineId:'compiled-lifecycle-poc',name:'本机安装测试'});}
      if(path==='/api/bridge'&&req.headers.get('authorization')==='Bearer '+token)return ws.upgrade(req)?undefined:new Response('Upgrade',{status:426});
      return new Response('Not found',{status:404});
    },websocket:{open(){lastOpened=Date.now();},close(){lastClosed=Date.now();},message(ws,data){const frame=JSON.parse(String(data));if(frame.t==='hello'){hello=true;versions.add(frame.info.bridgeVersion);}if(frame.t==='ping')ws.send(JSON.stringify({t:'pong'}));}}});server=fixture;
    const pair=Bun.spawn([record.executable,'pair',`http://127.0.0.1:${fixture.port}`,'--json'],{env:{...env,CODERAIL_NO_OPEN:'1'},stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
    const [code,,errors]=await Promise.all([pair.exited,new Response(pair.stdout).text(),new Response(pair.stderr).text()]);assert.equal(code,0,errors);
    await until(()=>hello,20000,'Installed background Bridge hello after pairing CLI exits');
    const state=await service.status(spec);assert(state.running);for(const pid of [state.pid!,state.childPid!]){const ref=ProcessRef.open(pid);if(ref)refs.push(ref);}
  }
  const initial=await service.status(spec);assert(initial.running);const originalVersion=record.version;
  corruptManifest=true;const rejected=await run([record.executable,'update'],{env,timeout:90000});assert.notEqual(rejected.code,0);assert.match(rejected.stderr,/SHA256/);assert.equal(readInstallation(root)?.version,originalVersion);assert.equal((await service.status(spec)).childPid,initial.childPid);
  corruptManifest=false;const started=performance.now(),update=await run([record.executable,'update'],{env,timeout:90000});assert.equal(update.code,0,update.stderr);assert.match(update.stdout,/scheduled/);
  const nonce=/update-result-([a-f0-9]{32})/.exec(update.stdout)?.[1];assert(nonce);
  const fs=await import('node:fs/promises');await until(()=>existsSync(join(root,'update-result-'+nonce)),20000,'Compiled update result');assert.equal(JSON.parse(await fs.readFile(join(root,'update-result-'+nonce),'utf8')).status,'committed');
  await until(()=>versions.has(candidateVersion),30000,'New compiled Bridge reconnects and announces its version');assert.equal(readInstallation(root)?.version,candidateVersion);assert.equal((await service.status(spec)).pid,initial.pid);assert.equal((await run([join(root,'bin/previous/coderail.exe'),'version'],{env})).stdout.trim(),originalVersion);
  const downtime=Math.max(0,lastOpened-lastClosed);assert(downtime<5000,`Reconnect gap ${downtime}ms`);
  const again=await run([record.executable,'update'],{env});assert.equal(again.code,0);assert.match(again.stdout,/Already up to date/);assert.equal(artifactRequests,2);
  console.log(JSON.stringify({compiledUpdate:true,from:originalVersion,to:candidateVersion,supervisorPidStable:true,badShaRefused:true,previousVersionExecutable:true,defaultManifestRoute:true,bridgeReconnected:true,reconnectGapMs:downtime,updateMs:Math.round(performance.now()-started),cloudflareE2E:false}));
  // Keep the invoking outer Job alive until deletion; do not use run(), whose
  // per-command Job would intentionally terminate the self-owned actor on return.
  const child=Bun.spawn([record.executable,'uninstall'],{env,stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
  const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  assert.equal(code,0,stderr);assert.match(stdout,/Cleanup scheduled/);
  await until(()=>!existsSync(root)&&refs.every(ref=>!ref.alive()),20000,'Compiled CLI exited and installed image/process tree was removed');
  assert.equal(startup.read(),null);assert.deepEqual(environment.read(),before);
  console.log(JSON.stringify({compiledUpdateThenUninstall:true,noNodeBunOnPath:true,pairedBackground:paired,cloudflareE2E:false,ownStartupRemoved:true,pathRestored:true,installedImageRemoved:true,ownedServiceProcessesRemaining:0,realRelog:false,cleanRoom:false}));
} finally {
  await service.stop(spec);for(const ref of refs)ref.close();await server?.stop(true);
  if(existsSync(root)) {
    const record=readInstallation(root);
    if(record&&installed){
      await unregisterInstallation(root);
      const script=utf8+`$ErrorActionPreference='Stop';$bytes=[IO.File]::ReadAllBytes($env:CR_IMAGE);$sha=[Security.Cryptography.SHA256]::Create();try{$actual=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($actual -ne $env:CR_SHA){throw 'Helper hash mismatch'};$asm=[Reflection.Assembly]::Load($bytes);$asm.GetType('OwnedCleanup').GetMethod('Remove').Invoke($null,@($env:CR_ROOT,$env:CR_ID));`;
      const bytes=await Bun.file(join(root,'supervisor.exe')).arrayBuffer();
      const cleanup=await run([join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{cwd:base,env:{...normalizeEnvironment(process.env),CR_IMAGE:join(root,'supervisor.exe'),CR_ROOT:root,CR_ID:record.id,CR_SHA:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}});
      assert.equal(cleanup.code,0,cleanup.stderr);
    }
  }
  assert.equal(startup.read(),null);assert.deepEqual(environment.read(),before);
  if(!contains(temp,realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));
}
