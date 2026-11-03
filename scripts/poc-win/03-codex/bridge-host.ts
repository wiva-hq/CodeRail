// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A disposable bridge-owner surrogate, not the project's real bridge.
import { Rpc } from './rpc';
import { containProcess } from '../02-conpty-terminal/win32';
const [cwd, readyFile] = process.argv.slice(2);
const rpc = new Rpc([process.env.POC_CODEX_PATH!, 'app-server', '--stdio'], cwd);
const job = containProcess(rpc.proc.pid);
try {
  await rpc.call('initialize', { clientInfo: { name: 'coderail_crash_poc', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }); rpc.notify('initialized');
  const start = await rpc.call('thread/start', { cwd, approvalPolicy: 'on-request', sandbox: 'read-only' });
  const turn = await rpc.call('turn/start', { threadId: start.thread.id, input: [{ type: 'text', text: 'Reply exactly BRIDGE_CRASH_READY. Do not use any tools.', text_elements: [] }] });
  await rpc.event('turn/completed', e => e.turn.id === turn.turn.id);
  await Bun.write(readyFile, JSON.stringify({ threadId: start.thread.id, ownerPid: process.pid, serverPid: rpc.proc.pid }));
  setInterval(() => {}, 1000);
} catch (error) { job.close(); throw error; }
