// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assert, assertGone, ps, result, until } from '../common';
import { appServer } from './rpc';
import { ApprovalCommandScope, ProcessJob, ProcessRef } from './process-jobs';

const input = (text: string) => [{ type: 'text', text, text_elements: [] }];
export async function commandCancel() {
  return result('app-server-command-approval-and-running-cancel', async () => {
    const dir = join(artifacts, `owned commands 中文 ${Date.now()}`); mkdirSync(dir);
    const cwd = realpathSync.native(dir);
    const fixture = join(cwd, `${crypto.randomUUID()}.ps1`);
    const expectedCommand = `& '${ps}' -NoProfile -ExecutionPolicy Bypass -File '${fixture}'`;
    const nodeScript = join(cwd, 'nested.cjs');
    await Bun.write(nodeScript, `const {spawn}=require('node:child_process'); const fs=require('node:fs'); fs.appendFileSync(__dirname+'/oracle.jsonl',JSON.stringify({pid:process.pid,ppid:process.ppid})+'\\n','utf8'); const c=process.argv[2]==='leaf'?spawn('ping.exe',['-t','127.0.0.1'],{windowsHide:true,stdio:'ignore'}):spawn(process.execPath,[__filename,'leaf'],{windowsHide:true,stdio:'ignore'}); fs.appendFileSync(__dirname+'/oracle.jsonl',JSON.stringify({pid:c.pid,ppid:process.pid})+'\\n','utf8'); setInterval(()=>{},1000);`);
    await Bun.write(fixture, `\ufeff[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); & '${process.env.POC_NODE_PATH!.replaceAll("'", "''")}' '${nodeScript.replaceAll("'", "''")}'`);
    const { rpc } = await appServer(cwd);
    const guard = new ProcessJob(), runtime = ProcessRef.open(rpc.proc.pid); assert(runtime); guard.assign(runtime);
    let scope: ApprovalCommandScope | undefined;
    let approvalFailure: Error | undefined;
    try {
      let approvalCount = 0;
      rpc.onEvent = e => {
        if (['error', 'turn/completed'].includes(e.method)) console.log(JSON.stringify({ cancellationEvent: e }));
      };
      rpc.onRequest = async message => {
        if (message.method !== 'item/commandExecution/requestApproval') return { decision: 'decline' };
        const p = message.params;
        console.log(JSON.stringify({ commandApprovalObserved: { itemId: p.itemId, command: p.command, cwd: p.cwd } }));
        assert(p.commandActions?.length === 1 && p.commandActions[0].command === expectedCommand, 'Test authorizes only its exact generated local command');
        assert.equal(realpathSync.native(p.cwd), cwd);
        assert(!scope, 'Concurrent approvals require separate runtime / serialized approval lease');
        // Baseline and monitor are armed BEFORE the permission response goes out.
        try { scope = new ApprovalCommandScope(rpc.proc.pid, p.itemId); }
        catch (error) { approvalFailure = error as Error; throw error; }
        approvalCount++;
        return { decision: 'accept' };
      };
      const start = await rpc.call('thread/start', { cwd, sandbox: 'workspace-write', approvalPolicy: 'untrusted', baseInstructions: 'This is a transport integration test. Only run the exact local command requested. No other tools, plugins, file inspection or agents.' });
      const threadId = start.thread.id;
      const turn = await rpc.call('turn/start', { threadId, input: input(`Run exactly one shell command and wait for it: ${expectedCommand}. This local fixture starts nested Node/ping processes. Request approval. Do not inspect files or use other tools.`) });
      await until(() => {
        if (approvalFailure) throw approvalFailure;
        if (scope && scope.processes.some(p => p.name.toLowerCase() === 'ping.exe' && p.alive)) return true;
        const ended = rpc.events.find(e => e.method === 'turn/completed' && e.params.turn.id === turn.turn.id);
        if (ended) throw new Error('Turn ended before command chain was captured: ' + JSON.stringify(ended.params));
        return false;
      }, 120000, 'generic tracker captures nested command chain');
      assert(scope); assert.equal(approvalCount, 1);
      const before = scope.processes;
      const oracle = (await Bun.file(join(cwd, 'oracle.jsonl')).text()).trim().split('\n').map(line => JSON.parse(line));
      assert(oracle.every(p => before.some(captured => captured.pid === p.pid)), 'Independent fixture oracle must be fully covered by generic ownership');
      const cleanup = await scope.interrupt(() => rpc.call('turn/interrupt', { threadId, turnId: turn.turn.id }), 1500);
      const completed = await rpc.event('turn/completed', e => e.threadId === threadId && e.turn.id === turn.turn.id, 20000);
      assert.equal(completed.turn.status, 'interrupted');
      await assertGone(before.map(p => p.pid));
      assert(runtime.alive(), 'A must not restart app-server');
      await rpc.call('account/read', { refreshToken: false });
      const followup = await rpc.call('turn/start', { threadId, input: input('Reply exactly SAME_SERVER_HEALTHY. Do not use tools.') });
      const end = await rpc.event('turn/completed', e => e.threadId === threadId && e.turn.id === followup.turn.id, 120000);
      assert.equal(end.turn.status, 'completed');
      assert(rpc.events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('').includes('SAME_SERVER_HEALTHY'));
      return { strategy: 'A', runtimePid: rpc.proc.pid, sameRuntime: true, approvals: approvalCount, captured: before, cleanup, oracleUsedFor: 'assertions only; never cleanup input', sameThreadFollowup: 'SAME_SERVER_HEALTHY', remaining: 0 };
    } finally {
      await Bun.write(join(cwd, 'transport-diagnostic.json'), JSON.stringify({ requests: rpc.requests.map(r => ({ method: r.method, params: r.params })), events: rpc.events.filter(e => ['error', 'turn/completed', 'item/completed'].includes(e.method)) }, null, 2));
      scope?.dispose();
      // Emergency containment only; successful assertions above run before this.
      guard.close(); await rpc.stop(); runtime.close();
    }
  });
}
