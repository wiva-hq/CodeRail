// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync,realpathSync} from 'node:fs';
import {join} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {baseline,until} from '../common';
import {contains,retry} from '../04-filesystem/paths';
import {run} from '../../../bridge/src/platform/win32/process';
import {ProcessRef} from '../../../bridge/src/platform/win32/job';
import {deployBinary,readInstallation} from '../09-user-service/install-files';
import {ensurePrivateDirectory,writePrivateFile} from '../08-runtime-integration/private-fs';
import {stageUpdate} from '../09-user-service/update-stage';
import {UserService} from './service-stop';
import {UserAutorun} from '../09-user-service/autorun';

baseline();
for(const mode of ['healthy','unhealthy','crash-old-renamed','crash-candidate-renamed','crash-marker-updated','repeat-crash-prune'])test(`persistent supervisor update: ${mode}`,async()=>{
  const healthy=mode!=='unhealthy',crash=mode.startsWith('crash-')?mode.slice(6):null,repeatCrash=mode==='repeat-crash-prune';
  const base=realpathSync.native(await mkdtemp(join(realpathSync.native(tmpdir()),'crrootupdate-'))),root=join(base,'CodeRail 中文😀'),cleanup=join(base,'cleanup-partial.cs'),caller=join(base,'caller.ts'),trigger=join(base,'trigger'),sent=join(base,'sent.json');
  const service=new UserService(new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`)),spec={command:[join(root,'bin/current/coderail.exe'),'run'],stateDir:root,home:homedir(),logPath:join(root,'bridge.log')},refs:ProcessRef[]=[];
  const previousEnv={CR_WITNESS:process.env.CR_WITNESS,CR_TRIGGER:process.env.CR_TRIGGER,CR_CALLER_EXE:process.env.CR_CALLER_EXE,CR_CALLER_SCRIPT:process.env.CR_CALLER_SCRIPT,CODERAIL_POC_UPDATE_CRASH:process.env.CODERAIL_POC_UPDATE_CRASH};
  let rootRef:ProcessRef|null=null;
  const compiler=join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile=async(args:string[])=>{const result=await run([compiler,'/nologo','/platform:x64','/r:System.Web.Extensions.dll',...args]);if(result.code)throw new Error(result.stdout+result.stderr);};
  try {
    ensurePrivateDirectory(base);
    const images:string[]=[];
    for(const version of [1,2,3]){
      const source=join(base,`bridge-${version}.cs`),exe=join(base,`bridge-${version}.exe`);
      const program=`using System;using System.IO;using System.Text;using System.Threading;using System.Diagnostics;using System.Web.Script.Serialization;class BridgeFixture{static int Main(string[] args){Console.OutputEncoding=new UTF8Encoding(false);if(args.Length>0&&args[0]=="version"){Console.WriteLine("0.0.1+${version}");return 0;}var self=Process.GetCurrentProcess();var info=new ProcessStartInfo(Path.Combine(Environment.GetEnvironmentVariable("SystemRoot"),"System32/ping.exe"),"-t 127.0.0.1");info.UseShellExecute=false;info.CreateNoWindow=true;var ping=Process.Start(info);string witness=Environment.GetEnvironmentVariable("CR_WITNESS"),root=Environment.GetEnvironmentVariable("CODERAIL_HOME");if(witness==null)throw new Exception("Missing CR_WITNESS environment");File.WriteAllText(Path.Combine(witness,"v${version}.json.tmp"),new JavaScriptSerializer().Serialize(new{pid=self.Id,created=self.StartTime.ToUniversalTime().ToFileTimeUtc().ToString(),ping=ping.Id,pingCreated=ping.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()}),new UTF8Encoding(false));string record=Path.Combine(witness,"v${version}.json");if(File.Exists(record))File.Delete(record);File.Move(record+".tmp",record);${version===2&&!healthy?'return 2;':`File.WriteAllText(Path.Combine(root,"state.json"),new JavaScriptSerializer().Serialize(new{pid=self.Id,version="0.0.1+${version}",state="connected",at=DateTime.UtcNow.ToString("o")}),new UTF8Encoding(false));bool launched=false;int deleteFailures=0;while(!File.Exists(Environment.GetEnvironmentVariable("CODERAIL_STOP_FILE"))){string trigger=Environment.GetEnvironmentVariable("CR_TRIGGER");if(${version===1?'true':'false'}&&!launched&&File.Exists(trigger)){try{File.Delete(trigger);}catch(IOException error){int code=error.HResult&65535;if((code!=5&&code!=32&&code!=33)||++deleteFailures>10)throw;Thread.Sleep(20);continue;}launched=true;var cli=new ProcessStartInfo(Environment.GetEnvironmentVariable("CR_CALLER_EXE"),"\\\""+Environment.GetEnvironmentVariable("CR_CALLER_SCRIPT")+"\\\"");cli.UseShellExecute=false;cli.CreateNoWindow=true;Process.Start(cli);}Thread.Sleep(20);}return 0;`}}}`;
      await writeFile(source,program,'utf8');await compile(['/target:exe','/out:'+exe,source]);images.push(exe);
    }
    const installed=await deployBinary(root,images[0],'0.0.1+1'),bytes=await Bun.file(images[1]).arrayBuffer(),manifest={version:'0.0.1+2',size:bytes.byteLength,sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')};await stageUpdate(root,images[1],manifest);
    await writeFile(cleanup,(await readFile(join(import.meta.dir,'../../../bridge/src/platform/win32/cleanup.cs'),'utf8')).replace('public static class OwnedCleanup','public static partial class OwnedCleanup'),'utf8');
    await compile(['/target:winexe','/define:CODERAIL_POC','/main:Supervisor','/out:'+join(root,'supervisor.exe'),join(import.meta.dir,'../../../bridge/src/platform/win32/supervisor.cs'),cleanup,join(import.meta.dir,'../../../bridge/src/platform/win32/update.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/owned-log.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/startup.cs')]);
    const module=(name:string)=>JSON.stringify(join(import.meta.dir,name));
    await writeFile(caller,`import{ProcessRef}from ${module('../../../bridge/src/platform/win32/job.ts')};import{writePrivateFile}from ${module('../08-runtime-integration/private-fs.ts')};const fs=require('node:fs'),root=${JSON.stringify(root)},metadata=fs.readFileSync(root+'/supervisor.txt','utf8').trim().split('\\n'),self=ProcessRef.open(process.pid),nonce=crypto.randomUUID().replaceAll('-','');const request={schema:1,helperProtocol:1,installationId:${JSON.stringify(installed.id)},nonce,...${JSON.stringify(manifest)},callerPid:process.pid,callerCreated:String(self.created)};self.close();writePrivateFile(root+'/update-'+metadata[2],JSON.stringify(request));fs.writeFileSync(${JSON.stringify(sent+'.tmp')},JSON.stringify(request),'utf8');fs.renameSync(${JSON.stringify(sent+'.tmp')},${JSON.stringify(sent)});setInterval(()=>{},1000);`,'utf8');
    Object.assign(process.env,{CR_WITNESS:base,CR_TRIGGER:trigger,CR_CALLER_EXE:process.execPath,CR_CALLER_SCRIPT:caller});
    if(crash||repeatCrash)process.env.CODERAIL_POC_UPDATE_CRASH=crash??'previous-file-pruned';else delete process.env.CODERAIL_POC_UPDATE_CRASH;
    await service.start(spec);await until(()=>existsSync(join(base,'v1.json')));const before=await service.status(spec),old=JSON.parse(await readFile(join(base,'v1.json'),'utf8'));
    rootRef=ProcessRef.open(before.pid!);
    for(const pid of [old.pid,old.ping]){const ref=ProcessRef.open(pid);if(ref)refs.push(ref);}
    writePrivateFile(trigger,'update');await until(()=>existsSync(sent));const request=JSON.parse(await readFile(sent,'utf8')),cli=ProcessRef.open(request.callerPid);if(cli)refs.push(cli);
    const resultPath=join(root,'update-result-'+request.nonce),errorPath=join(root,'update-error-'+request.nonce+'.txt');
    if(crash){
      await until(()=>!rootRef!.alive(),15000,'Real supervisor exit at update boundary');
      await service.start(spec);const resumed=await service.status(spec);
      await until(async()=>{try{const state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));return state.version==='0.0.1+1'&&state.pid===resumed.childPid;}catch{return false;}},10000,'Startup recovers old executable before launching Bridge');
      expect((await service.status(spec)).pid).not.toBe(before.pid);expect(readInstallation(root)).toEqual(installed);
      expect(JSON.parse(await readFile(join(root,'update.json'),'utf8')).status).toBe('rolled-back');
      await until(()=>refs.every(ref=>!ref.alive()),10000,'Old root Job and updater caller gone after real crash');
      console.log(JSON.stringify({actualRootCrash:crash,startupRestoredOldGeneration:true,oldJobRemaining:0}));return;
    }
    await until(()=>existsSync(resultPath)||!(existsSync(join(root,'supervisor.txt'))),15000,'Persistent root update result');
    if(!existsSync(resultPath))throw new Error(existsSync(errorPath)?await readFile(errorPath,'utf8'):'Update result missing');
    const result=JSON.parse(await readFile(resultPath,'utf8'));expect(result.status).toBe(healthy?'committed':'rolled-back');
    await until(()=>refs.every(ref=>!ref.alive()),10000,'Old Bridge, ping and update caller Job drained');
    await until(async()=>{try{const state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));return state.version===(healthy?'0.0.1+2':'0.0.1+1');}catch{return false;}},10000,'Candidate or rolled back Bridge state');
    expect((await service.status(spec)).pid).toBe(before.pid);expect(readInstallation(root)?.version).toBe(healthy?'0.0.1+2':'0.0.1+1');
    if(!healthy){expect(await readFile(errorPath,'utf8')).toContain('Candidate exited');expect(readInstallation(root)?.sha256).toBe(installed.sha256);}
    if(mode==='healthy'||repeatCrash){
      const middle=JSON.parse(await readFile(join(base,'v2.json'),'utf8')),middleRefs:ProcessRef[]=[];
      for(const pid of [middle.pid,middle.ping]){const ref=ProcessRef.open(pid);if(ref){middleRefs.push(ref);refs.push(ref);}}
      const nextBytes=await Bun.file(images[2]).arrayBuffer(),next={version:'0.0.1+3',size:nextBytes.byteLength,sha256:new Bun.CryptoHasher('sha256').update(nextBytes).digest('hex')};await stageUpdate(root,images[2],next);
      const send=async(api=false)=>{
        const script=join(base,'next.ts');
        await writeFile(script,`import{ProcessRef}from ${module('../../../bridge/src/platform/win32/job.ts')};import{writePrivateFile}from ${module('../08-runtime-integration/private-fs.ts')};const fs=require('node:fs'),root=${JSON.stringify(root)},metadata=fs.readFileSync(root+'/supervisor.txt','utf8').trim().split('\\n'),self=ProcessRef.open(process.pid),nonce=crypto.randomUUID().replaceAll('-','');writePrivateFile(root+'/update-'+metadata[2],JSON.stringify({schema:1,helperProtocol:1,installationId:${JSON.stringify(installed.id)},nonce,...${JSON.stringify(next)},callerPid:process.pid,callerCreated:String(self.created)}));self.close();console.log(nonce);`,'utf8');
        if(api)await writeFile(script,`import{assertUpdateSupport,requestUpdate}from ${module('./request-update.ts')};await assertUpdateSupport(${JSON.stringify(root)});console.log((await requestUpdate(${JSON.stringify(root)},${JSON.stringify(next)})).nonce);`,'utf8');
        const result=await run([process.execPath,script]);expect(result.code).toBe(0);return result.stdout.trim();
      };
      const previous=join(root,'bin/previous/coderail.exe');await writeFile(previous,'tampered');const denied=await send();
      await until(()=>existsSync(join(root,'update-error-'+denied+'.txt')),10000,'Modified previous generation rejected before stopping current Bridge');
      expect(middleRefs.every(ref=>ref.alive())).toBe(true);expect(readInstallation(root)?.version).toBe('0.0.1+2');
      await writeFile(previous,await readFile(images[0]));let second=await send(true);
      if(repeatCrash){
        await until(()=>!rootRef!.alive(),15000,'Actual crash after pruning older backup file');delete process.env.CODERAIL_POC_UPDATE_CRASH;
        await service.start(spec);const resumed=await service.status(spec);
        await until(async()=>{try{const state=JSON.parse(await readFile(join(root,'state.json'),'utf8'));return state.pid===resumed.childPid&&state.version==='0.0.1+2';}catch{return false;}},10000,'Previously committed generation stays usable after backup prune crash');
        expect(readInstallation(root)?.version).toBe('0.0.1+2');expect(existsSync(previous)).toBe(false);
        const restored=JSON.parse(await readFile(join(base,'v2.json'),'utf8'));for(const pid of [restored.pid,restored.ping]){const ref=ProcessRef.open(pid);if(ref){middleRefs.push(ref);refs.push(ref);}}
        second=await send(true);
      }
      await until(()=>existsSync(join(root,'update-result-'+second)),15000,'Second update prunes only the hash-verified older backup');
      expect(JSON.parse(await readFile(join(root,'update-result-'+second),'utf8')).status).toBe('committed');expect(readInstallation(root)?.version).toBe('0.0.1+3');
      expect((await run([previous,'version'])).stdout.trim()).toBe('0.0.1+2');
      await until(()=>middleRefs.every(ref=>!ref.alive()),10000,'Intermediate generation Job drained');
      if(repeatCrash)expect((await service.status(spec)).pid).not.toBe(before.pid);else expect((await service.status(spec)).pid).toBe(before.pid);
      if(mode==='healthy'){
        await service.stop(spec);const journalPath=join(root,'update.json'),journal=await readFile(journalPath,'utf8');
        writePrivateFile(journalPath,JSON.stringify({...JSON.parse(journal),schema:2}));
        await expect(service.start(spec)).rejects.toThrow('startup');expect(readInstallation(root)?.version).toBe('0.0.1+3');
        writePrivateFile(journalPath,journal);await service.start(spec);
      }
    }
    console.log(JSON.stringify({persistentRoot:true,callerInsideOldBridgeJob:true,oldJobRemaining:0,healthy,update:result.status}));
  }catch(cause){
    for(const name of ['supervisor-error.txt','bridge.log'])if(existsSync(join(root,name)))console.error(JSON.stringify({name,text:(await readFile(join(root,name),'utf8')).slice(-8192)}));throw cause;
  }finally{
    await service.stop(spec);rootRef?.close();for(const ref of refs)ref.close();for(const [key,value]of Object.entries(previousEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    if(!contains(realpathSync.native(tmpdir()),realpathSync.native(base)))throw new Error('Unsafe cleanup');await retry(()=>rm(base,{recursive:true}));
  }
},45000);
