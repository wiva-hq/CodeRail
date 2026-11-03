// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {dlopen,ptr} from 'bun:ffi';
import {ProcessRef} from './job';
import {error} from './paths';
const api=dlopen('kernel32.dll',{K32GetProcessMemoryInfo:{args:['ptr','ptr','u32'],returns:'i32'},GetLastError:{args:[],returns:'u32'}}).symbols;
export function memory(ref:ProcessRef){
  if(process.arch!=='x64')throw error('ENOTSUP','Process memory layout validated on x64 only');
  if(!ref.alive())return null;
  const data=new Uint8Array(80),view=new DataView(data.buffer);view.setUint32(0,80,true);
  if(!api.K32GetProcessMemoryInfo(ref.handle,ptr(data),80)){
    const code=api.GetLastError();if(!ref.alive())return null;
    throw error('EIO',`Process memory: Win32 ${code}`);
  }
  const workingSetBytes=Number(view.getBigUint64(16,true)),privateBytes=Number(view.getBigUint64(72,true));
  if(!Number.isSafeInteger(workingSetBytes)||!Number.isSafeInteger(privateBytes))throw error('EOVERFLOW','Process memory counters exceed integer precision');
  return {workingSetBytes,privateBytes};
}
