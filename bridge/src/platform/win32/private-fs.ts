// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, read, type Pointer } from 'bun:ffi';
import { realpathSync } from 'node:fs';
import { win32 as p } from 'node:path';
import { NativeFile } from './native';
import { error, normalize } from './paths';

const k = dlopen('kernel32.dll', {
  GetCurrentProcess: { args: [], returns: 'ptr' },
  GetLastError: { args: [], returns: 'u32' },
  CloseHandle: { args: ['ptr'], returns: 'i32' },
  LocalFree: { args: ['ptr'], returns: 'ptr' },
  CreateDirectoryW: { args: ['ptr', 'ptr'], returns: 'i32' },
  CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'ptr'], returns: 'ptr' },
}).symbols;
const a = dlopen('advapi32.dll', {
  OpenProcessToken: { args: ['ptr', 'u32', 'ptr'], returns: 'i32' },
  GetTokenInformation: { args: ['ptr', 'u32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
  ConvertSidToStringSidW: { args: ['ptr', 'ptr'], returns: 'i32' },
  ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ['ptr', 'u32', 'ptr', 'ptr'], returns: 'i32' },
  GetSecurityDescriptorDacl: { args: ['ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  SetSecurityInfo: { args: ['ptr', 'u32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'u32' },
}).symbols;
const wide = (s: string) => Buffer.from(s + '\0', 'utf16le');
const handle = (value: BigUint64Array) => Number(value[0]) as Pointer;
function check(ok: unknown, label: string): asserts ok { if (!ok) throw error('EACCES', `${label}: Win32 ${k.GetLastError()}`); }
function extended(path: string) { return path.startsWith('\\\\') ? '\\\\?\\UNC\\' + path.slice(2) : '\\\\?\\' + path; }

export function currentSid(): string {
  const token = new BigUint64Array(1); check(a.OpenProcessToken(k.GetCurrentProcess(), 8, ptr(token)), 'OpenProcessToken');
  try {
    const size = new Uint32Array(1); a.GetTokenInformation(handle(token), 1, null, 0, ptr(size));
    check(size[0] > 0 && size[0] <= 65536, 'TokenUser length');
    const bytes = new Uint8Array(size[0]); check(a.GetTokenInformation(handle(token), 1, ptr(bytes), bytes.length, ptr(size)), 'TokenUser');
    const sid = Number(new DataView(bytes.buffer).getBigUint64(0, true)) as Pointer, text = new BigUint64Array(1);
    check(a.ConvertSidToStringSidW(sid, ptr(text)), 'ConvertSidToStringSid');
    try {
      const chars: number[] = [];
      for (let i = 0; i < 256; i++) { const c = read.u16(handle(text), i * 2); if (!c) return String.fromCharCode(...chars); chars.push(c); }
      throw error('EIO', 'SID exceeds bounded length');
    } finally { k.LocalFree(handle(text)); }
  } finally { k.CloseHandle(handle(token)); }
}

function descriptor<T>(directory: boolean, work: (sa: Uint8Array, dacl: Pointer) => T): T {
  if (process.arch !== 'x64') throw error('ENOTSUP', 'Security structures validated on Windows x64 only');
  const flags = directory ? 'OICI' : '';
  const sddl = wide(`D:P(A;${flags};FA;;;${currentSid()})(A;${flags};FA;;;SY)`), sd = new BigUint64Array(1);
  check(a.ConvertStringSecurityDescriptorToSecurityDescriptorW(ptr(sddl), 1, ptr(sd), null), 'ConvertSecurityDescriptor');
  try {
    const present = new Int32Array(1), dacl = new BigUint64Array(1), defaulted = new Int32Array(1);
    check(a.GetSecurityDescriptorDacl(handle(sd), ptr(present), ptr(dacl), ptr(defaulted)), 'GetSecurityDescriptorDacl');
    check(present[0] && dacl[0], 'Private DACL must not be null');
    const sa = new Uint8Array(24), view = new DataView(sa.buffer);
    view.setUint32(0, 24, true); view.setBigUint64(8, sd[0], true); // handle inheritance remains false
    return work(sa, handle(dacl));
  } finally { k.LocalFree(handle(sd)); }
}

/** Pin the complete directory chain, reject reparse points and perform native
 * realpath verification. No mutable path ancestor can redirect ACL changes. */
function parents<T>(input: string, create: boolean, work: (parent: NativeFile, name: string, path: string) => T): T {
  const path = normalize(input), root = p.parse(path).root, parts = p.relative(root, path).split('\\').filter(Boolean), name = parts.pop();
  if (!name) throw error('EACCES', 'Refuse changing a volume/share root');
  const leases: NativeFile[] = [];
  try {
    let parent = new NativeFile(root, true); leases.push(parent);
    for (const part of parts) {
      try { parent = parent.child(part, true); }
      catch (e: any) {
        if (!create || e.code !== 'ENOENT') throw e;
        descriptor(true, sa => { const target = wide(extended(p.join(parent.finalPath(), part))); check(k.CreateDirectoryW(ptr(target), ptr(sa)), 'CreateDirectoryW'); });
        parent = parent.child(part, true);
      }
      leases.push(parent);
    }
    const real = realpathSync.native(p.dirname(path));
    if (real.toLowerCase() !== parent.finalPath().toLowerCase()) throw error('EACCES', 'Private directory parent changed');
    return work(parent, name, path);
  } finally { for (const lease of leases.reverse()) lease.close(); }
}

export function ensurePrivateDirectory(input: string): void {
  parents(input, true, (parent, name, path) => descriptor(true, (sa, dacl) => {
    let lease: NativeFile;
    try { lease = parent.child(name, true); }
    catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      const target = wide(extended(path)); check(k.CreateDirectoryW(ptr(target), ptr(sa)), 'Create private directory');
      lease = parent.child(name, true);
    }
    try {
      // The no-delete lease prevents swapping the target before its security handle opens.
      const target = wide(extended(path)), h = k.CreateFileW(ptr(target), 0x60080, 3, null, 3, 0x02200000, null);
      check(h && Number(h) !== -1 && Number(h) !== 0xffffffffffffffff, 'Open private directory ACL');
      try {
        const status = a.SetSecurityInfo(h, 1, 0x80000004, null, null, dacl, null);
        if (status) throw error('EACCES', `SetSecurityInfo: Win32 ${status}`);
      } finally { k.CloseHandle(h); }
    } finally { lease.close(); }
  }));
}

export function writePrivateFile(input: string, content: string | Uint8Array): void {
  parents(input, false, (parent, name, path) => descriptor(false, sa => {
    // Reject an existing reparse target, even though atomic rename would not follow it.
    try { const existing = parent.child(name, false); existing.close(); }
    catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const temp = p.join(p.dirname(path), `.coderail-private-${crypto.randomUUID()}.tmp`), target = wide(extended(temp));
    const raw = k.CreateFileW(ptr(target), 0x40010080, 0, ptr(sa), 1, 0x00200000, null);
    check(raw && Number(raw) !== -1 && Number(raw) !== 0xffffffffffffffff, 'Create private file');
    const file = new NativeFile(temp, false, false, Number(raw) as Pointer);
    try { file.write(typeof content === 'string' ? Buffer.from(content, 'utf8') : content); file.renameTo(parent, name, true); }
    catch (e) { file.unlink(); throw e; }
    finally { file.close(); }
  }));
}
