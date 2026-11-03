// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { realpathSync } from 'node:fs';
import { ProcessJob, ProcessRef, jobMembers } from './job';
import { quoteArgument } from './launcher';
import { error } from './paths';
import { until } from './wait';

const api=dlopen('kernel32.dll',{
  CreateProcessW:{args:['ptr','ptr','ptr','ptr','i32','u32','ptr','ptr','ptr','ptr'],returns:'i32'},
  InitializeProcThreadAttributeList:{args:['ptr','u32','u32','ptr'],returns:'i32'},
  UpdateProcThreadAttribute:{args:['ptr','u32','u64','ptr','u64','ptr','ptr'],returns:'i32'},
  DeleteProcThreadAttributeList:{args:['ptr'],returns:'void'},
  SetHandleInformation:{args:['ptr','u32','u32'],returns:'i32'},
  ResumeThread:{args:['ptr'],returns:'u32'},CloseHandle:{args:['ptr'],returns:'i32'},
  GetCurrentProcess:{args:[],returns:'ptr'},GetLastError:{args:[],returns:'u32'},
  DuplicateHandle:{args:['ptr','ptr','ptr','ptr','u32','i32','u32'],returns:'i32'},
  TerminateJobObject:{args:['ptr','u32'],returns:'i32'},WaitForSingleObject:{args:['ptr','u32'],returns:'u32'},
}).symbols;
const wide=(value:string)=>Buffer.from(value+'\0','utf16le');
function check(ok:unknown,label:string):asserts ok {if(!ok)throw error('EIO',`${label}: Win32 ${api.GetLastError()}`);}

/** Cleanup actor owns an inherited reference to its own kill-on-close Job.
 * Creator may exit, but the actor cannot escape an existing outer Job.
 * Actor MUST clear HANDLE_FLAG_INHERIT before spawning anything. */
export function handoff(argv:string[],cwd:string,env:Record<string,string|undefined>=process.env) {
  if(process.platform!=='win32'||process.arch!=='x64')throw error('ENOTSUP','Actor handoff validated for Windows x64 only');
  const exe=realpathSync.native(argv[0]!),directory=realpathSync.native(cwd),job=new ProcessJob(),jobHandle=job.creationHandle();
  let ph:Pointer|null=null,th:Pointer|null=null,ref:ProcessRef|null=null,attributes:Uint8Array|undefined,initialized=false,released=false;
  try {
    check(api.SetHandleInformation(jobHandle,1,1),'Make one Job handle inheritable');
    const values=new Map<string,string>();
    for(const [key,value] of Object.entries(env))if(value!==undefined){if(!key||/[=\0]/.test(key)||value.includes('\0'))throw error('EINVAL','Invalid actor environment');values.set(key.toUpperCase(),value);}
    values.set('CODERAIL_ACTOR_JOB',String(jobHandle));
    const block=Buffer.from([...values].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>k+'='+v).join('\0')+'\0\0','utf16le');
    const command=wide([exe,...argv.slice(1)].map(quoteArgument).join(' '));if(command.length>65534)throw error('EINVAL','Actor command line too long');
    const size=new BigUint64Array(1);api.InitializeProcThreadAttributeList(null,2,0,ptr(size));check(size[0]>0n&&size[0]<=65536n,'Actor attributes size');
    attributes=new Uint8Array(Number(size[0]));check(api.InitializeProcThreadAttributeList(ptr(attributes),2,0,ptr(size)),'Initialize actor attributes');initialized=true;
    const jobs=new BigUint64Array([BigInt(jobHandle)]),handles=new BigUint64Array([BigInt(jobHandle)]);
    check(api.UpdateProcThreadAttribute(ptr(attributes),0,0x2000d,ptr(jobs),8,null,null),'Actor creation Job list');
    check(api.UpdateProcThreadAttribute(ptr(attributes),0,0x20002,ptr(handles),8,null,null),'Only actor Job handle inherited');
    const startup=new Uint8Array(112),view=new DataView(startup.buffer),info=new Uint8Array(24);view.setUint32(0,112,true);view.setBigUint64(104,BigInt(ptr(attributes)),true);
    check(api.CreateProcessW(ptr(wide(exe)),ptr(command),null,null,1,0x08080404,ptr(block),ptr(wide(directory)),ptr(startup),ptr(info)),'Create suspended actor');
    const process=new DataView(info.buffer);ph=Number(process.getBigUint64(0,true)) as Pointer;th=Number(process.getBigUint64(8,true)) as Pointer;
    const pid=process.getUint32(16,true);ref=ProcessRef.open(pid);check(ref,'Actor process handle');check(jobMembers(jobHandle).includes(pid),'Actor assigned before resume');
    // Only the child's inherited copy stays inheritable until its first action.
    check(api.SetHandleInformation(jobHandle,1,0),'Clear creator handle inheritance');
    check(api.ResumeThread(th)!==0xffffffff,'Resume actor');
    const duplicate=()=>{
      const output=new BigUint64Array(1);
      check(api.DuplicateHandle(ph,jobHandle,api.GetCurrentProcess(),ptr(output),0,0,2),'Recover actor Job handle by exact process object');
      return Number(output[0]) as Pointer;
    };
    let disposed=false;
    return {
      pid,created:ref.created,alive:()=>ref!.alive(),
      releaseOwner(){if(!released){job.close();released=true;}},
      /** Only after an actor acknowledgement: transfer ownership and close the
       * launcher's process handles without terminating the acknowledged actor. */
      detach(){if(disposed)throw error('EINVAL','Actor controller already disposed');if(!released){job.close();released=true;}disposed=true;ref!.close();if(ph)api.CloseHandle(ph);ph=null;},
      async stop(){
        if(!ref!.alive()){if(!released){job.close();released=true;}return;}
        const h=released?duplicate():jobHandle;
        const refs:ProcessRef[]=[];
        try {
          for(const pid of jobMembers(h)){const member=ProcessRef.open(pid);if(member)refs.push(member);}
          check(api.TerminateJobObject(h,1),'Terminate complete actor Job');
          await until(()=>!ref!.alive()&&refs.every(member=>!member.alive())&&jobMembers(h).length===0,10000,'Actor Job and process handles drained');
        } finally {for(const member of refs)member.close();if(released)api.CloseHandle(h);else{job.close();released=true;}}
      },
      async dispose(){if(disposed)return;disposed=true;try{await this.stop();}finally{ref!.close();if(ph)api.CloseHandle(ph);ph=null;}},
    };
  } catch(cause) {job.close();ref?.close();if(ph)api.CloseHandle(ph);throw cause;}
  finally {if(initialized)api.DeleteProcThreadAttributeList(ptr(attributes!));if(th)api.CloseHandle(th);}
}
