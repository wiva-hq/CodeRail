// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr } from 'bun:ffi';
import { error } from './paths';
const api=dlopen('advapi32.dll',{RegGetValueW:{args:['i64','ptr','ptr','u32','ptr','ptr','ptr'],returns:'i32'}}).symbols;
const wide=(text:string)=>Buffer.from(text+'\0','utf16le');
function stringValue(hive:bigint,keyName:string,valueName:string,view=0):string|null{
  const key=wide(keyName),name=wide(valueName),bytes=new Uint8Array(65536),size=new Uint32Array([bytes.length]);
  const status=api.RegGetValueW(hive,ptr(key),ptr(name),0x6|view,null,ptr(bytes),ptr(size));
  if(status===2||status===3)return null;
  if(status!==0)throw error(status===5?'EACCES':'EIO',`Registry string query: Win32 ${status}`);
  return Buffer.from(bytes.subarray(0,size[0])).toString('utf16le').replace(/\0.*$/s,'');
}
export function environmentPaths(){
  return [
    stringValue(-2147483646n,'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment','Path'),
    stringValue(-2147483647n,'Environment','Path'),
  ].filter((value):value is string=>value!==null);
}
export function gitInstallPaths(){
  const values:string[]=[];
  for(const hive of [-2147483647n,-2147483646n])for(const view of [0x00010000,0x00020000]){
    const value=stringValue(hive,'Software\\GitForWindows','InstallPath',view);
    if(value!==null)values.push(value);
  }
  return [...new Set(values)];
}
