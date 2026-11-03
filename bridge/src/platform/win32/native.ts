// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { containsCanonical, error, normalize } from './paths';

const k = dlopen('kernel32.dll', {
  CreateFileW: { args: ['ptr', 'u32', 'u32', 'ptr', 'u32', 'u32', 'ptr'], returns: 'ptr' },
  GetLastError: { args: [], returns: 'u32' },
  CloseHandle: { args: ['ptr'], returns: 'i32' },
  GetFileInformationByHandle: { args: ['ptr', 'ptr'], returns: 'i32' },
  GetFinalPathNameByHandleW: { args: ['ptr', 'ptr', 'u32', 'u32'], returns: 'u32' },
  ReadFile: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'i32' },
  WriteFile: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'i32' },
  FlushFileBuffers: { args: ['ptr'], returns: 'i32' },
  SetFileInformationByHandle: { args: ['ptr', 'i32', 'ptr', 'u32'], returns: 'i32' },
}).symbols;
const nt = dlopen('ntdll.dll', {
  NtCreateFile: { args: ['ptr', 'u32', 'ptr', 'ptr', 'ptr', 'u32', 'u32', 'u32', 'u32', 'ptr', 'u32'], returns: 'i32' },
  RtlNtStatusToDosError: { args: ['i32'], returns: 'u32' },
  NtSetInformationFile: { args: ['ptr', 'ptr', 'ptr', 'u32', 'i32'], returns: 'i32' },
  NtQueryDirectoryFile: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'ptr', 'u32', 'i32', 'u8', 'ptr', 'u8'], returns: 'i32' },
}).symbols;
const wide = (s: string) => Buffer.from(s + '\0', 'utf16le');
function failed(operation: string, n = k.GetLastError()): never {
  throw Object.assign(error(n === 32 || n === 33 ? 'EBUSY' : n === 5 ? 'EACCES' : n === 2 || n === 3 ? 'ENOENT' : n === 183 || n === 80 ? 'EEXIST' : n === 267 ? 'ENOTDIR' : 'EIO', `${operation}: Win32 ${n}`), { win32: n });
}
/** Keep an actual file object, not a PID/path-shaped identity. Never follow a final reparse point. */
export class NativeFile {
  private closed = false;
  readonly attributes: number;
  constructor(readonly path: string, directory: boolean, readonly reparseAllowed = false, supplied?: Pointer, sharing = directory ? 3 : 1) {
    if (process.platform !== 'win32') throw error('ENOTSUP', 'Windows native filesystem only');
    const full = normalize(path);
    const extended = full.startsWith('\\\\') ? '\\\\?\\UNC\\' + full.slice(2) : '\\\\?\\' + full;
    const name = wide(extended);
    // Deny DELETE sharing. WRITE sharing is needed by rename's parent-directory
    // access; no-follow relative opens and handle checks enforce reparse safety.
    const raw = supplied ?? k.CreateFileW(ptr(name), directory ? 0x81 : 0x80000000, sharing, null, 3, 0x02200000, null);
    if (!raw || Number(raw) === -1 || Number(raw) === 0xffffffffffffffff) failed('CreateFileW');
    this.handle = Number(raw) as Pointer;
    try {
      const info = new Uint8Array(52);
      if (!k.GetFileInformationByHandle(this.handle, ptr(info))) failed('GetFileInformationByHandle');
      this.attributes = new DataView(info.buffer).getUint32(0, true);
      if (!reparseAllowed && (this.attributes & 0x400)) throw error('EACCES', 'Reparse point changed during operation');
      if (directory !== !!(this.attributes & 0x10)) throw error(directory ? 'ENOTDIR' : 'EISDIR', 'Unexpected file type');
    } catch (e) { this.close(); throw e; }
  }
  private handle: Pointer;
  details() {
    const bytes=new Uint8Array(52);
    if(!k.GetFileInformationByHandle(this.handle,ptr(bytes)))failed('GetFileInformationByHandle');
    const view=new DataView(bytes.buffer), attributes=view.getUint32(0,true);
    return {kind:(attributes&0x400)?'link' as const:(attributes&0x10)?'dir' as const:'file' as const,size:Number((BigInt(view.getUint32(32,true))<<32n)|BigInt(view.getUint32(36,true))),mtime:Number((view.getBigUint64(20,true)-116444736000000000n)/10000n)};
  }
  /** Resolve a SINGLE component relative to an already opened directory object.
   * Renaming the parent cannot redirect this operation into an attacker junction. */
  child(name: string, directory: boolean, create = false, mutable = false, sharing = directory ? 3 : 1): NativeFile {
    if (!name || /[\\/:\0]/.test(name) || name === '.' || name === '..') throw error('EINVAL', 'Relative handle operation needs one path component');
    if (process.arch !== 'x64') throw error('ENOTSUP', 'NT structure layout is validated for x64 only');
    const text = Buffer.from(name, 'utf16le'), unicode = new Uint8Array(16), u = new DataView(unicode.buffer);
    u.setUint16(0, text.length, true); u.setUint16(2, text.length, true); u.setBigUint64(8, BigInt(ptr(text)), true);
    const object = new Uint8Array(48), o = new DataView(object.buffer);
    o.setUint32(0, 48, true); o.setBigUint64(8, BigInt(this.handle), true); o.setBigUint64(16, BigInt(ptr(unicode)), true); o.setUint32(24, 0x40, true);
    const output = new BigUint64Array(1), status = new Uint8Array(16);
    const access = directory ? (mutable ? 0x110081 : 0x100081) : mutable ? (create ? 0xC0110000 : 0x80110000) : 0x80100000;
    const code = nt.NtCreateFile(ptr(output), access, ptr(object), ptr(status), null, 0x80, sharing, create ? 2 : 1, 0x00200020 | (directory ? 1 : 0x40), null, 0);
    if (code < 0) failed('NtCreateFile', nt.RtlNtStatusToDosError(code));
    return new NativeFile(this.path + '\\' + name, directory, false, Number(output[0]) as Pointer);
  }
  write(bytes: Uint8Array) {
    let offset = 0;
    while (offset < bytes.length) {
      const part = bytes.subarray(offset, offset + 65536), written = new Uint32Array(1);
      if (!k.WriteFile(this.handle, ptr(part), part.length, ptr(written), null)) failed('WriteFile');
      if (!written[0]) throw error('EIO', 'WriteFile made no progress');
      offset += written[0];
    }
    if (!k.FlushFileBuffers(this.handle)) failed('FlushFileBuffers');
  }
  renameTo(parent: NativeFile, name: string, replace: boolean) {
    if (!name || /[\\/:\0]/.test(name) || name === '.' || name === '..') throw error('EINVAL', 'Rename needs one component');
    const text = Buffer.from(name, 'utf16le'), info = new Uint8Array(20 + text.length), view = new DataView(info.buffer);
    view.setUint8(0, replace ? 1 : 0); view.setBigUint64(8, BigInt(parent.handle), true); view.setUint32(16, text.length, true); info.set(text, 20);
    // Classic rename deliberately omits POSIX semantics: live handles without
    // delete sharing must produce a retryable sharing violation.
    const status = new Uint8Array(16);
    const result = nt.NtSetInformationFile(this.handle, ptr(status), ptr(info), info.length, 10);
    if (result < 0) failed('NtSetInformationFile(rename)', nt.RtlNtStatusToDosError(result));
  }
  unlink() {
    const info = new Uint8Array([1]);
    if (!k.SetFileInformationByHandle(this.handle, 4, ptr(info), info.length)) failed('SetFileInformationByHandle(disposition)');
  }
  entries() {
    const entries: { name: string; isDirectory(): boolean; isSymbolicLink(): boolean; size: bigint; mtimeNs: bigint }[] = [];
    const buffer = new Uint8Array(65536), status = new Uint8Array(16);
    let restart = true;
    for (;;) {
      const result = nt.NtQueryDirectoryFile(this.handle, null, null, null, ptr(status), ptr(buffer), buffer.length, 1, 0, null, restart ? 1 : 0);
      restart = false;
      if ((result >>> 0) === 0x80000006) return entries;
      if (result < 0) failed('NtQueryDirectoryFile', nt.RtlNtStatusToDosError(result));
      const length = Number(new DataView(status.buffer).getBigUint64(8, true));
      const view = new DataView(buffer.buffer); let offset = 0;
      while (offset + 64 <= length) {
        const next = view.getUint32(offset, true), attributes = view.getUint32(offset + 56, true), nameLength = view.getUint32(offset + 60, true);
        if (offset + 64 + nameLength > length) throw error('EIO', 'Truncated native directory entry');
        const name = Buffer.from(buffer.subarray(offset + 64, offset + 64 + nameLength)).toString('utf16le');
        if (name !== '.' && name !== '..') entries.push({ name, isDirectory: () => !!(attributes & 0x10), isSymbolicLink: () => !!(attributes & 0x400), size: view.getBigInt64(offset + 40, true), mtimeNs: (view.getBigInt64(offset + 24, true) - 116444736000000000n) * 100n });
        if (!next) break;
        if (next < 64 || offset + next >= length) throw error('EIO', 'Invalid native directory entry offset');
        offset += next;
      }
    }
  }
  finalPath() {
    const bytes = new Uint8Array(65536);
    const length = k.GetFinalPathNameByHandleW(this.handle, ptr(bytes), bytes.length / 2, 0);
    if (!length || length >= bytes.length / 2) failed('GetFinalPathNameByHandleW');
    return normalize(Buffer.from(bytes.subarray(0, length * 2)).toString('utf16le'));
  }
  read(root: string, max: number) {
    if (!containsCanonical(root, this.finalPath())) throw error('EACCES', 'Opened file is outside the authorized root');
    const chunks: Buffer[] = []; let total = 0;
    while (total < max) {
      const bytes = new Uint8Array(Math.min(65536, max - total)), read = new Uint32Array(1);
      if (!k.ReadFile(this.handle, ptr(bytes), bytes.length, ptr(read), null)) failed('ReadFile');
      if (!read[0]) break;
      chunks.push(Buffer.from(bytes.subarray(0, read[0]))); total += read[0];
    }
    return Buffer.concat(chunks);
  }
  close() { if (!this.closed) { this.closed = true; if (!k.CloseHandle(this.handle)) failed('CloseHandle'); } }
}
