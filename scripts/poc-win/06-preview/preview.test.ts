// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { artifacts, assertGone, baseline, until } from '../common';
import { contains } from '../04-filesystem/paths';
import { spawnNative } from '../02-conpty-terminal/win32';
import { snapshot } from '../03-codex/process-jobs';
import { Proxy } from '../../../bridge/src/proxy';
import { listeningPorts } from './net';

baseline();
test('ConPTY Vite server: owned PID/port discovery, production HTTP/WS proxy, HMR and reconnect', async () => {
  const dir = await mkdtemp(join(artifacts, 'preview-win32-'));
  const ready = join(dir, 'ready.json'), config = join(dir, 'config.json'), terminalReady = join(dir, 'terminal.json');
  const require = createRequire(join(import.meta.dir, '../../../web/package.json'));
  await writeFile(join(dir, 'index.html'), '<!doctype html><html><body><main id="app">Windows 预览</main><script type="module" src="/main.js"></script></body></html>', 'utf8');
  const source = (text: string) => `document.querySelector('#app').textContent=${JSON.stringify(text)}; if(import.meta.hot) import.meta.hot.accept();`;
  await writeFile(join(dir, 'main.js'), source('初始 中文😀'), 'utf8');
  await Bun.write(config, JSON.stringify({ node: Bun.which('node.exe'), vite: require.resolve('vite'), root: dir, ready, terminalReady }));
  const worker = spawnNative([process.execPath, join(import.meta.dir, 'terminal-worker.ts'), config], { cwd: dir, job: true });
  const frames: any[] = []; const proxy = new Proxy(frame => frames.push(frame), () => 0);
  let pids: number[] = [worker.pid];
  try {
    await until(() => existsSync(ready) && existsSync(terminalReady), 30000, 'Vite in Windows ConPTY ready');
    const server = await Bun.file(ready).json(), terminal = await Bun.file(terminalReady).json();
    const ports = await listeningPorts([worker.pid]);
    const found = ports.find(p => p.port === server.port && p.pid === server.pid); expect(found).toBeTruthy();
    expect(found!.command.toLowerCase()).toBe('node.exe');
    const http = async (path: string) => {
      const id = crypto.randomUUID();
      proxy.handle({ t: 'http', id, port: server.port, target: `http://127.0.0.1:${server.port}`, path, method: 'GET', headers: [] });
      await until(() => frames.some(f => f.t === 'http_end' && f.id === id), 10000, 'proxy HTTP response');
      expect(frames.find(f => f.t === 'http_head' && f.id === id)?.status).toBe(200);
      expect(frames.find(f => f.t === 'http_end' && f.id === id)?.error).toBeUndefined();
      return frames.filter(f => f.id === id && f.t === 'http_body').map(f => Buffer.from(f.data, 'base64').toString('utf8')).join('');
    };
    expect(await http('/')).toContain('Windows 预览');
    expect(await http('/main.js')).toContain('初始 中文😀');
    const open = async (id: string) => {
      proxy.handle({ t: 'ws_open', id, port: server.port, target: `http://127.0.0.1:${server.port}`, path: `/?token=${server.token}`, protocols: ['vite-hmr'], headers: [['origin', `http://127.0.0.1:${server.port}`]] });
      await until(() => frames.some(f => f.id === id && f.t === 'ws_opened'), 10000, 'Vite HMR websocket opened');
      await until(() => frames.some(f => f.id === id && f.t === 'ws_msg' && JSON.parse(f.data).type === 'connected'), 10000, 'Vite connected handshake');
    };
    const first = crypto.randomUUID(); await open(first);
    // Register the actual module graph as a browser would before mutating it.
    await http('/main.js');
    await writeFile(join(dir, 'main.js'), source('热更新 已生效😀'), 'utf8');
    await until(() => frames.some(f => f.id === first && f.t === 'ws_msg' && JSON.parse(f.data).type === 'update'), 15000, 'Vite HMR update forwarded');
    proxy.handle({ t: 'ws_msg', id: first, data: JSON.stringify({ type: 'ping' }) });
    proxy.handle({ t: 'ws_close', id: first, code: 1000 });
    const second = crypto.randomUUID(); await open(second);
    expect(await http('/main.js')).toContain('热更新 已生效😀');
    const table = snapshot(), owned = new Set([worker.pid]); let changed = true;
    while (changed) { changed = false; for (const p of table) if (owned.has(p.parentPid) && !owned.has(p.pid)) { owned.add(p.pid); changed = true; } }
    pids = [...owned]; expect(pids).toContain(terminal.shellPid); expect(pids).toContain(server.pid);
    console.log(JSON.stringify({ shellPid: terminal.shellPid, vitePid: server.pid, discoveredPort: found, httpUtf8: true, websocketHmr: true, reconnected: true, processCount: pids.length }));
    worker.closeJob(); await assertGone(pids);
  } finally {
    proxy.closeAll(); worker.dispose();
    if (!contains(artifacts, dir) || !dir.includes('preview-win32-')) throw new Error('Unsafe preview cleanup');
    await rm(dir, { recursive: true });
  }
}, 60000);
