// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

export { assert };
export const root = realpathSync.native(import.meta.dir);
export const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
export const ps = join(process.env.SystemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
export const cmd = join(process.env.SystemRoot!, 'System32', 'cmd.exe');
export const utf8 = '[Console]::InputEncoding=[Console]::OutputEncoding=$OutputEncoding=[System.Text.UTF8Encoding]::new($false);';
export function baseline() {
  assert.equal(process.platform, 'win32');
  assert.equal(Bun.version, '1.4.4', 'Use the CI-pinned Bun 1.4.4');
}
export async function until(check: () => boolean | Promise<boolean>, timeout = 15000, label = 'condition') {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
  throw new Error(`Timeout waiting for ${label}`);
}
export async function run(argv: string[], options: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number } = {}) {
  const p = Bun.spawn(argv, { cwd: options.cwd, env: options.env ?? process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const timer = setTimeout(() => { void killTree(p.pid).catch(() => {}); }, options.timeout ?? 30000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}
export function encoded(script: string) { return Buffer.from(utf8 + script, 'utf16le').toString('base64'); }
export function powershell(script: string) { return run([ps, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)]); }
export async function killTree(pid: number) {
  assert(Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  const p = Bun.spawn([join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), '/F', '/T', '/PID', String(pid)], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { stdout, stderr, code };
}
export async function processTable() {
  const r = await powershell('Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress');
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout) as Array<{ ProcessId: number; ParentProcessId: number; Name: string }>;
}
export async function assertGone(pids: number[]) {
  await until(async () => { const table = await processTable(); return pids.every(pid => !table.some(p => p.ProcessId === pid)); }, 20000, `PIDs gone: ${pids}`);
}
export function descendantPids(roots: number[], table: Awaited<ReturnType<typeof processTable>>) {
  const all = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of table) if (all.has(p.ParentProcessId) && !all.has(p.ProcessId)) { all.add(p.ProcessId); changed = true; }
  }
  return [...all];
}
export async function result(name: string, test: () => Promise<unknown>) {
  if (process.env.POC_FILTER && !new RegExp(process.env.POC_FILTER).test(name)) {
    console.log(JSON.stringify({ name, status: 'SKIP', reason: 'POC_FILTER' })); return true;
  }
  const start = Date.now();
  try {
    const details = await test();
    console.log(JSON.stringify({ name, status: 'PASS', durationMs: Date.now() - start, details }));
    return true;
  } catch (error: any) {
    console.log(JSON.stringify({ name, status: 'FAIL', durationMs: Date.now() - start, error: error?.stack ?? String(error) }));
    return false;
  }
}
