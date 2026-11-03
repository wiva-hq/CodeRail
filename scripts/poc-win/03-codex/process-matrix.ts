// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assert, assertGone, result, until } from '../common';
import { ApprovalCommandScope, ProcessJob, ProcessRef } from './process-jobs';

export async function processMatrix() {
  return result('approval-command-job-matrix', async () => {
    const guard = new ProcessJob();
    const controller = Bun.spawn([process.env.POC_NODE_PATH!, join(import.meta.dir, 'process-controller.cjs')], { windowsHide:true, stdin:'pipe', stdout:'pipe', stderr:'pipe' });
    const controllerRef = ProcessRef.open(controller.pid); assert(controllerRef); guard.assign(controllerRef);
    let scope: ApprovalCommandScope | undefined;
    let sentinel: ProcessRef | null = null;
    try {
      const reader = (controller.stdout as ReadableStream<Uint8Array>).getReader();
      const first = await reader.read(); assert(first.value); const ready = JSON.parse(new TextDecoder().decode(first.value));
      sentinel = ProcessRef.open(ready.sentinel); assert(sentinel);
      const runs: unknown[] = [];
      // Fast-root-exit counterexample is covered by the authoritative session
      // Job test below, not hidden by slowing down this fixture.
      for (const mode of ['chain','churn']) {
        const dir=join(artifacts,`matrix-${mode}-${Date.now()}`);mkdirSync(dir);
        const oracle=join(dir,'oracle.jsonl');
        scope = await ApprovalCommandScope.acquire(controller.pid,crypto.randomUUID());
        assert.throws(()=>new ApprovalCommandScope(controller.pid,'overlapping'), /lease already active/);
        (controller.stdin as import('bun').FileSink).write(JSON.stringify({argv:[process.env.POC_NODE_PATH!,join(import.meta.dir,'process-fixture.cjs'),mode,oracle]})+'\n');
        await until(()=>existsSync(oracle)&&readFileSync(oracle,'utf8').trim().split('\n').length>=4&&scope!.processes.some(p=>p.name.toLowerCase()==='ping.exe'&&p.alive),15000,mode+' fully spawned');
        const before=scope.processes;
        const expected=readFileSync(oracle,'utf8').trim().split('\n').map(line=>JSON.parse(line).pid);
        assert(expected.every(pid=>before.some(p=>p.pid===pid)),'oracle coverage');
        const cleanup=await scope.interrupt(async()=>({interrupted:true}),100);
        await assertGone(before.map(p=>p.pid));assert(controllerRef.alive());assert(sentinel.alive(),'pre-existing sibling must not be captured');
        runs.push({mode,captured:before,cleanup,sentinelAlive:true});
        scope.dispose();scope=undefined;
      }
      return {runs,ownershipInput:'runtime PID + approval lease only',fixtureOracle:'assertions only',remaining:0};
    } finally {scope?.dispose();guard.close();await controller.exited;controllerRef.close();sentinel?.close();}
  });
}

export async function fastRootExitJob() {
  return result('session-job-covers-root-exit-before-discovery', async () => {
    const guard = new ProcessJob();
    const controller = Bun.spawn([process.env.POC_NODE_PATH!, join(import.meta.dir,'process-controller.cjs')], {windowsHide:true,stdin:'pipe',stdout:'pipe',stderr:'pipe'});
    const runtime = ProcessRef.open(controller.pid); assert(runtime); guard.assign(runtime);
    let refs: ProcessRef[] = [];
    try {
      const reader=(controller.stdout as ReadableStream<Uint8Array>).getReader();await reader.read();
      const dir=join(artifacts,`fast-root-${Date.now()}`);mkdirSync(dir);const oracle=join(dir,'oracle.jsonl');
      const baseline = new Set(guard.members());
      (controller.stdin as import('bun').FileSink).write(JSON.stringify({argv:[process.env.POC_NODE_PATH!,join(import.meta.dir,'process-fixture.cjs'),'root-exits',oracle]})+'\n');
      await until(()=>existsSync(oracle)&&readFileSync(oracle,'utf8').trim().split('\n').length>=4,15000,'fast root descendants');
      const expected=readFileSync(oracle,'utf8').trim().split('\n').map(line=>JSON.parse(line).pid);
      const root=ProcessRef.open(expected[0]);
      if(root){await until(()=>!root.alive(),5000,'early root exited');root.close();}
      const members=guard.members();
      assert(expected.slice(1).every(pid=>members.includes(pid)),'Job keeps surviving descendants despite missing root');
      refs=members.map(pid=>ProcessRef.open(pid)).filter((r):r is ProcessRef=>r!==null);
      guard.close();await until(()=>refs.every(r=>!r.alive()),10000,'Job closed entire worker');await assertGone(members);
      return {strategy:'B',rootAlreadyExited:true,baselinePids:[...baseline],jobPids:members,remaining:0,ownershipInput:'session Job membership; no command PID discovery'};
    } finally{guard.close();await controller.exited;for(const ref of refs)ref.close();runtime.close();}
  });
}
