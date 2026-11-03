// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { link, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { UserService } from '../../../bridge/src/platform/win32/service';
import { run } from '../../../bridge/src/platform/win32/process';
import { contains } from '../../../bridge/src/platform/win32/paths';
import { LogTail } from '../../../bridge/src/platform/win32/logs';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';
import { artifacts, baseline, until } from '../common';
baseline();

for (const failureMode of [false, true]) test(`supervisor pipe rotation, unsafe backup=${failureMode}`, async () => {
  const base=realpathSync.native(artifacts),root=await mkdtemp(join(base,'log-pipe-中文😀-'));
  const service=new UserService(),entry=join(root,'fixture.ts'),done=join(root,'done'),source=join(root,'supervisor.cs'),exe=join(root,'supervisor.exe');
  const spec={stateDir:root,command:[process.execPath,entry],home:root,logPath:join(root,'bridge.log')};
  try {
    let text=(await readFile(join(import.meta.dir,'../../../bridge/src/platform/win32/supervisor.cs'),'utf8')).replaceAll('\r\n','\n');
    const replace=(before:string,after:string)=>{if(!text.includes(before))throw new Error('Candidate supervisor source anchor changed: '+before);text=text.replace(before,after);};
    // Lower only the limit in a private build; runtime ownership/control is production code.
    replace('new NativeLogPipe(state,10*1024*1024)','new NativeLogPipe(state,1024)');
    await writeFile(source,text,'utf8');
    const compiler=join(process.env.SystemRoot!,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const build=await run([compiler,'/nologo','/target:winexe','/platform:x64','/r:System.Web.Extensions.dll','/main:Supervisor','/out:'+exe,source,join(import.meta.dir,'../../../bridge/src/platform/win32/owned-log.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/startup.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/cleanup.cs'),join(import.meta.dir,'../../../bridge/src/platform/win32/update.cs')],{timeout:60000});
    expect(build.code).toBe(0);
    await writeFile(entry,`for(let i=0;i<4000;i++){process.stdout.write(i+':中文😀 stdout\\n');process.stderr.write(i+':错误😀 stderr\\n');}await Bun.write(${JSON.stringify(done)},'done');let failed=false;setInterval(()=>{if(require('fs').existsSync(${JSON.stringify(join(root,'fail'))})&&!failed){failed=true;process.stdout.write('trigger rotation '.repeat(1000));}if(require('fs').existsSync(process.env.CODERAIL_STOP_FILE))process.exit(0)},20);`);
    await service.start(spec);await until(()=>Bun.file(done).exists());
    await until(async()=>{try{return (await readFile(spec.logPath,'utf8')).includes('3999:错误😀 stderr');}catch{return false;}});
    expect((await service.status(spec)).running).toBe(true);
    const current=await readFile(spec.logPath),backup=await readFile(spec.logPath+'.1');
    expect(current.length).toBeLessThanOrEqual(1024);expect(backup.length).toBeLessThanOrEqual(1024);
    expect(new TextDecoder('utf8',{fatal:true}).decode(Buffer.concat([backup,current]))).toContain('3999:错误😀 stderr');
    const tail=new LogTail(root);expect(tail.poll()).toContain('3999:错误😀 stderr');
    if(failureMode){
      const status=await service.status(spec),ref=ProcessRef.open(status.childPid!)!,outside=join(root,'outside.txt');
      try {
        await writeFile(outside,'untouched');await rm(spec.logPath+'.1');await link(outside,spec.logPath+'.1');
        await writeFile(join(root,'fail'),'go');
        await until(async()=>!(await service.status(spec)).running,15000,'Fail closed after unsafe log backup');
        await until(()=>!ref.alive());
        expect(await readFile(outside,'utf8')).toBe('untouched');
        expect(await readFile(join(root,'supervisor-error.txt'),'utf8')).toContain('Log pipe failed');
        console.log(JSON.stringify({unsafeBackup:true,serviceFailedClosed:true,commandJobDrained:true,outsideUntouched:true}));
      } finally {ref.close();}
      return;
    }
    await service.stop(spec);expect((await service.status(spec)).running).toBe(false);
    expect(await Bun.file(join(root,'supervisor-error.txt')).exists()).toBe(false);
    console.log(JSON.stringify({livePipeRotation:true,stdoutStderr:true,utf8:true,childKeptHandlesOpen:true,jobAndPipeDrained:true}));
  } finally {
    await service.stop(spec);
    if(!contains(base,realpathSync.native(root)))throw new Error('Unsafe pipe cleanup');await rm(root,{recursive:true});
  }
},60000);
