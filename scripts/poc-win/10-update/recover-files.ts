// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {win32 as p} from 'node:path';
import {homedir} from 'node:os';
import {NativeFile} from '../04-filesystem/native';
import {error} from '../04-filesystem/paths';
import {writePrivateFile} from '../08-runtime-integration/private-fs';
import {guardInstallationRoot,readInstallation} from '../09-user-service/install-files';
import {UserService} from '../09-user-service/service';

/** Reconcile actual hash-verified layout, including a crash between a rename
 * and its journal update. Never infer completion from the last journal label. */
export async function recoverFiles(input:string) {
  const root=await guardInstallationRoot(input),installed=readInstallation(root);
  if(!installed)throw error('EACCES','Owned installation required');
  if((await new UserService().status({command:[],home:homedir(),stateDir:root,logPath:p.join(root,'bridge.log')})).running)throw error('EBUSY','Stop the owned service before file recovery');
  const directory=new NativeFile(root,true),leases:NativeFile[]=[directory];
  try {
    const file=directory.child('update.json',false);let journal:any;
    try{if(file.details().size>131072)throw error('EINVAL','Update journal too large');journal=JSON.parse(file.read(root,131072).toString('utf8'));}finally{file.close();}
    const old=journal.old,next=journal.staged,exe=p.join(root,'bin/current/coderail.exe');
    const version=(v:unknown)=>typeof v==='string'&&/^\d+\.\d+\.\d+\+\d+$/.test(v),sha=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
    if(journal.schema!==1||journal.installationId!==installed.id||!['prepared','old-moved','candidate-active','committed','rolled-back'].includes(journal.status)||!old||old.schema!==1||old.id!==installed.id||old.root!==root||old.executable!==exe||!sha(old.sha256)||!version(old.version)||!next||next.installationId!==old.id||next.previous!==exe||!sha(next.sha256)||!version(next.version)||next.executable!==p.join(root,'updates',next.sha256,'coderail.exe')||!Number.isSafeInteger(next.size)||next.size<64||next.size>1024*1024*1024)throw error('EINVAL','Update journal ownership or metadata mismatch');
    if(installed.executable!==exe||!(installed.sha256===old.sha256&&installed.version===old.version||installed.sha256===next.sha256&&installed.version===next.version))throw error('EACCES','Installation marker does not belong to this update');
    const bin=directory.child('bin',true),updates=directory.child('updates',true);leases.push(bin,updates);
    const open=(parent:NativeFile,name:string)=>{
      try{const result=parent.child(name,true,false,true);leases.push(result);return result;}
      catch(cause:any){if(cause.code==='ENOENT')return null;throw cause;}
    };
    const current=open(bin,'current'),previous=open(bin,'previous'),stage=open(updates,next.sha256);
    const hash=(folder:NativeFile|null)=>{
      if(!folder)return null;
      if(folder.entries().some(entry=>entry.name!=='coderail.exe'))throw error('EACCES','Unknown file in update generation');
      const image=folder.child('coderail.exe',false);
      try{const size=image.details().size;if(size<64||size>1024*1024*1024)throw error('EINVAL','Invalid generation size');return {sha256:new Bun.CryptoHasher('sha256').update(image.read(root,size)).digest('hex'),size};}
      finally{image.close();}
    };
    const c=hash(current),previousHash=hash(previous),s=hash(stage);
    const oldAt=(value:ReturnType<typeof hash>)=>value?.sha256===old.sha256;
    const newAt=(value:ReturnType<typeof hash>)=>value?.sha256===next.sha256&&value?.size===next.size;
    if(journal.status==='committed'){
      if(!newAt(c)||!oldAt(previousHash)||stage||installed.sha256!==next.sha256||installed.version!==next.version)throw error('EACCES','Committed update layout was modified');
      return {status:'committed',changed:false};
    }
    if(oldAt(c)&&!previous&&newAt(s)){
      // Prepared, already rolled back, or a crash after restoration but before save.
    }else if(!current&&oldAt(previousHash)&&newAt(s)){
      previous!.renameTo(bin,'current',false);
    }else if(newAt(c)&&oldAt(previousHash)&&!stage){
      current!.renameTo(updates,next.sha256,false);previous!.renameTo(bin,'current',false);
    }else throw error('EACCES','Ambiguous or modified update layout; recovery will not overwrite it');
    writePrivateFile(p.join(root,'installation.json'),JSON.stringify(old,null,2));
    writePrivateFile(p.join(root,'update.json'),JSON.stringify({...journal,status:'rolled-back'},null,2));
    return {status:'rolled-back',changed:true};
  }finally{for(const lease of leases.reverse())lease.close();}
}
