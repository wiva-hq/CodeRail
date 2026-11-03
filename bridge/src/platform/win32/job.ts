// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import assert from 'node:assert/strict';

// Deliberately contains no console-attachment or console-event APIs.
const api = dlopen('kernel32.dll', {
  CreateToolhelp32Snapshot: { args: ['u32', 'u32'], returns: 'ptr' },
  Process32FirstW: { args: ['ptr', 'ptr'], returns: 'i32' },
  Process32NextW: { args: ['ptr', 'ptr'], returns: 'i32' },
  GetLastError: { args: [], returns: 'u32' },
  OpenProcess: { args: ['u32', 'i32', 'u32'], returns: 'ptr' },
  GetProcessTimes: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  WaitForSingleObject: { args: ['ptr', 'u32'], returns: 'u32' },
  CloseHandle: { args: ['ptr'], returns: 'i32' },
  CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'ptr' },
  SetInformationJobObject: { args: ['ptr', 'i32', 'ptr', 'u32'], returns: 'i32' },
  AssignProcessToJobObject: { args: ['ptr', 'ptr'], returns: 'i32' },
  IsProcessInJob: { args: ['ptr', 'ptr', 'ptr'], returns: 'i32' },
  QueryInformationJobObject: { args: ['ptr', 'i32', 'ptr', 'u32', 'ptr'], returns: 'i32' },
}).symbols;
function check(ok: unknown, label: string): asserts ok { assert(ok, `${label}: Win32 ${api.GetLastError()}`); }
function handle(raw: Pointer | bigint | null): Pointer {
  check(raw, 'invalid handle');
  const value = Number(raw); assert(Number.isSafeInteger(value) && value > 0, 'invalid / unrepresentable handle');
  return value as Pointer;
}
export interface ProcessRow { pid: number; parentPid: number; name: string }
export function snapshot(): ProcessRow[] {
  assert.equal(process.arch, 'x64', 'PROCESSENTRY32W layout validated for x64 only');
  const h = handle(api.CreateToolhelp32Snapshot(2, 0));
  const entry = new Uint8Array(568), view = new DataView(entry.buffer); view.setUint32(0, entry.length, true);
  const rows: ProcessRow[] = [];
  try {
    check(api.Process32FirstW(h, ptr(entry)), 'Process32FirstW');
    do {
      rows.push({ pid: view.getUint32(8, true), parentPid: view.getUint32(32, true), name: Buffer.from(entry.subarray(44, 564)).toString('utf16le').split('\0')[0] });
    } while (api.Process32NextW(h, ptr(entry)));
    assert.equal(api.GetLastError(), 18, 'Process32NextW must finish with ERROR_NO_MORE_FILES');
    return rows;
  } finally { api.CloseHandle(h); }
}
export class ProcessRef {
  private closed = false;
  private constructor(readonly pid: number, readonly handle: Pointer, readonly created: bigint) {}
  static open(pid: number): ProcessRef | null {
    const raw = api.OpenProcess(0x101101, 0, pid); // synchronize, query limited, set quota, terminate
    if (!raw) {
      const error = api.GetLastError();
      if (error === 87 || error === 1168) return null; // process exited before capture
      throw new Error(`OpenProcess ${pid}: Win32 ${error}`);
    }
    const h = handle(raw), created = new BigUint64Array(1), exit = new BigUint64Array(1), kernel = new BigUint64Array(1), user = new BigUint64Array(1);
    try { check(api.GetProcessTimes(h, ptr(created), ptr(exit), ptr(kernel), ptr(user)), 'GetProcessTimes'); return new ProcessRef(pid, h, created[0]); }
    catch (error) { api.CloseHandle(h); throw error; }
  }
  alive() { const status = api.WaitForSingleObject(this.handle, 0); assert(status === 0 || status === 258, `WaitForSingleObject ${status}`); return status === 258; }
  close() { if (!this.closed) { this.closed = true; check(api.CloseHandle(this.handle), 'Close process handle'); } }
}
export class ProcessJob {
  private h: Pointer | null;
  constructor() {
    this.h = handle(api.CreateJobObjectW(null, null));
    const limits = new Uint8Array(144); new DataView(limits.buffer).setUint32(16, 0x2000, true);
    try { check(api.SetInformationJobObject(this.h, 9, ptr(limits), limits.length), 'SetInformationJobObject'); }
    catch (error) { api.CloseHandle(this.h); this.h = null; throw error; }
  }
  assign(process: ProcessRef) {
    assert(this.h, 'Job closed');
    if (!process.alive()) return;
    const member = new Int32Array(1); check(api.IsProcessInJob(process.handle, this.h, ptr(member)), 'IsProcessInJob');
    if (!member[0]) check(api.AssignProcessToJobObject(this.h, process.handle), `AssignProcessToJobObject ${process.pid}`);
  }
  /** Borrow only for PROC_THREAD_ATTRIBUTE_JOB_LIST. Never close or inherit. */
  creationHandle(): Pointer { assert(this.h, 'Job closed'); return this.h; }
  members(): number[] {
    return this.h ? jobMembers(this.h) : [];
  }
  close() { if (this.h) { check(api.CloseHandle(this.h), 'Close Job'); this.h = null; } }
}
/** Parent PID alone is not identity: old children can outlive a previous PID holder. */
export function captureTree(root: ProcessRef, table: ProcessRow[]): ProcessRef[] {
  const captured = new Map<number, ProcessRef>([[root.pid, root]]), opened: ProcessRef[] = [];
  try {
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of table) {
        const parent = captured.get(row.parentPid);
        if (!parent || captured.has(row.pid)) continue;
        const child = ProcessRef.open(row.pid);
        if (!child) continue;
        if (!child.alive() || child.created < parent.created) { child.close(); continue; }
        captured.set(row.pid, child); opened.push(child); changed = true;
      }
    }
    return opened;
  } catch (cause) { for (const child of opened) child.close(); throw cause; }
}
export function jobMembers(h:Pointer):number[]{
    for (let capacity = 64; capacity <= 65536; capacity *= 2) {
      const bytes = new Uint8Array(8 + capacity * 8), returned = new Uint32Array(1);
      if (!api.QueryInformationJobObject(h, 3, ptr(bytes), bytes.length, ptr(returned))) {
        if (api.GetLastError() === 234) continue;
        throw new Error(`QueryInformationJobObject: Win32 ${api.GetLastError()}`);
      }
      const view = new DataView(bytes.buffer), count = view.getUint32(4, true);
      return Array.from({ length: count }, (_, i) => Number(view.getBigUint64(8 + i * 8, true)));
    }
    throw new Error('Job membership exceeds bounded query buffer');
}


