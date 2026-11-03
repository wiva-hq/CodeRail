// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, baseline, until } from '../common';
import { spawnStream } from '../08-runtime-integration/stream';
import { ensurePrivateDirectory, writePrivateFile } from '../08-runtime-integration/private-fs';
import { contains, retry } from '../04-filesystem/paths';

baseline();
test('production Bridge: token-check blackhole, stalled upgrade and simulated clock-gap trigger reconnect within 5s', async () => {
  const root = await mkdtemp(join(artifacts, 'reconnect-')); ensurePrivateDirectory(root);
  let attempts = 0, tokenChecks = 0, stall = false;
  const sockets = new Set<import('bun').ServerWebSocket<unknown>>();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') { tokenChecks++; return new Promise<Response>(() => {}); }
    attempts++; if (stall) return new Promise<Response>(() => {});
    return server.upgrade(request) ? undefined : new Response('Upgrade required', { status: 400 });
  }, websocket: { open(ws) { sockets.add(ws); }, close(ws) { sockets.delete(ws); }, message(ws, message) { if (JSON.parse(String(message)).t === 'ping') ws.send(JSON.stringify({ t: 'pong' })); } } });
  const fixture = join(root, 'bridge-fixture.ts'), resume = join(root, 'simulate-clock-gap.flag');
  const implementation = join(import.meta.dir, '../../../bridge/src/bridge.ts').replaceAll('\\', '/');
  writePrivateFile(fixture, `import {Bridge} from ${JSON.stringify(implementation)};const bridge=new Bridge({server:process.argv[2],machineId:'poc',token:'local-only',name:'poc'});bridge.start();setInterval(()=>{if(require('node:fs').existsSync(${JSON.stringify(resume)})){require('node:fs').unlinkSync(${JSON.stringify(resume)});bridge['lastTick']=Date.now()-10000;}},50);`);
  const child = await spawnStream([process.execPath, fixture, `http://127.0.0.1:${server.port}`], { cwd: root, keepBun: true, env: { ...process.env as Record<string, string>, CODERAIL_HOME: root } });
  const drain = async (stream: ReadableStream<Uint8Array>) => { for await (const _ of stream) {} };
  const stdout = drain(child.stdout), stderr = drain(child.stderr);
  try {
    await until(() => sockets.size === 1);
    let before = attempts, start = performance.now(); for (const socket of sockets) socket.close(1012, 'network test');
    await until(() => attempts > before, 5000, 'reconnect after failed token probe');
    expect(performance.now() - start).toBeLessThan(5000); expect(tokenChecks).toBeGreaterThan(0);
    await until(() => sockets.size === 1);
    before = attempts; start = performance.now(); writePrivateFile(resume, 'simulate only; not real sleep');
    await until(() => attempts > before, 2500, 'simulated clock gap'); expect(performance.now() - start).toBeLessThan(2500);
    await until(() => sockets.size === 1);
    stall = true; before = attempts; writePrivateFile(resume, 'simulate only');
    await until(() => attempts > before, 2500); start = performance.now(); stall = false;
    await until(() => attempts > before + 1 && sockets.size === 1, 4000, 'stalled upgrade aborted and retried');
    expect(performance.now() - start).toBeLessThan(4000);
    console.log(JSON.stringify({ tokenProbeBounded: true, stalledUpgradeRecovered: true, simulatedClockGap: true, realSleepTest: false }));
  } finally {
    child.stop(); await child.exited; await Promise.all([stdout, stderr]); server.stop(true);
    if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup'); await retry(() => rm(root, { recursive: true }));
  }
}, 30000);
