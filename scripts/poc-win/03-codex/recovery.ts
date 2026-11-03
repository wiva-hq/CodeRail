// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assert, assertGone, ps, result, until } from '../common';
import { SessionWorker } from './session-worker';

const text = (value: string) => [{ type: 'text', text: value, text_elements: [] }];
export async function isolatedRecovery() {
  return result('isolated-session-job-cancel-recover-no-collateral', async () => {
    const dir = join(artifacts, `session worker 中文 ${Date.now()}`); mkdirSync(dir);
    const cwd = realpathSync.native(dir), fixture = join(cwd, `${crypto.randomUUID()}.ps1`);
    await Bun.write(fixture, '\ufeff[IO.File]::WriteAllText((Join-Path $PSScriptRoot "started.flag"),"running"); Write-Output "ISOLATED_RUNNING"; Start-Sleep -Seconds 90');
    const owner = new SessionWorker(cwd, 'app-server'), spectator = new SessionWorker(cwd, 'app-server');
    await owner.start(); await spectator.start();
    try {
      const spectatorPid = spectator.rpc.proc.pid;
      const created = await owner.rpc.call('thread/start', { cwd, approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
      const threadId = created.thread.id;
      const marker = `MEMORY_${crypto.randomUUID()}`;
      const remember = await owner.rpc.call('turn/start', { threadId, input: text(`Remember this exact marker: ${marker}. Reply only READY. Do not use tools.`) });
      await owner.rpc.event('turn/completed', e => e.turn.id === remember.turn.id);
      const command = `& '${ps}' -NoProfile -ExecutionPolicy Bypass -File '${fixture}'`;
      owner.rpc.onRequest = async message => {
        assert.equal(message.method, 'item/commandExecution/requestApproval');
        assert(message.params.commandActions?.some((a: any) => a.command === command));
        owner.armApproval(); return { decision: 'accept' };
      };
      const turn = await owner.rpc.call('turn/start', { threadId, input: text(`Run exactly this shell command and wait for it, requesting approval: ${command}. Do not inspect files or use any other tools.`) });
      await until(() => { try { return existsSync(join(cwd, 'started.flag')) && owner.commandPids.length >= 2; } catch { return false; } }, 120000, 'isolated command actually started');
      const recovery = await owner.cancelAndRecover({ threadId, turnId: turn.turn.id }, 500);
      assert(recovery.restarted, 'Must exercise forced session recovery');
      await assertGone(recovery.entireJobPids);
      assert.equal(spectator.rpc.proc.pid, spectatorPid);
      assert((await spectator.rpc.call('account/read', {})).account, 'Unrelated session must remain responsive');
      const history = await owner.rpc.call('thread/read', { threadId, includeTurns: true });
      assert(JSON.stringify(history).includes(marker));
      const followup = await owner.rpc.call('turn/start', { threadId, input: text('What exact marker did I ask you to remember? Reply only with that marker. Do not use tools.') });
      const end = await owner.rpc.event('turn/completed', e => e.turn.id === followup.turn.id); assert.equal(end.turn.status, 'completed');
      const answer = owner.rpc.events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join(''); assert(answer.includes(marker));
      return { strategy: 'B', recovery, spectatorPid, spectatorUnaffected: true, historyAndModelContextRestored: true, remaining: 0 };
    } finally { await owner.stop(); await spectator.stop(); }
  });
}
