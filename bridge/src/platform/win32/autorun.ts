// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { error } from './paths';
const keyName = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const a = dlopen('advapi32.dll', {
  RegCreateKeyExW: { args: ['i64', 'ptr', 'u32', 'ptr', 'u32', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  RegGetValueW: { args: ['ptr', 'ptr', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  RegSetValueExW: { args: ['ptr', 'ptr', 'u32', 'u32', 'ptr', 'u32'], returns: 'i32' },
  RegDeleteValueW: { args: ['ptr', 'ptr'], returns: 'i32' },
  RegCloseKey: { args: ['ptr'], returns: 'i32' },
}).symbols;
const wide = (text: string) => Buffer.from(text + '\0', 'utf16le');
function check(status: number, label: string) { if (status) throw error(status === 5 ? 'EACCES' : 'EIO', `${label}: Win32 ${status}`); }
export function validateStartupCommand(command: string) {
  if (!command || command.length > 260 || /[\0\r\n]/.test(command)) throw error('EINVAL', 'Run command must fit Windows 260-character startup limit');
}

export class UserAutorun {
  constructor(readonly name = 'CodeRail') {
    if (!/^CodeRail(?:-PoC-[a-f0-9-]+)?$/.test(name)) throw error('EINVAL', 'Unexpected startup value name');
  }
  private key<T>(work: (key: Pointer, name: Buffer) => T) {
    const path = wide(keyName), handle = new BigUint64Array(1);
    check(a.RegCreateKeyExW(-2147483647n, ptr(path), 0, null, 0, 3, null, ptr(handle), null), 'Open user Run key');
    const key = Number(handle[0]) as Pointer;
    try { return work(key, wide(this.name)); } finally { check(a.RegCloseKey(key), 'Close user Run key'); }
  }
  read(): string | null {
    return this.key((key, name) => {
      const bytes = new Uint8Array(65536), size = new Uint32Array([bytes.length]);
      const status = a.RegGetValueW(key, null, ptr(name), 2, null, ptr(bytes), ptr(size));
      if (status === 2) return null; check(status, 'Read startup value');
      return Buffer.from(bytes.subarray(0, size[0])).toString('utf16le').replace(/\0.*$/s, '');
    });
  }
  install(command: string) {
    validateStartupCommand(command);
    const previous = this.read();
    if (previous !== null && previous !== command) throw error('EEXIST', 'Startup value is owned by a different installation');
    this.key((key, name) => { const bytes = wide(command); check(a.RegSetValueExW(key, ptr(name), 0, 1, ptr(bytes), bytes.length), 'Install user startup'); });
  }
  uninstall(expectedCommand: string) {
    const previous = this.read(); if (previous === null) return;
    if (previous !== expectedCommand) throw error('EACCES', 'Refuse removing another installation startup value');
    this.key((key, name) => check(a.RegDeleteValueW(key, ptr(name)), 'Remove user startup'));
  }
}
