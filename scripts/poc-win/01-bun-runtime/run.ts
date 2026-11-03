// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { watch, mkdirSync, writeFileSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from 'node:net';
import { artifacts, assert, baseline, cmd, encoded, killTree, ps, result, root, run, until } from '../common';
baseline();
let ok = true;

ok = await result('encoding-baseline-and-forced-utf8', async () => {
  const defaultsScript = "@{ consoleOut=[Console]::OutputEncoding.CodePage; pipeline=$OutputEncoding.CodePage; elevated=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) } | ConvertTo-Json -Compress";
  const defaults = await run([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(defaultsScript, 'utf16le').toString('base64')]);
  assert.equal(defaults.code, 0, defaults.stderr);
  const configured = await run([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded("[Console]::WriteLine('UTF8_中文😀'); [Console]::WriteLine([string]$OutputEncoding.CodePage)")]);
  assert.equal(configured.code, 0, configured.stderr);
  assert(configured.stdout.includes('UTF8_中文😀')); assert(configured.stdout.includes('65001'));
  const chcp = await run([cmd, '/d', '/c', 'chcp']);
  return { defaultPowerShell: JSON.parse(defaults.stdout), cmdCodePage: chcp.stdout.match(/\d+/)?.[0], forcedOutput: configured.stdout.trim() };
}) && ok;

ok = await result('compile-standalone-embedded-resource', async () => {
  const out = join(artifacts, 'standalone.exe');
  const build = await run([process.execPath, 'build', '--compile', '--target=bun-windows-x64', join(import.meta.dir, 'compiled.ts'), '--outfile', out], { timeout: 120000 });
  assert.equal(build.code, 0, build.stderr);
  const env = { ...process.env, PATH: '', Path: '', BUN_BE_BUN: undefined, NODE_OPTIONS: undefined };
  const execution = await run([out, '中文 参数'], { cwd: artifacts, env });
  assert.equal(execution.code, 0, execution.stderr);
  const data = JSON.parse(execution.stdout);
  assert.equal(data.asset, 'CodeRail embedded 中文 🛤️');
  assert.equal(data.standalone, true);
  assert.equal(data.version, '1.4.4');
  return data;
}) && ok;

ok = await result('bun-built-in-terminal-support', async () => {
  let error: any;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try { child = Bun.spawn([cmd, '/c', 'echo POC'], { terminal: { cols: 80, rows: 24, data() {} }, windowsHide: true }); await child.exited; }
  catch (e) { error = e; }
  finally { if (child) await killTree(child.pid); }
  return { supported: !error, code: error?.code, message: error?.message };
}) && ok;

ok = await result('websocket-throughput-disconnect-memory', async () => {
  const connections = new Set<any>();
  let received = 0, disconnected = 0, bytes = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch(req, server) { if (server.upgrade(req)) return; return new Response('PoC'); },
    websocket: {
      maxPayloadLength: 1024 * 1024,
      backpressureLimit: 8 * 1024 * 1024,
      open(ws) { connections.add(ws); },
      message(ws, data) { received++; bytes += typeof data === 'string' ? Buffer.byteLength(data, 'utf8') : data.byteLength; ws.send(data); },
      close(ws) { connections.delete(ws); disconnected++; },
    },
  });
  const clients: WebSocket[] = [];
  const rssBefore = process.memoryUsage().rss;
  let echoed = 0;
  try {
    const workers = 24, messages = 256;
    for (let i = 0; i < workers; i++) {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}`);
      ws.onmessage = () => echoed++;
      clients.push(ws);
    }
    await until(() => clients.every(ws => ws.readyState === WebSocket.OPEN));
    const start = performance.now();
    const payload = '中'.repeat(4096);
    for (let n = 0; n < messages; n++) {
      for (const ws of clients) ws.send(payload);
      if (n % 8 === 0) await Bun.sleep(1);
    }
    await until(() => echoed === workers * messages, 30000, 'all echo messages');
    const durationMs = performance.now() - start;
    const rssPeak = process.memoryUsage().rss;
    for (const ws of clients) ws.close();
    await until(() => connections.size === 0);
    // Abrupt TCP reset after a genuine WebSocket upgrade; no close handshake.
    for (let i = 0; i < 32; i++) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(server.port!, '127.0.0.1', () => socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
        socket.once('data', () => { socket.destroy(); resolve(); }); socket.once('error', reject);
      });
    }
    await until(() => connections.size === 0 && disconnected === workers + 32);
    Bun.gc(true); await Bun.sleep(1000); Bun.gc(true);
    const rssAfter = process.memoryUsage().rss;
    assert(rssAfter - rssBefore < 192 * 1024 * 1024, 'excessive retained RSS after disconnect');
    return { workers, received, echoed, utf8Bytes: bytes, durationMs, rssBefore, rssPeak, rssAfter, disconnected, remainingConnections: connections.size, memoryLimitBytes: 192 * 1024 * 1024 };
  } finally { for (const ws of clients) ws.close(); server.stop(true); }
}) && ok;

ok = await result('recursive-watcher-burst-and-locked-file', async () => {
  const dir = join(artifacts, `watch 中文 ${Date.now()}`);
  const nested = join(dir, 'nested'); mkdirSync(nested, { recursive: true });
  const events: string[] = [];
  let watchError: Error | undefined;
  const watcher = watch(dir, { recursive: true }, (_event, name) => events.push(String(name)));
  watcher.on('error', e => { watchError = e; });
  let locker: ReturnType<typeof Bun.spawn> | undefined;
  try {
    // fs.watch has no ready event; record an initial readiness probe before the burst.
    await Bun.sleep(250);
    for (let i = 0; i < 150; i++) writeFileSync(join(nested, `f${i}.txt`), `中文 ${i}`, 'utf8');
    for (let i = 0; i < 1000; i++) writeFileSync(join(nested, 'hot.txt'), String(i), 'utf8');
    renameSync(join(nested, 'f0.txt'), join(nested, 'renamed.txt'));
    try { await until(() => events.length > 0); }
    catch (error) { console.log(JSON.stringify({ watcherDiagnostics: { count: events.length, sample: events.slice(0, 15) } })); throw error; }
    const locked = join(nested, 'locked.txt'); writeFileSync(locked, 'old', 'utf8');
    const script = `$f=[IO.File]::Open('${locked.replaceAll("'", "''")}',[IO.FileMode]::Open,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None); [Console]::WriteLine('LOCKED'); try { Start-Sleep -Seconds 20 } finally { $f.Dispose() }`;
    locker = Bun.spawn([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const reader = (locker.stdout as ReadableStream<Uint8Array>).getReader();
    let ready = ''; while (!ready.includes('LOCKED')) { const next = await reader.read(); assert(!next.done, 'lock helper ended'); ready += new TextDecoder().decode(next.value); }
    let lockedError: string | undefined;
    try { writeFileSync(locked, 'new'); } catch (e: any) { lockedError = e.code; }
    assert(lockedError, 'exclusive Windows file handle should prevent replacement');
    await killTree(locker.pid); await locker.exited;
    writeFileSync(locked, 'after unlock', 'utf8');
    const beforeUnlockEvents = events.length;
    await until(() => events.length > beforeUnlockEvents || events.some(name => name.includes('locked')));
    assert.equal(watchError, undefined);
    assert.equal(readdirSync(nested).length, 152);
    assert.equal(await Bun.file(join(nested, 'hot.txt')).text(), '999');
    const observed = new Set(events);
    return { writes: 1153, events: events.length, uniqueNames: observed.size, overflowOrMissingName: observed.has('null'), reconciledFiles: readdirSync(nested).length, createdNamesObserved: Array.from({ length: 150 }, (_, i) => `f${i}.txt`).filter(name => [...observed].some(e => e.endsWith(name))).length, lockedError, recursive: true, policy: 'events coalesce/overflow; null filename MUST trigger a full rescan; per-file delivery is NOT reliable' };
  } finally { watcher.close(); if (locker) await killTree(locker.pid); }
}) && ok;
process.exitCode = ok ? 0 : 1;
