// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {existsSync} from 'node:fs';
import {win32 as p} from 'node:path';
import {homedir} from 'node:os';
import {NativeFile} from '../04-filesystem/native';
import {error} from '../04-filesystem/paths';
import {writePrivateFile} from '../08-runtime-integration/private-fs';
import {guardInstallationRoot,readInstallation} from '../09-user-service/install-files';
import {UserService} from '../09-user-service/service';
import type {stageUpdate} from '../09-user-service/update-stage';

/** File-switch PoC only. The persistent supervisor must eventually own this
 * transaction; a command inside the old Bridge Job must never orchestrate it. */
export async function activateFiles(input:string, staged:Awaited<ReturnType<typeof stageUpdate>>, health:(executable:string,version:string)=>Promise<void>, afterStep?:(step:string)=>void) {
  const root=await guardInstallationRoot(input),old=readInstallation(root);
  if(!old||staged.installationId!==old.id||staged.previous!==old.executable||staged.executable!==p.join(root,'updates',staged.sha256,'coderail.exe')||!/^[a-f0-9]{64}$/.test(staged.sha256)||!/^\d+\.\d+\.\d+\+\d+$/.test(staged.version)||!Number.isSafeInteger(staged.size)||staged.size<64||staged.size>1024*1024*1024)throw error('EINVAL','Update ownership or artifact metadata mismatch');
  const state=await new UserService().status({command:[],home:homedir(),stateDir:root,logPath:p.join(root,'bridge.log')});
  if(state.running)throw error('EBUSY','File-only PoC cannot stop or replace a running supervisor');
  const directory=new NativeFile(root,true),leases:NativeFile[]=[directory];
  let oldMoved=false,newMoved=false;
  const save=(status:string)=>writePrivateFile(p.join(root,'update.json'),JSON.stringify({schema:1,installationId:old.id,status,old,staged},null,2));
  try {
    const bin=directory.child('bin',true);leases.push(bin);
    if(existsSync(p.join(root,'bin/previous')))throw error('EEXIST','Previous generation must be reconciled before another update');
    const updates=directory.child('updates',true);leases.push(updates);
    const incoming=updates.child(staged.sha256,true,false,true),current=bin.child('current',true,false,true);leases.push(incoming,current);
    for(const folder of [incoming,current])if(folder.entries().some(entry=>entry.name!=='coderail.exe'))throw error('EACCES','Unknown file in binary generation');
    const verify=(parent:NativeFile,expectedHash:string,size?:number)=>{
      const file=parent.child('coderail.exe',false);
      try {
        const length=file.details().size;
        if(length<64||length>1024*1024*1024||size!==undefined&&length!==size)throw error('EINVAL','Generation size mismatch');
        const bytes=file.read(root,length);
        if(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')!==expectedHash)throw error('EACCES','Generation bytes changed before activation');
      }finally{file.close();}
    };
    verify(current,old.sha256);verify(incoming,staged.sha256,staged.size);
    save('prepared');
    afterStep?.('prepared');
    try {
      current.renameTo(bin,'previous',false);oldMoved=true;afterStep?.('old-renamed');save('old-moved');afterStep?.('old-moved');
      incoming.renameTo(bin,'current',false);newMoved=true;afterStep?.('candidate-renamed');save('candidate-active');afterStep?.('candidate-active');
      await health(old.executable,staged.version);
      writePrivateFile(p.join(root,'installation.json'),JSON.stringify({...old,version:staged.version,sha256:staged.sha256},null,2));
      afterStep?.('marker-updated');
      save('committed');
      return {version:staged.version,executable:old.executable,previous:p.join(root,'bin/previous/coderail.exe')};
    }catch(failure){
      const failures:unknown[]=[failure];
      try {
        if(newMoved){incoming.renameTo(updates,staged.sha256,false);newMoved=false;}
        if(oldMoved){current.renameTo(bin,'current',false);oldMoved=false;}
        writePrivateFile(p.join(root,'installation.json'),JSON.stringify(old,null,2));save('rolled-back');
      }catch(cause){failures.push(cause);}
      if(failures.length>1)throw new AggregateError(failures,'Update failed and file rollback requires recovery');
      throw failure;
    }
  }finally{for(const lease of leases.reverse())lease.close();}
}
