// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { UserService } from './service';
import { UserAutorun } from './autorun';
import { runWindows } from '../05-git/process';
import { contains, retry } from '../04-filesystem/paths';
import { baseline, until } from '../common';
import { writePrivateFile } from '../08-runtime-integration/private-fs';
import type { ServiceSpec } from '../../../bridge/src/platform/types';

baseline();
test('compiled production Bridge: hidden current-user service connects local Worker protocol and stops cooperatively', async () => {
  const base = realpathSync.native(tmpdir()), root = await mkdtemp(join(base, 'crb-')), previous = process.env.CODERAIL_HOME;
  process.env.CODERAIL_HOME = root;
  const startup = new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`), service = new UserService(startup), frames: any[] = [];
  const token = crypto.randomUUID();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) {
    if (request.headers.get('authorization') !== 'Bearer ' + token) return new Response('Unauthorized', { status: 401 });
    return server.upgrade(request) ? undefined : new Response('WebSocket required', { status: 426 });
  }, websocket: { message(ws, data) { const message = JSON.parse(String(data)); frames.push(message); if (message.t === 'ping') ws.send(JSON.stringify({ t: 'pong' })); } } });
  const exe = join(root, 'bridge.exe'), spec: ServiceSpec = { command: [exe, 'run'], stateDir: root, home: homedir(), logPath: join(root, 'bridge.log') };
  let registered: string | undefined;
  try {
    const build = await runWindows([process.execPath, 'build', '--compile', '--outfile', exe, join(import.meta.dir, '../../../bridge/src/main.ts')], { timeout: 90000 }); expect(build.code).toBe(0);
    writePrivateFile(join(root, 'config.json'), JSON.stringify({ server: `http://127.0.0.1:${server.port}`, token, machineId: 'local-service-gate', name: '本机后台 中文😀' }));
    await service.install(spec); registered = service.command(spec);
    await until(() => frames.some(frame => frame.t === 'hello'), 30000, 'production background hello');
    expect(frames.find(frame => frame.t === 'hello').info.os).toBe('win32');
    await service.uninstall(spec); registered = undefined;
    expect((await service.status(spec)).running).toBe(false); expect(startup.read()).toBeNull();
    expect(await readFile(spec.logPath, 'utf8')).toContain('stopping');
    console.log(JSON.stringify({ productionBridge: true, hiddenUserService: true, localWorkerHello: true, cooperativeShutdown: true }));
  } finally {
    await service.stop(spec); if (registered) startup.uninstall(registered); server.stop(true);
    if (previous === undefined) delete process.env.CODERAIL_HOME; else process.env.CODERAIL_HOME = previous;
    if (!contains(base, realpathSync.native(root)) || !root.includes('crb-')) throw new Error('Unsafe temp cleanup'); await retry(() => rm(root, { recursive: true }));
  }
}, 120000);
