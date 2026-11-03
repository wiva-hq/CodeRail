// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import source from './stream-worker.txt' with { type: 'text' };
import { mkdtemp, rm } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { homedir } from 'node:os';
import { ensurePrivateDirectory, writePrivateFile } from './private-fs';
import { launch } from './launcher';
import { contains, nativeRealpath, retry } from './paths';
import { ProcessRef } from './job';
import { utf8 } from './shell';

async function until(check: () => boolean, timeout: number, label: string) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await Bun.sleep(25); }
  throw new Error(`Timeout waiting for ${label}`);
}

export async function spawnStream(argv: string[], options: { cwd: string; env?: Record<string, string>; keepBun?: boolean; terminal?: { cols: number; rows: number; data(bytes: Uint8Array): void } }) {
  if (options.terminal && argv.length === 1) {
    const name = win32.basename(argv[0]).toLowerCase();
    if (name === 'cmd.exe' || name === 'cmd') argv = [argv[0], '/D', '/K', 'chcp 65001>nul'];
    else if (['powershell', 'powershell.exe', 'pwsh', 'pwsh.exe'].includes(name)) argv = [argv[0], '-NoLogo', '-NoProfile', '-NoExit', '-Command', utf8];
  }
  const state = process.env.CODERAIL_HOME ?? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData/Local'), 'CodeRail');
  const runtime = join(state, 'runtime'); ensurePrivateDirectory(runtime);
  const base = await nativeRealpath(runtime);
  const root = await mkdtemp(join(base, 'managed-stream-')); ensurePrivateDirectory(root);
  const file = join(root, 'worker.js'); writePrivateFile(file, source);
  const token = crypto.randomUUID() + crypto.randomUUID();
  let socket: import('bun').ServerWebSocket<unknown> | undefined;
  let child: ReturnType<typeof launch> | undefined, ready = false, ended = false, exitCode = 1, failure: Error | undefined, pid = 0;
  let peakQueuedBytes = 0;
  let stdout!: ReadableStreamDefaultController<Uint8Array>, stderr!: ReadableStreamDefaultController<Uint8Array>;
  const streams = {
    stdout: new ReadableStream<Uint8Array>({ start(controller) { stdout = controller; } }, { highWaterMark: 4 * 1024 * 1024, size: chunk => chunk?.length ?? 0 }),
    stderr: new ReadableStream<Uint8Array>({ start(controller) { stderr = controller; } }, { highWaterMark: 4 * 1024 * 1024, size: chunk => chunk?.length ?? 0 }),
  };
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname !== '/' + token || socket) return new Response('Forbidden', { status: 403 });
    return server.upgrade(request) ? undefined : new Response('Upgrade required', { status: 400 });
  }, websocket: { maxPayloadLength: 1024 * 1024, open(ws) {
    socket = ws;
    ws.send(JSON.stringify({ type: 'start', argv, cwd: options.cwd, keepBun: options.keepBun, terminal: !!options.terminal, cols: options.terminal?.cols, rows: options.terminal?.rows }));
  }, message(ws, data) {
    try {
      const message = JSON.parse(String(data));
      if (message.type === 'ready') { pid = message.pid; ready = true; }
      else if (message.type === 'error') { failure = new Error(message.error); ended = true; }
      else if (message.type === 'exit') { exitCode = message.code; ended = true; }
      else if (message.type === 'data') {
        const bytes = Buffer.from(message.data, 'base64');
        if (message.channel === 'terminal') options.terminal!.data(bytes);
        else {
          const controller = message.channel === 'stdout' ? stdout : message.channel === 'stderr' ? stderr : null;
          if (!controller || (controller.desiredSize ?? 0) < bytes.length) throw new Error('Managed stream consumer exceeded bounded buffer');
          controller.enqueue(bytes);
          peakQueuedBytes = Math.max(peakQueuedBytes, 8 * 1024 * 1024 - (stdout.desiredSize ?? 0) - (stderr.desiredSize ?? 0));
        }
      } else throw new Error('Invalid worker message');
    } catch (error) { failure = error as Error; ended = true; ws.close(); }
  }, close() { if (!ended) { failure = new Error('Managed worker IPC disconnected'); ended = true; } } } });
  const finish = async () => {
    const refs: ProcessRef[] = [];
    try {
      if (child) for (const pid of child.members()) { const ref = ProcessRef.open(pid); if (ref) refs.push(ref); }
      child?.closeJob(); await until(() => refs.every(ref => !ref.alive()), 10000, 'Managed stream Job drained');
    } finally {
      for (const ref of refs) ref.close(); child?.dispose(); server.stop(true);
      stdout.close(); stderr.close();
      if (!contains(base, root)) throw new Error('Unsafe worker cleanup');
      await retry(() => rm(root, { recursive: true }));
    }
  };
  try {
    child = launch([process.execPath, file, `ws://127.0.0.1:${server.port}/${token}`], await nativeRealpath(options.cwd), { ...(options.env ?? process.env as Record<string, string>), BUN_BE_BUN: '1' });
    await until(() => ready || ended || !child!.alive(), 10000, 'Managed stream ready');
    if (!ready || ended) throw failure ?? new Error('Managed worker failed during startup');
  } catch (error) { ended = true; await finish(); throw error; }
  const exited = (async () => {
    while (!ended && child!.alive()) await Bun.sleep(25);
    await finish();
    return exitCode;
  })();
  const send = (message: unknown) => { if (ended || !socket) throw new Error('Managed worker closed'); socket.send(JSON.stringify(message)); };
  return {
    pid, workerPid: child.pid, ...streams, exited, members: () => child!.members(),
    write(data: string) {
      const bytes = Buffer.from(data, 'utf8'); if (bytes.length > 1024 * 1024) throw new Error('Input exceeds bounded IPC message');
      for (let offset = 0; offset < bytes.length; offset += 65536) send({ type: 'input', data: bytes.subarray(offset, offset + 65536).toString('base64') });
    },
    resize(cols: number, rows: number) {
      if (![cols, rows].every(n => Number.isInteger(n) && n >= 1 && n <= 1000)) throw new Error('Invalid terminal dimensions');
      send({ type: 'resize', cols, rows });
    },
    stop() { ended = true; },
    get failure() { return failure; },
    get peakQueuedBytes() { return peakQueuedBytes; },
  };
}
