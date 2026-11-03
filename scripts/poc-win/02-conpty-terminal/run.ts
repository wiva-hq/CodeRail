// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assert, assertGone, baseline, cmd, descendantPids, encoded, killTree, processTable, ps, result, run, until, utf8 } from '../common';
import { spawnNative, quote } from './win32';
baseline();
const node = process.env.POC_NODE_PATH ?? Bun.which('node')!;
const ticker = join(import.meta.dir, 'ticker.cjs');
let ok = true;

ok = await result('node-pty-prebuilt-under-bun', async () => {
  // V8 ABI addons may abort the runtime: probe in its own process.
  const child = await run([process.execPath, join(import.meta.dir, 'nodepty-probe.ts')], { timeout: 20000 });
  return { supported: child.code === 0, cleanShutdown: child.code === 0 && !child.stderr.includes('AttachConsole failed'), exitCode: child.code, stdout: child.stdout.trim(), stderr: child.stderr.slice(0, 1500) };
}) && ok;

ok = await result('ffi-createpseudoconsole-io-resize', async () => {
  const child = spawnNative([node, join(import.meta.dir, 'ffi-io.cjs')], { cwd: artifacts, conpty: true, job: true });
  let output = ''; const decoder = new TextDecoder('utf-8');
  const drain = () => { output += decoder.decode(child.read(), { stream: true }); };
  const timer = setInterval(drain, 10);
  try {
    await until(() => output.includes('FFI_READY中文😀'));
    child.write('双向中文😀\r');
    await until(() => output.includes('ROUNDTRIP=双向中文😀'));
    child.resize(132, 43); await Bun.sleep(200); child.write('SIZE\r');
    await until(() => output.includes('SIZE=132x43'));
    assert(output.includes('\x1b[')); assert(!output.includes('\uFFFD'));
    child.closeJob(); await assertGone([child.pid]);
    return { pid: child.pid, chineseEmoji: true, bidirectional: true, resize: '132x43', jobClosed: true };
  } finally { await Bun.write(join(artifacts, 'ffi-terminal.txt'), output); clearInterval(timer); child.dispose(); await assertGone([child.pid]); }
}) && ok;

for (const shell of [ps, ...(process.env.POC_PWSH_PATH ? [process.env.POC_PWSH_PATH] : []), cmd]) {
  ok = await result(`bun-conpty-shell:${shell}`, async () => {
    let output = ''; const decoder = new TextDecoder('utf-8');
    const isCmd = shell.toLowerCase().endsWith('cmd.exe');
    const command = isCmd ? [shell, '/Q', '/K', 'chcp 65001 >nul'] : [shell, '-NoLogo', '-NoProfile', '-NoExit', '-Command', utf8 + 'chcp 65001 >$null'];
    const child = Bun.spawn(command, { cwd: artifacts, windowsHide: true, terminal: { cols: 80, rows: 24, data(_term, bytes) { output += decoder.decode(bytes, { stream: true }); } } });
    try {
      assert(child.terminal, 'terminal handle missing');
      await Bun.sleep(800);
      child.terminal.write(isCmd ? `${quote(node)} ${quote(ticker)}\r` : `& ${quote(node)} ${quote(ticker)}\r`);
      await until(() => output.includes('持续中文😀'));
      child.terminal.write('输入中文😀\r');
      await until(() => output.includes('ROUNDTRIP=输入中文😀'));
      child.terminal.resize(127, 39); await Bun.sleep(250);
      child.terminal.write('EXIT\r'); await Bun.sleep(500);
      // Node's cached stdout size remains 80x24 on this host; query the actual
      // Windows console through a freshly started native .NET console client.
      const sizeScript = "[Console]::WriteLine('CONSOLE_SIZE='+[string][Console]::WindowWidth+'x'+[string][Console]::WindowHeight)";
      const sizeCommand = `${quote(ps)} -NoProfile -NonInteractive -EncodedCommand ${encoded(sizeScript)}`;
      child.terminal.write((isCmd ? sizeCommand : '& ' + sizeCommand) + '\r');
      await until(() => output.includes('CONSOLE_SIZE=127x39'));
      assert(!output.includes('\uFFFD'));
      assert(output.includes('\x1b['));
      await killTree(child.pid); await child.exited; await assertGone([child.pid]);
      return { chineseEmoji: true, bidirectional: true, resize: '127x39', explicitUtf8: true };
    } finally { await Bun.write(join(artifacts, `shell-${isCmd ? 'cmd' : shell.toLowerCase().endsWith('pwsh.exe') ? 'pwsh' : 'powershell'}.txt`), output); await killTree(child.pid); }
  }) && ok;
}

ok = await result('websocket-detach-replay-live-terminal', async () => {
  let buffer = Buffer.alloc(0), sequence = 0;
  const sockets = new Set<any>();
  const child = Bun.spawn([node, ticker], { cwd: artifacts, windowsHide: true, terminal: { cols: 80, rows: 24, data(_term, bytes) {
    buffer = Buffer.concat([buffer, bytes]).subarray(-256 * 1024); sequence++;
    for (const ws of sockets) ws.send(JSON.stringify({ kind: 'live', sequence, data: Buffer.from(bytes).toString('base64') }));
  } } });
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response(); }, websocket: {
    open(ws) { sockets.add(ws); ws.send(JSON.stringify({ kind: 'replay', sequence, data: buffer.toString('base64') })); },
    close(ws) { sockets.delete(ws); }, message(_ws, data) { child.terminal!.write(String(data)); },
  } });
  let first: WebSocket | undefined, second: WebSocket | undefined;
  try {
    await until(() => buffer.length > 0);
    first = new WebSocket(`ws://127.0.0.1:${server.port}`);
    await until(() => first!.readyState === WebSocket.OPEN);
    first.close(); await until(() => sockets.size === 0);
    const atDetach = sequence; await Bun.sleep(1000); assert(sequence > atDetach + 3);
    const frames: any[] = []; second = new WebSocket(`ws://127.0.0.1:${server.port}`);
    second.onmessage = event => frames.push(JSON.parse(String(event.data)));
    await until(() => frames.some(f => f.kind === 'replay') && frames.some(f => f.kind === 'live'));
    assert(frames[0].sequence > atDetach);
    second.send('重连输入\r');
    await until(() => buffer.toString('utf8').includes('ROUNDTRIP=重连输入'));
    return { samePid: child.pid, detachedTicks: sequence - atDetach, replayBytes: Buffer.from(frames[0].data, 'base64').length, liveFrames: frames.filter(f => f.kind === 'live').length, reconnectInput: true };
  } finally { first?.close(); second?.close(); server.stop(true); await killTree(child.pid); await child.exited; await assertGone([child.pid]); }
}) && ok;

for (const strategy of ['job', 'taskkill'] as const) {
  ok = await result(`zero-orphans:${strategy}`, async () => {
    const runs: unknown[] = [];
    for (let iteration = 0; iteration < 3; iteration++) {
      const pidFile = join(artifacts, `tree-${strategy}-${Date.now()}.jsonl`);
      const line = `& ${quote(node)} ${quote(join(import.meta.dir, 'tree-child.cjs'))} ${quote(pidFile)}`;
      const child = spawnNative([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(line)], { cwd: artifacts, job: strategy === 'job' });
      let pids = [child.pid];
      try {
        await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().split('\n').length >= 4);
        pids = [...new Set([child.pid, ...readFileSync(pidFile, 'utf8').trim().split('\n').map(line => JSON.parse(line).pid)])];
        assert.equal(pids.length, 4, 'PowerShell -> Node -> Node -> ping chain');
        const before = await processTable(); assert(pids.every(pid => before.some(p => p.ProcessId === pid)));
        if (strategy === 'job') child.closeJob(); else { const r = await killTree(child.pid); assert.equal(r.code, 0, r.stderr); }
        await assertGone(pids);
        runs.push({ iteration, trackedPids: pids, remaining: 0 });
      } finally { await killTree(child.pid); child.dispose(); for (const pid of pids) if ((await processTable()).some(p => p.ProcessId === pid)) await killTree(pid); await assertGone(pids); }
    }
    return { strategy, runs, verification: 'Get-CimInstance Win32_Process', suspendedBeforeJobAssignment: strategy === 'job' };
  }) && ok;
}

ok = await result('job-kill-on-owner-crash', async () => {
  const pidFile = join(artifacts, 'owner-tree-' + Date.now() + '.jsonl');
  const readyFile = pidFile + '.ready';
  const owner = Bun.spawn([process.execPath, join(import.meta.dir, 'job-owner.ts'), pidFile, readyFile], { env: process.env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  let pids: number[] = [];
  try {
    await until(() => existsSync(readyFile) && existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().split('\n').length >= 4);
    const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
    pids = [...new Set([ready.rootPid, ...readFileSync(pidFile, 'utf8').trim().split('\n').map(line => JSON.parse(line).pid)])];
    assert.equal(pids.length, 4);
    // No /T here is intentional: simulate abrupt bridge death, not tree cleanup.
    const crash = await run([join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), '/F', '/PID', String(owner.pid)]);
    assert.equal(crash.code, 0, crash.stderr); await owner.exited;
    await assertGone(pids);
    return { ownerPid: owner.pid, trackedPids: pids, remaining: 0, kernelClosedLastJobHandle: true };
  } finally { await killTree(owner.pid); for (const pid of pids) if ((await processTable()).some(p => p.ProcessId === pid)) await killTree(pid); await assertGone(pids); }
}) && ok;

ok = await result('bun-terminal-worker-contained-by-job', async () => {
  const pidFile = join(artifacts, 'worker-tree-' + Date.now() + '.jsonl'), readyFile = pidFile + '.ready';
  const worker = spawnNative([process.execPath, join(import.meta.dir, 'terminal-worker.ts'), pidFile, readyFile], { cwd: artifacts, job: true });
  let pids = [worker.pid];
  try {
    await until(() => existsSync(readyFile) && existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim().split('\n').length >= 4);
    const ready = JSON.parse(readFileSync(readyFile, 'utf8'));
    pids = [...new Set([worker.pid, ready.terminalPid, ...readFileSync(pidFile, 'utf8').trim().split('\n').map(line => JSON.parse(line).pid)])];
    assert.equal(pids.length, 5, 'Bun worker -> ConPTY PowerShell -> Node -> Node -> ping');
    const table = await processTable(); assert(pids.every(pid => table.some(p => p.ProcessId === pid)));
    pids = descendantPids(pids, table);
    worker.closeJob(); await assertGone(pids);
    return { trackedPids: pids, remaining: 0, design: 'assign suspended Bun worker before it can spawn ConPTY; bridge owns Job handle' };
  } finally { await killTree(worker.pid); worker.dispose(); for (const pid of pids) if ((await processTable()).some(p => p.ProcessId === pid)) await killTree(pid); await assertGone(pids); }
}) && ok;
process.exitCode = ok ? 0 : 1;
