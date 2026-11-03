// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {mkdtemp,readFile,rename,rm,symlink,writeFile} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {join} from 'node:path';
import {artifacts,baseline,until} from '../common';
import {run} from '../../../bridge/src/platform/win32/process';
import {deployBinary} from '../../../bridge/src/platform/win32/install-files';
import {UserService} from '../../../bridge/src/platform/win32/service';
import {UserAutorun} from '../../../bridge/src/platform/win32/autorun';
import {quoteArgument,launch} from '../../../bridge/src/platform/win32/launcher';
import {contains} from '../../../bridge/src/platform/win32/paths';
baseline();

test('self-located installed startup reduces Run length and rejects tampering/Junction before launch',async()=>{
  const base=realpathSync.native(artifacts),dir=await mkdtemp(join(base,'installed-startup-中文😀-')),root=join(dir,'CodeRail');
  const startup=new UserAutorun('CodeRail-PoC-'+crypto.randomUUID()),service=new UserService(startup);
  const spec={stateDir:root,command:[] as string[],home:dir,logPath:join(root,'bridge.log')};let registered:string|undefined,child:ReturnType<typeof launch>|undefined;
  try{
    const fixture=join(dir,'bridge.cs'),binary=join(dir,'bridge.exe'),source=join(dir,'supervisor.cs');
    const compiler=join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const compile=async(out:string,sources:string[],extra:string[]=[])=>{const result=await run([compiler,'/nologo','/platform:x64','/r:System.Web.Extensions.dll','/out:'+out,...extra,...sources],{timeout:60000});if(result.code)throw new Error(result.stdout+result.stderr);};
    await writeFile(fixture,'using System;using System.IO;using System.Threading;class Bridge{static void Main(){File.WriteAllText(Path.Combine(Environment.GetEnvironmentVariable("CODERAIL_HOME"),"child-ready"),Environment.GetCommandLineArgs()[1]);while(!File.Exists(Environment.GetEnvironmentVariable("CODERAIL_STOP_FILE")))Thread.Sleep(20);}}');
    await compile(binary,[fixture],['/target:exe']);const installed=await deployBinary(root,binary,'0.0.1+1');
    let text=(await readFile(join(import.meta.dir,'../../../bridge/src/platform/win32/supervisor.cs'),'utf8')).replaceAll('\r\n','\n');
    await writeFile(source,text);const helper=join(root,'supervisor.exe');
    await compile(helper,[source,...['cleanup.cs','update.cs','owned-log.cs','startup.cs'].map(name=>join(import.meta.dir,'../../../bridge/src/platform/win32',name))],['/target:winexe','/main:Supervisor']);
    const legacy=[helper,root,installed.executable,'run'].map(quoteArgument).join(' '),short=[helper,'--installed'].map(quoteArgument).join(' ');
    expect(legacy.length).toBeGreaterThan(260);expect(short.length).toBeLessThanOrEqual(260);
    expect(()=>startup.install(legacy)).toThrow('260-character');startup.install(short);registered=short;expect(startup.read()).toBe(short);
    child=launch([helper,'--installed'],dir);
    try{await until(async()=>{if(!child!.alive())throw new Error(await Bun.file(join(root,'supervisor-error.txt')).text());return Bun.file(join(root,'child-ready')).exists();},5000);}
    catch(cause){console.error(JSON.stringify({identity:await Bun.file(join(root,'supervisor.txt')).text().catch(()=>null),log:await Bun.file(spec.logPath).text().catch(()=>null),error:await Bun.file(join(root,'supervisor-error.txt')).text().catch(()=>null)}));throw cause;}
    expect(await Bun.file(join(root,'child-ready')).text()).toBe('run');expect((await service.status(spec)).running).toBe(true);
    await service.stop(spec);await until(()=>!child!.alive());child.dispose();child=undefined;await rm(join(root,'child-ready'));
    const original=await readFile(installed.executable);await writeFile(installed.executable,Buffer.concat([original,Buffer.from('tampered')]));
    child=launch([helper,'--installed'],dir);await until(()=>!child!.alive());child.dispose();child=undefined;
    expect(await Bun.file(join(root,'child-ready')).exists()).toBe(false);expect(await readFile(join(root,'supervisor-error.txt'),'utf8')).toContain('SHA256 mismatch');
    await writeFile(installed.executable,original);await rm(join(root,'supervisor-error.txt'));
    const current=join(root,'bin/current'),safe=join(root,'bin/safe');await rename(current,safe);await symlink(safe,current,'junction');
    child=launch([helper,'--installed'],dir);await until(()=>!child!.alive());child.dispose();child=undefined;
    expect(await Bun.file(join(root,'child-ready')).exists()).toBe(false);expect(await readFile(join(root,'supervisor-error.txt'),'utf8')).toContain('Reparse');
    await rm(current);await rename(safe,current);
    console.log(JSON.stringify({selfLocatedStartup:true,legacyChars:legacy.length,shortChars:short.length,realRunValueReadback:true,tamperedImageRejected:true,junctionRejected:true,realRelog:false}));
  }finally{
    await service.stop(spec);child?.dispose();if(registered)startup.uninstall(registered);
    if(!contains(base,realpathSync.native(dir)))throw new Error('Unsafe startup cleanup');await rm(dir,{recursive:true});
  }
},60000);
