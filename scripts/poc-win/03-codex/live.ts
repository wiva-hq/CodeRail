// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assert, assertGone, killTree, ps, result, run, until } from '../common';
import { appServer, Rpc } from './rpc';

const textInput = (text: string) => [{ type: 'text', text, text_elements: [] }];
const isolatedInstructions = 'This is an isolated transport protocol integration test. Do not access other workspaces or spawn agents. Follow the literal test prompt, use only the specified local fixture when a command is requested. Do not use plugins or external apps.';

export async function appLive() {
  return result('app-server-stream-cancel-recover', async () => {
    const cwd = join(artifacts, `app live 中文 ${Date.now()}`); mkdirSync(cwd);
    let { rpc } = await appServer(cwd);
    try {
      const start = await rpc.call('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'on-request', ephemeral: false, baseInstructions: isolatedInstructions });
      const threadId = start.thread.id;
      const turn = await rpc.call('turn/start', { threadId, input: textInput('Without using tools, write 500 numbered lines. Each line must say 持续中文 protocol streaming test plus its number. Start immediately.') });
      const turnId = turn.turn.id;
      await rpc.event('item/agentMessage/delta', e => e.threadId === threadId, 120000);
      const cancelAt = performance.now();
      await rpc.call('turn/interrupt', { threadId, turnId });
      const completed = await rpc.event('turn/completed', e => e.threadId === threadId && e.turn.id === turnId, 15000);
      assert.equal(completed.turn.status, 'interrupted');
      const cancelMs = performance.now() - cancelAt;
      const deltaCount = rpc.events.filter(e => e.method === 'item/agentMessage/delta').length;
      await rpc.call('account/read', { refreshToken: false });
      // Lose the entire app-server transport process, then load the durable thread.
      await rpc.stop();
      ({ rpc } = await appServer(cwd));
      const restored = await rpc.call('thread/resume', { threadId, cwd, approvalPolicy: 'on-request', sandbox: 'read-only' });
      assert.equal(restored.thread.id, threadId);
      const history = await rpc.call('thread/read', { threadId, includeTurns: true });
      assert(history.thread.turns.length >= 1, 'history missing after restart');
      const followup = await rpc.call('turn/start', { threadId, input: textInput('Reply exactly POC_RECOVERED. Do not use tools.') });
      const followupEnd = await rpc.event('turn/completed', e => e.threadId === threadId && e.turn.id === followup.turn.id, 120000);
      assert.equal(followupEnd.turn.status, 'completed');
      const finalText = rpc.events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
      assert(finalText.includes('POC_RECOVERED'));
      return { threadId, model: start.model, streamDeltas: deltaCount, cancelMs, interrupted: true, serverResponsiveAfterCancel: true, restoredTurns: history.thread.turns.length, resumedReply: finalText };
    } finally { await rpc.stop(); }
  });
}

export async function acpLive() {
  return result('acp-stream-cancel-session-load', async () => {
    const cwd = join(artifacts, `acp live 中文 ${Date.now()}`); mkdirSync(cwd);
    const require = createRequire(join(import.meta.dir, '../../../bridge/package.json'));
    const entry = require.resolve('@agentclientprotocol/codex-acp');
    const connect = async () => {
      const rpc = new Rpc([process.execPath, entry], cwd, { ...process.env, BUN_BE_BUN: '1', CODEX_PATH: process.env.POC_CODEX_PATH!, NO_BROWSER: '1' });
      try { await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'coderail_poc', version: '0.1.0' } }); return rpc; }
      catch (error) { await rpc.stop(); throw error; }
    };
    let rpc = await connect();
    try {
      const session = await rpc.call('session/new', { cwd, mcpServers: [] }, 60000);
      const sessionId = session.sessionId;
      const prompt = rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Do not use tools. Write 500 numbered lines of 持续中文 streaming protocol test. Begin immediately.' }] }, 120000);
      // Attach a handler immediately so a timeout cannot become an unhandled rejection.
      const outcome = prompt.then(value => ({ value }), error => ({ error: String(error) }));
      await rpc.event('session/update', e => e.sessionId === sessionId && e.update?.sessionUpdate === 'agent_message_chunk', 120000);
      const at = performance.now(); rpc.notify('session/cancel', { sessionId });
      const end = await outcome;
      assert('value' in end, JSON.stringify(end)); assert.equal(end.value.stopReason, 'cancelled');
      const cancelMs = performance.now() - at;
      await rpc.stop(); rpc = await connect();
      const restored = await rpc.call('session/load', { sessionId, cwd, mcpServers: [] }, 60000);
      const followup = await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply exactly ACP_RECOVERED. Do not use tools.' }] }, 120000);
      assert.equal(followup.stopReason, 'end_turn');
      const text = rpc.events.filter(e => e.method === 'session/update' && e.params.update?.sessionUpdate === 'agent_message_chunk').map(e => e.params.update.content?.text ?? '').join('');
      assert(text.includes('ACP_RECOVERED'));
      return { sessionId, cancelMs, stopReason: end.value.stopReason, loadedAfterRestart: !!restored, followupText: text };
    } finally { await rpc.stop(); }
  });
}

export async function bridgeCrash() {
  return result('bridge-owner-crash-codex-history-recovery', async () => {
    const cwd = join(artifacts, `bridge crash 中文 ${Date.now()}`); mkdirSync(cwd);
    const readyFile = join(cwd, 'ready.json');
    const owner = Bun.spawn([process.execPath, join(import.meta.dir, 'bridge-host.ts'), cwd, readyFile], { env: process.env, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    let state: any;
    try {
      await until(() => existsSync(readyFile), 120000, 'bridge surrogate durable turn');
      state = await Bun.file(readyFile).json();
      const crash = await run([join(process.env.SystemRoot!, 'System32', 'taskkill.exe'), '/F', '/PID', String(owner.pid)]);
      assert.equal(crash.code, 0, crash.stderr); await owner.exited;
      await assertGone([state.ownerPid, state.serverPid]);
      const { rpc } = await appServer(cwd);
      try {
        const restored = await rpc.call('thread/resume', { threadId: state.threadId, cwd, sandbox: 'read-only', approvalPolicy: 'on-request' });
        assert.equal(restored.thread.id, state.threadId);
        const history = await rpc.call('thread/read', { threadId: state.threadId, includeTurns: true });
        assert(JSON.stringify(history.thread.turns).includes('BRIDGE_CRASH_READY'));
        return { ...state, ownerAndServerGone: true, historyRestored: true, turns: history.thread.turns.length, fixture: 'disposable bridge-owner surrogate; kill owner only, Job closes on crash' };
      } finally { await rpc.stop(); }
    } finally { await killTree(owner.pid); if (state?.serverPid) { await killTree(state.serverPid); await assertGone([state.serverPid]); } }
  });
}
