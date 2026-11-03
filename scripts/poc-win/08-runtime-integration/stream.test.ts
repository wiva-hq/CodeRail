// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { artifacts, assertGone, baseline, ps, until, utf8 } from '../common';
import { spawnStream } from './stream';

baseline();
test('managed natural exit drains final output before completion; unread flooding fails boundedly', async () => {
  const proc = await spawnStream([process.execPath, '-e', 'process.stdout.write("尾部 中文😀".repeat(10000))'], { cwd: artifacts, keepBun: true });
  const output = await new Response(proc.stdout).text();
  expect(await proc.exited).toBe(0); expect(output).toBe('尾部 中文😀'.repeat(10000)); expect(proc.failure).toBeUndefined();
  const flood = await spawnStream([process.execPath, '-e', 'for await(const line of console){process.stdout.write("x".repeat(8*1024*1024));setInterval(()=>{},1000);break;}'], { cwd: artifacts, keepBun: true });
  const pids = flood.members(); flood.write('go\n');
  await flood.exited;
  expect(flood.failure?.message).toContain('bounded buffer');
  expect(flood.peakQueuedBytes).toBeLessThanOrEqual(4 * 1024 * 1024); await assertGone(pids);
}, 30000);
test('managed stream: bidirectional UTF-8 RPC, process remains until explicit whole Job stop', async () => {
  const script = 'for await(const line of console){console.log(JSON.stringify({echo:line,pid:process.pid}));}';
  const proc = await spawnStream([process.execPath, '-e', script], { cwd: artifacts, keepBun: true });
  const reader = proc.stdout.getReader();
  try {
    proc.write('中文 RPC😀\n');
    const result = await reader.read(); expect(result.done).toBe(false);
    expect(JSON.parse(new TextDecoder().decode(result.value)).echo).toBe('中文 RPC😀');
    expect(proc.members()).toContain(proc.pid);
  } finally {
    const pids = proc.members(); proc.stop(); await proc.exited; await assertGone(pids); reader.releaseLock();
  }
}, 30000);

test('managed ConPTY: resize, continued output while detached, nested children cleaned', async () => {
  let text = ''; const decoder = new TextDecoder();
  const proc = await spawnStream([ps, '-NoLogo', '-NoProfile', '-NoExit', '-Command', utf8], { cwd: artifacts, terminal: { cols: 80, rows: 24, data(bytes) { text += decoder.decode(bytes, { stream: true }); } } });
  try {
    proc.resize(111, 37);
    proc.write("[Console]::WriteLine('宽度:'+ $Host.UI.RawUI.WindowSize.Width);[Console]::WriteLine('持续 中文😀');\r");
    await until(() => text.includes('宽度:111') && text.includes('持续 中文😀'), 15000);
    expect(text).toContain('宽度:111'); expect(text).not.toContain('\ufffd');
    proc.write("$p=Start-Process ping.exe -ArgumentList '-t','127.0.0.1' -WindowStyle Hidden -PassThru;[Console]::WriteLine('CHILD:'+ $p.Id);\r");
    await until(() => /CHILD:\d+/.test(text), 15000);
    expect(proc.members().length).toBeGreaterThanOrEqual(3);
  } finally { const pids = proc.members(); proc.stop(); await proc.exited; await assertGone(pids); }
}, 40000);
