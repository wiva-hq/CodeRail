// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { error } from './paths';

export interface UserProxy { autoDetect: boolean; pac: string | null; proxy: string | null; bypass: string | null }
const winhttp=dlopen('winhttp.dll',{WinHttpGetIEProxyConfigForCurrentUser:{args:['ptr'],returns:'i32'}}).symbols;
const kernel=dlopen('kernel32.dll',{
  GetLastError:{args:[],returns:'u32'},GlobalFree:{args:['ptr'],returns:'ptr'},lstrlenW:{args:['ptr'],returns:'i32'},
}).symbols;
/** Current logged-on user's native per-connection settings. No registry mutation or PAC execution. */
export function currentUserProxy(): UserProxy {
  if(process.platform!=='win32'||process.arch!=='x64')throw error('ENOTSUP','WinHTTP proxy layout validated for Windows x64 only');
  const bytes=new Uint8Array(32),view=new DataView(bytes.buffer);
  if(!winhttp.WinHttpGetIEProxyConfigForCurrentUser(ptr(bytes))) {
    const code=kernel.GetLastError(); if(code===2)return {autoDetect:false,pac:null,proxy:null,bypass:null};
    throw error('EIO',`Current-user proxy configuration: Win32 ${code}`);
  }
  const allocated=[8,16,24].map(offset=>Number(view.getBigUint64(offset,true)) as Pointer);
  try {
    const text=(address:Pointer)=>{
      if(!address)return null;
      const length=kernel.lstrlenW(address); if(length<0||length>32767)throw error('EINVAL','Proxy configuration string exceeds limit');
      return Buffer.from(toArrayBuffer(address,0,length*2)).toString('utf16le');
    };
    return {autoDetect:view.getInt32(0,true)!==0,pac:text(allocated[0]!),proxy:text(allocated[1]!),bypass:text(allocated[2]!)};
  } finally { for(const address of allocated)if(address)kernel.GlobalFree(address); }
}

/** Explicit manual proxy only. PAC/WPAD resolution remains a separate unvalidated gate. */
export function manualProxy(target: string, config: UserProxy): string | undefined {
  const url=new URL(target),protocol=url.protocol==='wss:'?'https':url.protocol==='ws:'?'http':url.protocol.slice(0,-1);
  if(!['http','https'].includes(protocol))throw error('EINVAL','Proxy target must use HTTP or WebSocket');
  const host=url.hostname.toLowerCase();
  if(['localhost','127.0.0.1','[::1]'].includes(host))return undefined;
  for(const item of (config.bypass??'').split(';').map(value=>value.trim()).filter(Boolean)) {
    if(item.toLowerCase()==='<local>') { if(!host.includes('.')&&!host.includes(':'))return undefined; continue; }
    const pattern=item.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replaceAll('*','.*');
    const matcher=new RegExp(`^(?:${pattern})$`,'i');
    if(matcher.test(host)||matcher.test(host+':'+(url.port||(protocol==='https'?'443':'80'))))return undefined;
  }
  if(!config.proxy)return undefined;
  const values=config.proxy.split(';').map(value=>value.trim()).filter(Boolean);
  const mapped=values.find(value=>value.toLowerCase().startsWith(protocol+'='));
  const selected=mapped?.slice(mapped.indexOf('=')+1)??values.find(value=>!value.includes('='));
  if(!selected){if(values.some(value=>/^socks=/i.test(value)))throw error('ENOTSUP','SOCKS manual proxy fallback is not implemented');return undefined;}
  if(/[\r\n\0]/.test(selected))throw error('EINVAL','Invalid manual proxy');
  const proxy=new URL(selected.includes('://')?selected:'http://'+selected);
  if(!['http:','https:'].includes(proxy.protocol)||proxy.pathname!=='/'||proxy.search||proxy.hash)throw error('ENOTSUP','Only HTTP(S) manual proxies are supported');
  return proxy.href;
}

/** Preserve Bun's environment-proxy and NO_PROXY handling when explicitly set. */
export function proxyFor(target: string, input: NodeJS.ProcessEnv = process.env, read = currentUserProxy): string | undefined {
  const env=Object.fromEntries(Object.entries(input).map(([key,value])=>[key.toUpperCase(),value]));
  const secure=/^(?:https|wss):/i.test(target);
  if(env.HTTP_PROXY || env.HTTPS_PROXY || env.ALL_PROXY)return undefined;
  const url=new URL(target),host=url.hostname.toLowerCase().replace(/^\[|\]$/g,''),port=url.port||(secure?'443':'80');
  let unsupportedBypass=false;
  for(const raw of (env.NO_PROXY??'').split(',').map(value=>value.trim()).filter(Boolean)) {
    if(raw==='*')return undefined;
    if(/[\/\s]/.test(raw)){unsupportedBypass=true;continue;}
    let domain=raw.toLowerCase(),specifiedPort:string|undefined;
    const bracket=domain.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if(bracket){domain=bracket[1]!;specifiedPort=bracket[2];}
    else if((domain.match(/:/g)??[]).length===1){const parts=domain.split(':');domain=parts[0]!;specifiedPort=parts[1];}
    domain=domain.replace(/^\*?\./,'');
    if(domain.includes('*')){unsupportedBypass=true;continue;}
    if((!specifiedPort||specifiedPort===port)&&(host===domain||host.endsWith('.'+domain)))return undefined;
  }
  const config=read();
  if(config.proxy&&unsupportedBypass)throw error('ENOTSUP','System proxy fallback requires host/domain NO_PROXY entries; CIDR and other wildcards are not implemented');
  return manualProxy(target,config);
}
