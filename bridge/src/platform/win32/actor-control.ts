// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen,ptr,type Pointer } from 'bun:ffi';
import { ProcessRef,jobMembers } from './job';
import { until } from './wait';
import { error } from './paths';
export interface ActorIdentity {pid:number;created:string;jobHandle:string;nonce:string}
const k=dlopen('kernel32.dll',{
  OpenProcess:{args:['u32','i32','u32'],returns:'ptr'},GetProcessTimes:{args:['ptr','ptr','ptr','ptr','ptr'],returns:'i32'},GetCurrentProcess:{args:[],returns:'ptr'},
  DuplicateHandle:{args:['ptr','ptr','ptr','ptr','u32','i32','u32'],returns:'i32'},IsProcessInJob:{args:['ptr','ptr','ptr'],returns:'i32'},
  TerminateJobObject:{args:['ptr','u32'],returns:'i32'},WaitForSingleObject:{args:['ptr','u32'],returns:'u32'},CloseHandle:{args:['ptr'],returns:'i32'},GetLastError:{args:[],returns:'u32'},
}).symbols;
function check(ok:unknown,label:string):asserts ok{if(!ok)throw error('EIO',`${label}: Win32 ${k.GetLastError()}`);}
/** Local controller only: reclaim a self-owned Job through an exact process identity, never a PID-shaped tree kill. */
export async function stopActor(actor:ActorIdentity){
  if(!Number.isInteger(actor.pid)||actor.pid<=0||!/^\d+$/.test(actor.created)||!/^\d+$/.test(actor.jobHandle)||!Number.isSafeInteger(Number(actor.jobHandle)))throw error('EINVAL','Invalid actor identity');
  const raw=k.OpenProcess(0x101040,0,actor.pid);if(!raw){const code=k.GetLastError();if(code===87||code===1168)return;check(false,'Open actor controller');}
  const process=Number(raw) as Pointer;let job:Pointer|undefined;const refs:ProcessRef[]=[];
  try {
    const created=new BigUint64Array(1),exited=new BigUint64Array(1),kernel=new BigUint64Array(1),user=new BigUint64Array(1);
    check(k.GetProcessTimes(process,ptr(created),ptr(exited),ptr(kernel),ptr(user)),'Actor creation identity');if(created[0]!==BigInt(actor.created))throw error('EACCES','Actor PID was reused');
    if(k.WaitForSingleObject(process,0)===0)return;
    const output=new BigUint64Array(1);check(k.DuplicateHandle(process,Number(actor.jobHandle) as Pointer,k.GetCurrentProcess(),ptr(output),0,0,2),'Reclaim actor Job');job=Number(output[0]) as Pointer;
    const member=new Int32Array(1);check(k.IsProcessInJob(process,job,ptr(member))&&member[0]===1,'Actor belongs to reclaimed Job');
    for(const pid of jobMembers(job)){const ref=ProcessRef.open(pid);if(ref)refs.push(ref);}
    check(k.TerminateJobObject(job,1),'Terminate actor Job');await until(()=>k.WaitForSingleObject(process,0)===0&&refs.every(ref=>!ref.alive())&&jobMembers(job!).length===0,10000,'Reclaimed actor Job drained');
  } finally {for(const ref of refs)ref.close();if(job)k.CloseHandle(job);k.CloseHandle(process);}
}
