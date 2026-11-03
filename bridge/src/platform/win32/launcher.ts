// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { realpathSync } from 'node:fs';
import { ProcessJob, ProcessRef } from './job';
import { error } from './paths';

const k = dlopen('kernel32.dll', {
  CreateProcessW: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'i32', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'i32' },
  ResumeThread: { args: ['ptr'], returns: 'u32' },
  CloseHandle: { args: ['ptr'], returns: 'i32' },
  GetLastError: { args: [], returns: 'u32' },
  InitializeProcThreadAttributeList: { args: ['ptr', 'u32', 'u32', 'ptr'], returns: 'i32' },
  UpdateProcThreadAttribute: { args: ['ptr', 'u32', 'u64', 'ptr', 'u64', 'ptr', 'ptr'], returns: 'i32' },
  DeleteProcThreadAttributeList: { args: ['ptr'], returns: 'void' },
}).symbols;
const wide = (s: string) => Buffer.from(s + '\0', 'utf16le');
export function quoteArgument(s: string): string {
  if (s.includes('\0')) throw error('EINVAL', 'NUL in process argument');
  return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}
function check(ok: unknown, label: string): asserts ok { if (!ok) throw error('EIO', `${label}: Win32 ${k.GetLastError()}`); }

/** Noninteractive worker only. No inherited handles, shell lookup or signal
 * APIs. Windows assigns the Job as part of process creation, before execution;
 * no create-suspended / assign gap is exposed to an owner crash. */
export function launch(argv: string[], cwd: string, environment?: Record<string, string>) {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw error('ENOTSUP', 'Native launcher validated on Windows x64 only');
  if (!argv.length) throw error('EINVAL', 'Missing executable');
  const executable = realpathSync.native(argv[0]), directory = realpathSync.native(cwd);
  const command = wide([executable, ...argv.slice(1)].map(quoteArgument).join(' '));
  if (command.length > 65534) throw error('EINVAL', 'Windows command line exceeds 32767 UTF-16 code units');
  const app = wide(executable), dir = wide(directory), startup = new Uint8Array(112), info = new Uint8Array(24);
  const values = new Map<string, string>();
  for (const [key, value] of Object.entries(environment ?? process.env)) {
    if (value === undefined) continue;
    if (!key || /[=\0]/.test(key) || value.includes('\0')) throw error('EINVAL', 'Invalid process environment');
    values.set(key.toUpperCase(), value);
  }
  const block = Buffer.from([...values].sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\0') + '\0\0', 'utf16le');
  new DataView(startup.buffer).setUint32(0, 112, true);
  const job = new ProcessJob(); let processHandle: Pointer | null = null, thread: Pointer | null = null, ref: ProcessRef | null = null, attributes: Uint8Array | undefined, initialized = false;
  try {
    const size = new BigUint64Array(1); k.InitializeProcThreadAttributeList(null, 1, 0, ptr(size));
    check(size[0] > 0n && size[0] <= 65536n, 'Process attribute length');
    attributes = new Uint8Array(Number(size[0]));
    check(k.InitializeProcThreadAttributeList(ptr(attributes), 1, 0, ptr(size)), 'Initialize process attributes'); initialized = true;
    const jobs = new BigUint64Array([BigInt(job.creationHandle())]);
    check(k.UpdateProcThreadAttribute(ptr(attributes), 0, 0x2000d, ptr(jobs), 8, null, null), 'Set process creation Job list');
    new DataView(startup.buffer).setBigUint64(104, BigInt(ptr(attributes)), true);
    check(k.CreateProcessW(ptr(app), ptr(command), null, null, 0, 0x08080404, ptr(block), ptr(dir), ptr(startup), ptr(info)), 'CreateProcessW with Job list');
    const view = new DataView(info.buffer);
    processHandle = Number(view.getBigUint64(0, true)) as Pointer; thread = Number(view.getBigUint64(8, true)) as Pointer;
    const pid = view.getUint32(16, true); ref = ProcessRef.open(pid); check(ref, 'Open suspended process');
    check(job.members().includes(pid), 'Kernel Job assignment before resume');
    check(k.ResumeThread(thread) !== 0xffffffff, 'ResumeThread');
    let disposed = false;
    return {
      pid, members: () => job.members(), alive: () => ref!.alive(), closeJob: () => job.close(),
      dispose() { if (!disposed) { disposed = true; job.close(); ref!.close(); } },
    };
  } catch (e) {
    job.close(); ref?.close(); throw e;
  } finally {
    if (initialized) k.DeleteProcThreadAttributeList(ptr(attributes!));
    if (thread) k.CloseHandle(thread); if (processHandle) k.CloseHandle(processHandle);
  }
}
