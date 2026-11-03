// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assert, assertGone, killTree, result, run, until } from '../common';
import { spawnNative } from '../02-conpty-terminal/win32';
import { appServer, Rpc } from './rpc';

export async function consoleSignal() {
  return result('codex-isolated-console-ctrl-c-and-recovery', async () => {
    const cwd = join(artifacts, `signal 中文 ${Date.now()}`); mkdirSync(cwd);
    const tokenFile = join(cwd, 'ws-capability.txt');
    writeFileSync(tokenFile, crypto.randomUUID(), { encoding: 'utf8', mode: 0o600 });
    const portProbe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
    const url = `ws://127.0.0.1:${portProbe.port}`; portProbe.stop(true);
    const child = spawnNative([process.env.POC_CODEX_PATH!, 'app-server', '--listen', url, '--ws-auth', 'capability-token', '--ws-token-file', tokenFile], { cwd, job: true, newConsole: true });
    let rpc: Rpc | undefined;
    let threadId: string | undefined;
    try {
      await Bun.sleep(1000);
      rpc = new Rpc([process.execPath, join(import.meta.dir, 'ws-proxy.ts'), url, tokenFile], cwd);
      await rpc.call('initialize', { clientInfo: { name: 'coderail_signal_poc', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } });
      rpc.notify('initialized');
      const start = await rpc.call('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'on-request' }); threadId = start.thread.id;
      const turn = await rpc.call('turn/start', { threadId, input: [{ type: 'text', text: 'Do not use tools. Write 500 numbered lines of streaming text. Start immediately.', text_elements: [] }] });
      await rpc.event('item/agentMessage/delta', () => true, 120000);
      const signal = await run([process.execPath, join(import.meta.dir, '../02-conpty-terminal/ctrl-event.ts'), String(child.pid)], { timeout: 10000 });
      assert.equal(signal.code, 0, signal.stderr);
      await Bun.sleep(1000);
      const survived = child.alive();
      let interrupted = false;
      if (survived) {
        const completed = rpc.events.find(e => e.method === 'turn/completed' && e.params.turn.id === turn.turn.id);
        interrupted = completed?.params.turn.status === 'interrupted';
        if (!interrupted) { await rpc.call('turn/interrupt', { threadId, turnId: turn.turn.id }); await rpc.event('turn/completed', e => e.turn.id === turn.turn.id); }
      }
      await rpc.stop(); rpc = undefined; child.closeJob(); await assertGone([child.pid]);
      const restored = await appServer(cwd); rpc = restored.rpc;
      const resume = await rpc.call('thread/resume', { threadId, cwd, sandbox: 'read-only', approvalPolicy: 'on-request' });
      assert.equal(resume.thread.id, threadId);
      const history = await rpc.call('thread/read', { threadId, includeTurns: true }); assert(history.thread.turns.length > 0);
      return { targetPid: child.pid, signal: 'CTRL_C_EVENT(0,0) after AttachConsole in isolated helper', generated: true, serverSurvived: survived, turnInterruptedBySignal: interrupted, historyRestored: true, turns: history.thread.turns.length, recommendation: survived && interrupted ? 'protocol cancel remains preferred' : 'console event is not a per-turn cancel; use protocol interrupt, then supervised restart if hung' };
    } finally { if (rpc) await rpc.stop(); await killTree(child.pid); child.dispose(); await assertGone([child.pid]); unlinkSync(tokenFile); }
  });
}
