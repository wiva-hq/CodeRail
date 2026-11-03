// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {win32 as p} from 'node:path';
import {NativeFile} from './native';
import {error} from './paths';
import {ProcessRef} from './job';
import {guardInstallationRoot,readInstallation} from './install-files';
import type {UpdateArtifact} from './update-stage';

function host(root:string,directory:NativeFile) {
  const file=directory.child('supervisor.txt',false);let metadata:string[];
  try{metadata=file.read(root,16384).toString('utf8').trim().split('\n');}finally{file.close();}
  const [pid,,nonce,created,protocol]=metadata;
  if(!/^\d+$/.test(pid)||!/^[a-f0-9]{32}$/.test(nonce)||!/^\d+$/.test(created))throw error('EINVAL','Invalid supervisor identity');
  if(protocol!=='1')throw error('ENOTSUP','This supervisor does not support safe updates; reinstall the current Windows package');
  const ref=ProcessRef.open(Number(pid));
  if(!ref||!ref.alive()||String(ref.created)!==created){ref?.close();throw error('ESRCH','A live owned supervisor is required');}
  return {ref,nonce};
}
export async function assertUpdateSupport(input:string) {
  const root=await guardInstallationRoot(input),directory=new NativeFile(root,true);
  try{const current=host(root,directory);current.ref.close();}finally{directory.close();}
}
export async function requestUpdate(input:string,artifact:UpdateArtifact) {
  const root=await guardInstallationRoot(input),installed=readInstallation(root);
  if(!installed||!/^\d+\.\d+\.\d+\+\d+$/.test(artifact.version)||!/^[a-f0-9]{64}$/.test(artifact.sha256)||!Number.isSafeInteger(artifact.size)||artifact.size<64||artifact.size>1024*1024*1024)throw error('EINVAL','Invalid owned update artifact');
  const directory=new NativeFile(root,true);let current:ReturnType<typeof host>|undefined,caller:ProcessRef|null=null,slot:NativeFile|undefined;
  try{
    current=host(root,directory);caller=ProcessRef.open(process.pid);if(!caller)throw error('ESRCH','Cannot pin updater caller');
    // Exclusive create prevents concurrent clients from overwriting each other's
    // unconsumed request. The supervisor consumes this native file before ack.
    slot=directory.child('update-'+current.nonce,false,true,true);
    const nonce=crypto.randomUUID().replaceAll('-','');
    const request={schema:1,helperProtocol:1,installationId:installed.id,nonce,version:artifact.version,sha256:artifact.sha256,size:artifact.size,callerPid:process.pid,callerCreated:String(caller.created)};
    slot.write(Buffer.from(JSON.stringify(request),'utf8'));slot.close();slot=undefined;
    const read=(name:string)=>{const file=directory.child(name,false);try{return file.read(root,16384).toString('utf8');}finally{file.close();}};
    const deadline=performance.now()+15000;
    while(performance.now()<deadline){
      try{throw error('EIO',read('update-error-'+nonce+'.txt'));}catch(cause:any){if(cause.code!=='ENOENT')throw cause;}
      try{
        const value=JSON.parse(read('update-ready-'+nonce));
        if(value.status!=='accepted'||value.nonce!==nonce)throw error('EINVAL','Invalid update acknowledgement');
        return {status:'update-scheduled',nonce,version:artifact.version,root};
      }catch(cause:any){if(cause.code!=='ENOENT')throw cause;}
      if(!current.ref.alive())throw error('ESRCH','Supervisor exited before acknowledging update; inspect update journal');
      await Bun.sleep(25);
    }
    throw error('ETIMEDOUT','Update acknowledgement unknown; inspect update-result/update-error before retrying');
  }finally{
    if(slot){try{slot.unlink();}finally{slot.close();}}
    caller?.close();current?.ref.close();directory.close();
  }
}
