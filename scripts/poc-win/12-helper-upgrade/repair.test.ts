// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {baseline,until} from '../common';
import {run} from '../../../bridge/src/platform/win32/process';
import {installPrepared} from '../../../bridge/src/platform/win32/install-transaction';
import {UserService} from '../../../bridge/src/platform/win32/service';
import {UserAutorun} from '../../../bridge/src/platform/win32/autorun';
import {UserEnvironmentValue} from '../../../bridge/src/platform/win32/user-path';
import {unregisterInstallation} from '../../../bridge/src/platform/win32/uninstall-registration';
import {captureTree,ProcessRef,snapshot} from '../../../bridge/src/platform/win32/job';
import {contains} from '../../../bridge/src/platform/win32/paths';
import {writePrivateFile} from '../../../bridge/src/platform/win32/private-fs';
import {repairHelper,recoverHelper} from './repair';
baseline();
const sha=(bytes:Uint8Array)=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

test('outside-tree helper repair: live handoff, bad helper rollback and real crash recovery preserve pairing/registry',async()=>{
  const base=realpathSync.native(tmpdir()),dir=await mkdtemp(join(base,'crh-')),root=join(dir,'CodeRail 中文😀');
  const startup=new UserAutorun('CodeRail-PoC-'+crypto.randomUUID()),environment=new UserEnvironmentValue('CodeRail-PoC-'+crypto.randomUUID());
  const service=new UserService(startup),spec={stateDir:root,command:[] as string[],home:dir,logPath:join(root,'bridge.log')};
  const oldGlobal=globalThis.__CODERAIL_SUPERVISOR__;let installed=false;const refs:ProcessRef[]=[];
  const compiler=join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  const compile=async(out:string,sources:string[],extra:string[]=[])=>{const result=await run([compiler,'/nologo','/platform:x64','/r:System.Web.Extensions.dll','/out:'+out,...extra,...sources],{timeout:60000});if(result.code)throw new Error(result.stdout+result.stderr);};
  try{
    const supervisor=(await readFile(join(import.meta.dir,'../../../bridge/src/platform/win32/supervisor.cs'),'utf8'));
    const anchor=String.raw`ToFileTimeUtc()+"\n1\n"`;
    expect(supervisor.includes(anchor)).toBe(true);
    const images:string[]=[];
    for(const tag of ['old','new']){
      const source=join(dir,tag+'.cs'),image=join(dir,tag+'.exe');await writeFile(source,supervisor.replace(anchor,String.raw`ToFileTimeUtc()+"\n1\n${tag}\n"`));
      await compile(image,[source,...['cleanup.cs','update.cs','owned-log.cs','startup.cs'].map(name=>join(import.meta.dir,'../../../bridge/src/platform/win32',name))],['/target:winexe','/main:Supervisor']);images.push(image);
    }
    const fixture=join(dir,'bridge.cs'),binary=join(dir,'bridge.exe');
    const args=[join(import.meta.dir,'repair-worker.ts'),root,images[1],startup.name,'inside'].map(value=>'"'+value+'"').join(' ');
    await writeFile(fixture,`using System;using System.IO;using System.Threading;using System.Diagnostics;class Bridge{static void Main(){var child=Process.Start(new ProcessStartInfo("ping.exe","-t 127.0.0.1"){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true});Console.WriteLine("中文后台😀");bool launched=false;while(!File.Exists(Environment.GetEnvironmentVariable("CODERAIL_STOP_FILE"))){if(!launched&&File.Exists(${JSON.stringify(join(root,'request-inside'))})){launched=true;Process.Start(new ProcessStartInfo(${JSON.stringify(process.execPath)},${JSON.stringify(args)}){UseShellExecute=false,CreateNoWindow=true});}Thread.Sleep(20);}}}`);
    await compile(binary,[fixture],['/target:exe']);globalThis.__CODERAIL_SUPERVISOR__=images[0];
    const record=await installPrepared(root,binary,'0.0.1+1',{startup,environment});installed=true;globalThis.__CODERAIL_SUPERVISOR__=oldGlobal;
    spec.command=[record.installed.executable,'run'];writePrivateFile(join(root,'config.json'),JSON.stringify({server:'https://example.invalid',machineId:'retained',token:crypto.randomUUID()}));
    const config=await readFile(join(root,'config.json')),beforeStartup=startup.read(),beforePath=environment.read();
    await service.start(spec);const old=await service.status(spec);refs.push(ProcessRef.open(old.pid!)!);
    await until(()=>snapshot().some(row=>row.parentPid===old.childPid&&row.name.toLowerCase()==='ping.exe'));
    refs.push(...captureTree(refs[0],snapshot()));expect(refs.length).toBeGreaterThanOrEqual(3);
    const candidate=await readFile(images[1]),hash=sha(candidate);
    await expect(repairHelper(root,candidate,'0'.repeat(64),{startup})).rejects.toMatchObject({code:'EINVAL'});
    expect((await service.status(spec)).pid).toBe(old.pid!);
    writePrivateFile(join(root,'request-inside'),'go');await until(()=>Bun.file(join(root,'inside-result.json')).exists());
    expect((await Bun.file(join(root,'inside-result.json')).json()).refused).toBe(true);
    expect((await service.status(spec)).pid).toBe(old.pid!);
    expect((await repairHelper(root,candidate,hash,{startup})).status).toBe('committed');
    expect(refs.every(ref=>!ref.alive())).toBe(true);
    expect((await readFile(join(root,'supervisor.txt'),'utf8')).trim().split('\n')[5]).toBe('new');
    expect(await readFile(join(root,'config.json'))).toEqual(config);expect(startup.read()).toBe(beforeStartup);expect(environment.read()).toEqual(beforePath);
    const badSource=join(dir,'bad.cs'),bad=join(dir,'bad.exe');await writeFile(badSource,'class Broken{static int Main(){return 23;}}');await compile(bad,[badSource],['/target:winexe']);const badBytes=await readFile(bad);
    await expect(repairHelper(root,badBytes,sha(badBytes),{startup})).rejects.toThrow();
    expect(sha(await readFile(join(root,'supervisor.exe')))).toBe(hash);expect((await service.status(spec)).running).toBe(true);
    for(const boundary of ['prepared','stopped','active']){
      const crash=await run([process.execPath,join(import.meta.dir,'repair-worker.ts'),root,images[0],startup.name,boundary],{timeout:30000});expect(crash.code).toBe(42);
      expect(JSON.parse(await readFile(join(root,'helper-repair.json'),'utf8')).status).toBe(boundary);
      if(boundary==='active'){
        const backup=join(root,'helper.previous.exe');writePrivateFile(backup,Buffer.from('tampered'));
        await expect(recoverHelper(root,startup)).rejects.toThrow();
        expect(JSON.parse(await readFile(join(root,'helper-repair.json'),'utf8')).status).toBe('active');
        writePrivateFile(backup,candidate);
      }
      expect((await recoverHelper(root,startup)).status).toBe('rolled-back');
      expect((await recoverHelper(root,startup)).status).toBe('rolled-back');
    }
    expect(sha(await readFile(join(root,'supervisor.exe')))).toBe(hash);expect((await service.status(spec)).running).toBe(true);
    expect(await readFile(join(root,'config.json'))).toEqual(config);expect(startup.read()).toBe(beforeStartup);expect(environment.read()).toEqual(beforePath);
    console.log(JSON.stringify({outsideTreeHelperReplacement:true,oldProcessesExited:true,nestedPingExited:true,insideTreeCallerRefused:true,failedCandidateRestored:true,actualRepairProcessExit:42,journalRecovery:true,pairingAndRegistryPreserved:true,remoteInsideTreeMigration:false}));
  }finally{
    globalThis.__CODERAIL_SUPERVISOR__=oldGlobal;await service.stop(spec);for(const ref of refs)ref?.close();
    if(installed)await unregisterInstallation(root,{startup,environment});
    if(!contains(base,realpathSync.native(dir)))throw new Error('Unsafe helper repair cleanup');await rm(dir,{recursive:true});
  }
},90000);
