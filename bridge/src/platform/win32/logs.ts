// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { realpathSync } from 'node:fs';
import { win32 as p } from 'node:path';
import { NativeFile } from './native';
import { containsCanonical, error, normalize } from './paths';

const k = dlopen('kernel32.dll', {
  CreateFileW: { args: ['ptr','u32','u32','ptr','u32','u32','ptr'], returns: 'ptr' },
  GetFileInformationByHandle: { args: ['ptr','ptr'], returns: 'i32' },
  GetFinalPathNameByHandleW: { args: ['ptr','ptr','u32','u32'], returns: 'u32' },
  SetFilePointerEx: { args: ['ptr','i64','ptr','u32'], returns: 'i32' },
  ReadFile: { args: ['ptr','ptr','u32','ptr','ptr'], returns: 'i32' },
  GetLastError: { args: [], returns: 'u32' },
  CloseHandle: { args: ['ptr'], returns: 'i32' },
}).symbols;
const wide = (text: string) => Buffer.from(text+'\0','utf16le');
function failed(operation: string): never {
  const code = k.GetLastError();
  throw error(code===2||code===3?'ENOENT':code===5?'EACCES':code===32||code===33?'EBUSY':'EIO', `${operation}: Win32 ${code}`);
}

/** Bounded reads from a no-follow native file object. A rename cannot redirect a read. */
function sample(root: string, name: string, previous: { id: string; offset: number } | null, initialBytes: number) {
  const lease = new NativeFile(root, true);
  let handle: Pointer | null = null;
  try {
    const path = p.join(root, name), native = path.startsWith('\\\\') ? '\\\\?\\UNC\\'+path.slice(2) : '\\\\?\\'+path;
    const raw = k.CreateFileW(ptr(wide(native)), 0x80000000, 7, null, 3, 0x00200080, null);
    if (!raw || Number(raw)===-1 || Number(raw)===0xffffffffffffffff) failed('Open log');
    handle = Number(raw) as Pointer;
    const info = new Uint8Array(52); if (!k.GetFileInformationByHandle(handle,ptr(info))) failed('Log information');
    const view = new DataView(info.buffer);
    if ((view.getUint32(0,true)&0x410) || view.getUint32(40,true)!==1) throw error('EACCES','Log must be a regular non-reparse file with one link');
    const final = new Uint8Array(65536), length=k.GetFinalPathNameByHandleW(handle,ptr(final),final.length/2,0);
    if (!length || length>=final.length/2) failed('Log physical path');
    const physical=normalize(Buffer.from(final.subarray(0,length*2)).toString('utf16le'));
    if (!containsCanonical(root,physical) || p.basename(physical)!==name) throw error('EACCES','Log moved outside its owned directory');
    const size=Number((BigInt(view.getUint32(32,true))<<32n)|BigInt(view.getUint32(36,true)));
    if (!Number.isSafeInteger(size)) throw error('EFBIG','Log size exceeds safe offsets');
    const id=[view.getUint32(28,true),view.getUint32(44,true),view.getUint32(48,true),view.getBigUint64(4,true)].join(':');
    const reset=!previous || previous.id!==id || size<previous.offset;
    const offset=reset?Math.max(0,size-initialBytes):previous.offset;
    if (!k.SetFilePointerEx(handle,BigInt(offset),null,0)) failed('Seek log');
    const bytes=new Uint8Array(Math.min(1024*1024,size-offset)), count=new Uint32Array(1);
    if (bytes.length && !k.ReadFile(handle,ptr(bytes),bytes.length,ptr(count),null)) failed('Read log');
    return { id, offset:offset+count[0], bytes:bytes.subarray(0,count[0]), reset, skipped:reset&&offset>0 };
  } finally { if (handle) k.CloseHandle(handle); lease.close(); }
}

export async function printLogs(path: string, options: { follow?: boolean; signal?: AbortSignal; write?: (text: string) => void } = {}) {
  const write=options.write??((text:string)=>{process.stdout.write(text,'utf8');});
  let tail: LogTail;
  try { tail=new LogTail(p.dirname(path),p.basename(path)); }
  catch(cause:any) { if(cause.code!=='ENOENT')throw cause; if(!options.follow){write('No service log yet.\n');return;} throw cause; }
  do {
    if(options.signal?.aborted)return;
    const text=tail.poll(); if(text)write(text);
    if(!options.follow)return;
    await Bun.sleep(200);
  } while(!options.signal?.aborted);
}

/** UTF-8 decoder spans append boundaries, but resets when file identity changes. */
export class LogTail {
  private cursor: { id: string; offset: number } | null = null;
  private decoder = new TextDecoder('utf-8');
  private readonly root: string;
  constructor(directory: string, private name = 'bridge.log', private initialBytes = 128*1024) {
    if (!name || /[\\/:\0]/.test(name) || name==='.' || name==='..') throw error('EINVAL','Log needs one filename');
    if (!Number.isSafeInteger(initialBytes) || initialBytes<4 || initialBytes>1024*1024) throw error('EINVAL','Invalid initial log bound');
    this.root=normalize(realpathSync.native(directory));
  }
  poll(): string {
    let next: ReturnType<typeof sample>;
    try { next=sample(this.root,this.name,this.cursor,this.initialBytes); }
    catch (cause: any) { if(cause.code==='ENOENT')return ''; throw cause; }
    let text='';
    if(next.reset) { if(this.cursor)text=this.decoder.decode(); this.decoder=new TextDecoder('utf-8'); }
    this.cursor={id:next.id,offset:next.offset};
    let bytes=next.bytes;
    if(next.skipped) { let start=0; while(start<bytes.length&&(bytes[start]!&0xc0)===0x80)start++; bytes=bytes.subarray(start); }
    return text+this.decoder.decode(bytes,{stream:true});
  }
}
