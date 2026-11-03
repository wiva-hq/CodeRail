// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { win32 } from 'node:path';
import { error } from './paths';
export interface RegistryString { text: string; type: 1 | 2 }
const a = dlopen('advapi32.dll', {
  RegCreateKeyExW: { args: ['i64','ptr','u32','ptr','u32','u32','ptr','ptr','ptr'], returns: 'i32' },
  RegGetValueW: { args: ['ptr','ptr','ptr','u32','ptr','ptr','ptr'], returns: 'i32' },
  RegSetValueExW: { args: ['ptr','ptr','u32','u32','ptr','u32'], returns: 'i32' },
  RegDeleteValueW: { args: ['ptr','ptr'], returns: 'i32' },
  RegCloseKey: { args: ['ptr'], returns: 'i32' },
}).symbols;
const wide = (s: string) => Buffer.from(s+'\0','utf16le');
function check(code: number) { if(code) throw error(code===5?'EACCES':'EIO',`User environment registry: Win32 ${code}`); }
export class UserEnvironmentValue {
  constructor(readonly name = 'Path') { if(!/^(?:Path|CodeRail-PoC-[a-f0-9-]+)$/.test(name)) throw error('EINVAL','Unexpected environment value'); }
  private key<T>(work: (key: Pointer, name: Buffer) => T) {
    const key=wide('Environment'),h=new BigUint64Array(1); check(a.RegCreateKeyExW(-2147483647n,ptr(key),0,null,0,3,null,ptr(h),null));
    const handle=Number(h[0]) as Pointer; try{return work(handle,wide(this.name));}finally{check(a.RegCloseKey(handle));}
  }
  read(): RegistryString|null {
    return this.key((key,name)=>{
      const bytes=new Uint8Array(65536),size=new Uint32Array([bytes.length]),type=new Uint32Array(1);
      const code=a.RegGetValueW(key,null,ptr(name),0x10000006,ptr(type),ptr(bytes),ptr(size));
      if(code===2)return null;check(code);
      if(type[0]!==1&&type[0]!==2)throw error('EINVAL','Unexpected PATH registry type');
      return {text:Buffer.from(bytes.subarray(0,size[0])).toString('utf16le').replace(/\0.*$/s,''),type:type[0]};
    });
  }
  write(value: RegistryString|null) {
    this.key((key,name)=>{
      if(value===null){const status=a.RegDeleteValueW(key,ptr(name));if(status!==2)check(status);return;}
      if(![1,2].includes(value.type)||value.text.includes('\0')||value.text.length>32760)throw error('EINVAL','Invalid environment value/type');
      const bytes=wide(value.text);check(a.RegSetValueExW(key,ptr(name),0,value.type,ptr(bytes),bytes.length));
    });
  }
}
export interface PathChange { old: RegistryString|null; installed: RegistryString; entry: string; added: boolean }
function equivalent(entry: string, target: string, env: NodeJS.ProcessEnv, expand: boolean) {
  const values=Object.fromEntries(Object.entries(env).map(([k,v])=>[k.toUpperCase(),v]));
  const literal=entry.trim().replace(/^"(.*)"$/,'$1');
  const expanded=expand?literal.replace(/%([^%]+)%/g,(full,name:string)=>values[name.toUpperCase()]??full):literal;
  // PATH planning is lexical, not an authorization oracle. Only fold ASCII;
  // Unicode lowercase merges physically distinct Windows paths (İ vs i + dot).
  const key=(value:string)=>win32.normalize(value).replace(/[\\/]+$/,'').replace(/[A-Z]/g,c=>c.toLowerCase());
  return win32.isAbsolute(expanded)&&key(expanded)===key(target);
}
export function addPath(old: RegistryString|null, entry: string, env: NodeJS.ProcessEnv = process.env): PathChange {
  if(!win32.isAbsolute(entry)||/[;\0\r\n]/.test(entry))throw error('EINVAL','Invalid installed PATH entry');
  const exists=(old?.text??'').split(';').some(item=>equivalent(item,entry,env,old?.type===2));
  const text=old?.text??'';
  return {old,entry,added:!exists,installed:{type:old?.type??2,text:exists?text:text+(text&&!text.endsWith(';')?';':'')+entry}};
}
export function removePath(current: RegistryString|null, change: PathChange, env: NodeJS.ProcessEnv = process.env): RegistryString|null {
  if(!change.added||!current)return current;
  if(current.text===change.installed.text&&current.type===change.installed.type)return change.old;
  // Remove one exact inserted value. Preserve aliases/duplicates added or edited
  // later by someone else instead of claiming ownership of all equivalent paths.
  const entries=current.text.split(';'),index=entries.indexOf(change.entry);
  if(index>=0)entries.splice(index,1);
  return {...current,text:entries.join(';')};
}
