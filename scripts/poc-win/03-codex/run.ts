// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { artifacts, assert, baseline, result, run } from '../common';
import { Rpc, appServer } from './rpc';
import { appLive, acpLive, bridgeCrash } from './live';
import { commandCancel } from './cancellation';
import { isolatedRecovery } from './recovery';
import { processMatrix, fastRootExitJob } from './process-matrix';
import { acpCommandRecovery } from './acp-recovery';
baseline();
const cwd = join(artifacts, `codex workspace 中文 ${Date.now()}`); mkdirSync(cwd, { recursive: true });
let ok = true;
ok = await result('codex-protocol-schema-drift-check', async () => {
  const output = join(artifacts, 'protocol-current');
  const generated = await run([process.env.POC_CODEX_PATH!, 'app-server', 'generate-ts', '--out', output], { timeout: 60000 });
  assert.equal(generated.code, 0, generated.stderr);
  const source = await Bun.file(join(output, 'ClientRequest.ts')).text();
  const required = ['initialize', 'account/read', 'thread/start', 'thread/resume', 'thread/read', 'turn/start', 'turn/interrupt'];
  const validate = (text: string) => { for (const method of required) assert(text.includes(`\"${method}\"`), `Missing required protocol method ${method}`); };
  validate(source);
  assert.throws(() => validate(source.replaceAll('"turn/interrupt"', '"removed/interrupt"')), 'simulated incompatible upgrade must fail');
  const hash = new Bun.CryptoHasher('sha256').update(source).digest('hex');
  return { required, schemaSha256: hash, simulatedMissingInterruptRejected: true, limitation: 'method surface check; changed field semantics still require live regression' };
}) && ok;
ok = await result('codex-app-server-auth-schema-environment', async () => {
  const { rpc, init } = await appServer(cwd);
  try {
    const auth = await rpc.call('account/read', { refreshToken: false });
    assert(auth.account, 'No global authentication');
    const models = await rpc.call('model/list', {});
    const model = models.data.find((m: any) => m.isDefault) ?? models.data[0];
    assert(model, 'No available model');
    await Bun.write(join(artifacts, 'codex-selected-model.json'), JSON.stringify({ model: model.model, effort: model.defaultReasoningEffort }));
    const thread = await rpc.call('thread/start', { cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write', ephemeral: false });
    await Bun.write(join(artifacts, 'codex-app-thread.json'), JSON.stringify({ threadId: thread.thread.id, cwd }));
    return { server: init, authType: auth.account.type, model: model.model, supportedReasoningEfforts: model.supportedReasoningEfforts.map((e: any) => e.reasoningEffort), threadId: thread.thread.id, approvalPolicy: thread.approvalPolicy, sandboxPolicy: thread.sandbox, environment: 'current user global config/auth; inherited environment; alternate Chinese/spaced cwd' };
  } finally { await rpc.stop(); }
}) && ok;

ok = await result('codex-acp-initialize-auth-session', async () => {
  const require = createRequire(join(import.meta.dir, '../../../bridge/package.json'));
  const entry = require.resolve('@agentclientprotocol/codex-acp');
  const rpc = new Rpc([process.execPath, entry], cwd, { ...process.env, CODEX_PATH: process.env.POC_CODEX_PATH ?? Bun.which('codex')!, BUN_BE_BUN: '1', NO_BROWSER: '1' });
  try {
    const init = await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'coderail_windows_poc', version: '0.1.0' } });
    const session = await rpc.call('session/new', { cwd, mcpServers: [] }, 60000);
    await Bun.write(join(artifacts, 'codex-acp-session.json'), JSON.stringify({ sessionId: session.sessionId, cwd }));
    return { package: 'codex-acp 2.2.2', protocolVersion: init.protocolVersion, authMethodIds: init.authMethods?.map((m: any) => m.id), sessionId: session.sessionId, currentMode: session.modes?.currentModeId, capabilities: init.agentCapabilities };
  } finally { await rpc.stop(); }
}) && ok;

ok = await result('acp-bundled-cross-directory-start', async () => {
  const require = createRequire(join(import.meta.dir, '../../../bridge/package.json'));
  const entry = require.resolve('@agentclientprotocol/codex-acp');
  const build = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', minify: false, external: ['@openai/codex-*', '@openai/codex'] });
  assert(build.success, build.logs.map(String).join('\n'));
  const bundled = join(artifacts, 'codex-acp-bundled.js'); await Bun.write(bundled, build.outputs[0]);
  const rpc = new Rpc([process.execPath, bundled], cwd, { ...process.env, CODEX_PATH: process.env.POC_CODEX_PATH!, BUN_BE_BUN: '1', NO_BROWSER: '1' });
  try {
    const init = await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'coderail_bundle_poc', version: '0.1.0' } });
    const session = await rpc.call('session/new', { cwd, mcpServers: [] }, 60000);
    return { bundledBytes: build.outputs[0].size, protocolVersion: init.protocolVersion, sessionId: session.sessionId, externalCodexPath: true, cwd };
  } finally { await rpc.stop(); }
}) && ok;
ok = await appLive() && ok;
ok = await commandCancel() && ok;
ok = await processMatrix() && ok;
ok = await fastRootExitJob() && ok;
ok = await isolatedRecovery() && ok;
ok = await acpCommandRecovery() && ok;
ok = await acpLive() && ok;
ok = await bridgeCrash() && ok;
process.exitCode = ok ? 0 : 1;
