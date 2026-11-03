// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { win32 as p } from 'node:path';
import { NativeFile } from '../../../bridge/src/platform/win32/native';
import { registrationJournal } from '../../../bridge/src/platform/win32/install-recovery';
import { writePrivateFile } from '../../../bridge/src/platform/win32/private-fs';
import { captureTree, ProcessRef, snapshot } from '../../../bridge/src/platform/win32/job';
import { UserService } from '../../../bridge/src/platform/win32/service';
import { UserAutorun } from '../../../bridge/src/platform/win32/autorun';
import { error } from '../../../bridge/src/platform/win32/paths';

const hash=(bytes:Uint8Array)=>new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
function image(bytes:Buffer){
  if(bytes.length<64||bytes.length>1024*1024||bytes.toString('ascii',0,2)!=='MZ')throw error('EINVAL','Invalid helper image size/header');
  const pe=bytes.readUInt32LE(0x3c);
  if(pe+6>bytes.length||bytes.readUInt32LE(pe)!==0x4550||bytes.readUInt16LE(pe+4)!==0x8664)throw error('EINVAL','Helper must be x64 PE');
}
function read(dir:NativeFile,root:string,name:string){const file=dir.child(name,false);try{if(file.details().size>1024*1024)throw error('EFBIG','Helper recovery file too large');return file.read(root,1024*1024);}finally{file.close();}}
async function context(input:string,startup:UserAutorun){
  const state=await registrationJournal(input,['registered-unpaired']);
  if(startup.read()!==state.command)throw error('EACCES','Startup ownership changed; refusing helper repair');
  const spec={stateDir:state.root,command:[state.installed.executable,'run'],home:process.env.USERPROFILE!,logPath:p.join(state.root,'bridge.log')};
  return {...state,spec,service:new UserService(startup)};
}
async function refuseInsideTree(state:Awaited<ReturnType<typeof context>>){
  const status=await state.service.status(state.spec);if(!status.running)return false;
  const ref=ProcessRef.open(status.pid!);if(!ref)return false;
  const dir=new NativeFile(state.root,true);let children:ProcessRef[]=[];
  try{
    const identity=read(dir,state.root,'supervisor.txt').toString('utf8').trim().split('\n');
    if(Number(identity[0])!==ref.pid||identity[3]!==String(ref.created))throw error('EAGAIN','Service identity changed before helper repair');
    children=captureTree(ref,snapshot());
    if(ref.pid===process.pid||children.some(child=>child.pid===process.pid))throw error('EACCES','Run helper repair from a local terminal outside the Bridge process tree');
    return true;
  }finally{for(const child of children)child.close();ref.close();dir.close();}
}
function lock(dir:NativeFile){
  try{return dir.child('helper-repair.lock',false,false,true,0);}
  catch(cause:any){if(cause.code!=='ENOENT')throw cause;return dir.child('helper-repair.lock',false,true,true,0);}
}
async function healthy(state:Awaited<ReturnType<typeof context>>){
  await state.service.start(state.spec);await Bun.sleep(300);
  const status=await state.service.status(state.spec),ref=status.running?ProcessRef.open(status.childPid!):null;
  try{if(!ref?.alive())throw error('EIO','Replacement helper did not keep its Bridge child alive');}finally{ref?.close();}
}

/** PoC: caller must be outside the owned command tree. Does not migrate a live remote CLI. */
export async function repairHelper(input:string,candidate:Uint8Array,sha256:string,options:{startup:UserAutorun;step?:(label:string)=>void}){
  const bytes=Buffer.from(candidate);image(bytes);
  if(!/^[a-f0-9]{64}$/.test(sha256)||hash(bytes)!==sha256)throw error('EINVAL','Helper SHA256 mismatch');
  const state=await context(input,options.startup),wasRunning=await refuseInsideTree(state),dir=new NativeFile(state.root,true);
  let lease:NativeFile|undefined;
  try{
    lease=lock(dir);
    try{const prior=JSON.parse(read(dir,state.root,'helper-repair.json').toString('utf8'));if(!['committed','rolled-back'].includes(prior.status))throw error('EEXIST','Recover the pending helper repair first');}catch(cause:any){if(cause.code!=='ENOENT')throw cause;}
    const previous=read(dir,state.root,'supervisor.exe');image(previous);
    const journal={schema:1,installationId:state.installed.id,root:state.root,previous:hash(previous),candidate:sha256,wasRunning,status:'prepared'};
    const save=(status:string)=>writePrivateFile(p.join(state.root,'helper-repair.json'),JSON.stringify({...journal,status}));
    writePrivateFile(p.join(state.root,'helper.previous.exe'),previous);save('prepared');options.step?.('prepared');
    try{
      await state.service.stop(state.spec);save('stopped');options.step?.('stopped');
      writePrivateFile(p.join(state.root,'supervisor.exe'),bytes);save('active');options.step?.('active');
      if(wasRunning)await healthy(state);
      save('committed');return {status:'committed',wasRunning,sha256};
    }catch(cause){
      await state.service.stop(state.spec);writePrivateFile(p.join(state.root,'supervisor.exe'),previous);
      if(wasRunning)await healthy(state);save('rolled-back');throw cause;
    }
  }finally{if(lease){try{lease.unlink();}finally{lease.close();}}dir.close();}
}

export async function recoverHelper(input:string,startup:UserAutorun){
  const state=await context(input,startup);await refuseInsideTree(state);
  const dir=new NativeFile(state.root,true);let lease:NativeFile|undefined;
  try{
    lease=lock(dir);const journal=JSON.parse(read(dir,state.root,'helper-repair.json').toString('utf8'));
    if(journal.schema!==1||journal.installationId!==state.installed.id||journal.root!==state.root||typeof journal.wasRunning!=='boolean'||!['prepared','stopped','active','committed','rolled-back'].includes(journal.status)||!/^[a-f0-9]{64}$/.test(journal.previous)||!/^[a-f0-9]{64}$/.test(journal.candidate))throw error('EINVAL','Invalid owned helper journal');
    if(['committed','rolled-back'].includes(journal.status))return {status:journal.status};
    const previous=read(dir,state.root,'helper.previous.exe'),current=read(dir,state.root,'supervisor.exe');image(previous);
    if(hash(previous)!==journal.previous||![journal.previous,journal.candidate].includes(hash(current)))throw error('EACCES','Helper recovery bytes changed outside this transaction');
    await state.service.stop(state.spec);writePrivateFile(p.join(state.root,'supervisor.exe'),previous);
    if(journal.wasRunning)await healthy(state);
    writePrivateFile(p.join(state.root,'helper-repair.json'),JSON.stringify({...journal,status:'rolled-back'}));
    return {status:'rolled-back'};
  }finally{if(lease){try{lease.unlink();}finally{lease.close();}}dir.close();}
}
