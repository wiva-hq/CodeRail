// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { dlopen, ptr, type Pointer } from 'bun:ffi';
import { assert } from '../common';
import { jobMembers } from '../../../bridge/src/platform/win32/job';
const lib = dlopen('kernel32.dll', {
  GetCurrentProcessId: { args: [], returns: 'u32' }, GetLastError: { args: [], returns: 'u32' },
  CloseHandle: { args: ['ptr'], returns: 'bool' },
  CreatePipe: { args: ['ptr', 'ptr', 'ptr', 'u32'], returns: 'bool' },
  CreatePseudoConsole: { args: ['i32', 'ptr', 'ptr', 'u32', 'ptr'], returns: 'i32' },
  ResizePseudoConsole: { args: ['ptr', 'i32'], returns: 'i32' },
  ClosePseudoConsole: { args: ['ptr'], returns: 'void' },
  InitializeProcThreadAttributeList: { args: ['ptr', 'u32', 'u32', 'ptr'], returns: 'bool' },
  UpdateProcThreadAttribute: { args: ['ptr', 'u32', 'u64', 'ptr', 'u64', 'ptr', 'ptr'], returns: 'bool' },
  DeleteProcThreadAttributeList: { args: ['ptr'], returns: 'void' },
  CreateProcessW: { args: ['ptr', 'ptr', 'ptr', 'ptr', 'bool', 'u32', 'ptr', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
  ResumeThread: { args: ['ptr'], returns: 'u32' },
  OpenProcess: { args: ['u32', 'bool', 'u32'], returns: 'ptr' },
  CreateJobObjectW: { args: ['ptr', 'ptr'], returns: 'ptr' },
  SetInformationJobObject: { args: ['ptr', 'i32', 'ptr', 'u32'], returns: 'bool' },
  AssignProcessToJobObject: { args: ['ptr', 'ptr'], returns: 'bool' },
  PeekNamedPipe: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr', 'ptr'], returns: 'bool' },
  ReadFile: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
  WriteFile: { args: ['ptr', 'ptr', 'u32', 'ptr', 'ptr'], returns: 'bool' },
  GetExitCodeProcess: { args: ['ptr', 'ptr'], returns: 'bool' },
  FreeConsole: { args: [], returns: 'bool' }, AttachConsole: { args: ['u32'], returns: 'bool' },
  SetConsoleCtrlHandler: { args: ['ptr', 'bool'], returns: 'bool' },
  GenerateConsoleCtrlEvent: { args: ['u32', 'u32'], returns: 'bool' },
});
export const k = lib.symbols;
export function checked(value: unknown, name: string): asserts value { assert(value, `${name}: Win32 ${k.GetLastError()}`); }
const wide = (s: string) => Buffer.from(s + '\0', 'utf16le');
const handle = (b: BigUint64Array) => Number(b[0]) as Pointer;
export function quote(s: string) { return '"' + s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"'; }

/** Used before sending any model work to the newly created app-server. */
export function containProcess(pid: number) {
  const job = k.CreateJobObjectW(null, null); checked(job, 'CreateJobObject');
  const limits = new Uint8Array(144); new DataView(limits.buffer).setUint32(16, 0x2000, true);
  checked(k.SetInformationJobObject(job, 9, ptr(limits), limits.length), 'SetInformationJobObject');
  const processHandle = k.OpenProcess(0x501, false, pid); checked(processHandle, 'OpenProcess');
  try { checked(k.AssignProcessToJobObject(job, processHandle), 'AssignProcessToJobObject'); }
  catch (error) { k.CloseHandle(job); throw error; }
  finally { k.CloseHandle(processHandle); }
  let open = true;
  return { close() { if (open) { checked(k.CloseHandle(job), 'Close Job'); open = false; } } };
}

/** x64-only PoC: struct sizes/offsets must not be reused for ARM64 without validation. */
export function spawnNative(argv: string[], options: { cwd: string; conpty?: boolean; job?: boolean; newConsole?: boolean }) {
  assert.equal(process.arch, 'x64');
  let job: Pointer | null = null;
  if (options.job) {
    const rawJob = k.CreateJobObjectW(null, null); checked(rawJob, 'CreateJobObject');
    assert(Number.isSafeInteger(Number(rawJob)), 'Job handle must be exactly representable');
    job = Number(rawJob) as Pointer;
    const limits = new Uint8Array(144);
    new DataView(limits.buffer).setUint32(16, 0x2000, true); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    checked(k.SetInformationJobObject(job, 9, ptr(limits), limits.length), 'SetInformationJobObject');
  }
  let hp: Pointer | null = null, input: Pointer | null = null, output: Pointer | null = null;
  let attribute: Uint8Array | undefined;
  const si = new Uint8Array(options.conpty ? 112 : 104);
  const siView = new DataView(si.buffer); siView.setUint32(0, si.length, true);
  if (options.conpty) {
    const inRead = new BigUint64Array(1), inWrite = new BigUint64Array(1), outRead = new BigUint64Array(1), outWrite = new BigUint64Array(1), hpc = new BigUint64Array(1);
    checked(k.CreatePipe(ptr(inRead), ptr(inWrite), null, 0), 'CreatePipe stdin');
    checked(k.CreatePipe(ptr(outRead), ptr(outWrite), null, 0), 'CreatePipe stdout');
    const hr = k.CreatePseudoConsole((24 << 16) | 80, handle(inRead), handle(outWrite), 0, ptr(hpc));
    k.CloseHandle(handle(inRead)); k.CloseHandle(handle(outWrite));
    assert.equal(hr, 0, `CreatePseudoConsole HRESULT ${hr}`);
    hp = handle(hpc); input = handle(inWrite); output = handle(outRead);
    const size = new BigUint64Array(1); k.InitializeProcThreadAttributeList(null, 1, 0, ptr(size));
    attribute = new Uint8Array(Number(size[0]));
    checked(k.InitializeProcThreadAttributeList(ptr(attribute), 1, 0, ptr(size)), 'InitializeProcThreadAttributeList');
    checked(k.UpdateProcThreadAttribute(ptr(attribute), 0, 0x20016, hp, 8, null, null), 'UpdateProcThreadAttribute');
    siView.setBigUint64(104, BigInt(ptr(attribute)), true);
  }
  const pi = new Uint8Array(24), command = wide(argv.map(quote).join(' ')), cwd = wide(options.cwd);
  const flags = 0x4 | 0x400 | (options.conpty ? 0x80000 : 0) | (options.newConsole ? 0x10 : options.conpty ? 0 : 0x08000000);
  // Hide even a dedicated console used for the Ctrl+C event probe.
  siView.setUint32(60, 1, true); siView.setUint16(64, 0, true);
  checked(k.CreateProcessW(null, ptr(command), null, null, false, flags, null, ptr(cwd), ptr(si), ptr(pi)), 'CreateProcessW');
  if (attribute) k.DeleteProcThreadAttributeList(ptr(attribute));
  const view = new DataView(pi.buffer), processHandle = Number(view.getBigUint64(0, true)) as Pointer, thread = Number(view.getBigUint64(8, true)) as Pointer;
  const pid = view.getUint32(16, true);
  if (job) checked(k.AssignProcessToJobObject(job, processHandle), 'AssignProcessToJobObject before resume');
  assert.notEqual(k.ResumeThread(thread), 0xffffffff, 'ResumeThread'); k.CloseHandle(thread);
  return {
    pid,
    members() { return job ? jobMembers(job) : []; },
    read() {
      if (!output) return new Uint8Array();
      const available = new Uint32Array(1);
      if (!k.PeekNamedPipe(output, null, 0, null, ptr(available), null) || !available[0]) return new Uint8Array();
      const bytes = new Uint8Array(Math.min(available[0], 65536)), read = new Uint32Array(1);
      checked(k.ReadFile(output, ptr(bytes), bytes.length, ptr(read), null), 'ReadFile');
      return bytes.subarray(0, read[0]);
    },
    write(text: string) {
      assert(input); const bytes = Buffer.from(text, 'utf8'), written = new Uint32Array(1);
      checked(k.WriteFile(input, ptr(bytes), bytes.length, ptr(written), null), 'WriteFile');
      assert.equal(written[0], bytes.length);
    },
    resize(cols: number, rows: number) { assert(hp); assert.equal(k.ResizePseudoConsole(hp, (rows << 16) | cols), 0); },
    alive() { const code = new Uint32Array(1); return !!k.GetExitCodeProcess(processHandle, ptr(code)) && code[0] === 259; },
    closeJob() { if (job) { checked(k.CloseHandle(job), 'Close job'); job = null; } },
    dispose() {
      this.closeJob();
      if (input) { k.CloseHandle(input); input = null; }
      if (output) { k.CloseHandle(output); output = null; }
      if (hp) { k.ClosePseudoConsole(hp); hp = null; }
      k.CloseHandle(processHandle);
    },
  };
}
