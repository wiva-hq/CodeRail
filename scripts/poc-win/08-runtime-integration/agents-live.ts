// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Agents } from '../../../bridge/src/agents';
import { snapshot } from '../../../bridge/src/platform/win32/job';
import { contains, retry } from '../04-filesystem/paths';
import { artifacts, assert, assertGone, baseline, ps, until } from '../common';
import type { Caller } from '../../../protocol/src';

baseline();
const root = await mkdtemp(join(artifacts, 'production-agents-')), cwd = realpathSync.native(root);
const previous = process.env.CODERAIL_HOME; process.env.CODERAIL_HOME = join(root, 'state');
const caller: Caller = { userId: 'poc', username: 'poc', role: 'owner', terminal: true, folders: [root], harnesses: null };
const events: { topic: string; event: any }[] = [];
let approvalFailure: Error | undefined, approved = 0;
const fixture = join(root, `${crypto.randomUUID()}.ps1`), node = Bun.which('node.exe')!, script = join(root, 'nested.cjs'), pidsFile = join(root, 'pids.json');
const command = `& '${ps}' -NoProfile -ExecutionPolicy Bypass -File '${fixture}'`;
const shells = [ps, Bun.which('pwsh.exe')].filter(Boolean);
const displays = [command, ...shells.map(shell => `${JSON.stringify(shell)} -Command ${JSON.stringify(command)}`)];
const agents = new Agents((topic, event) => {
  events.push({ topic, event });
  if (event.kind === 'approval') {
    try {
      const approval = event.data, raw = approval.toolCall?.rawInput;
      assert(displays.includes(raw?.command), 'Only the exact owned fixture command may be approved');
      assert.equal(realpathSync.native(raw.cwd), cwd);
      const option = approval.options.find((o: any) => o.kind === 'allow_once'); assert(option);
      approved++; agents.answer({ approvalId: approval.id, optionId: option.optionId }, caller);
    } catch (error) { approvalFailure = error as Error; agents.answer({ approvalId: event.data.id, optionId: null }, caller); }
  }
});
const ids: string[] = [];
try {
  await writeFile(script, `const{spawn}=require('node:child_process');const child=spawn('ping.exe',['-t','127.0.0.1'],{stdio:'ignore',windowsHide:true});require('node:fs').writeFileSync(${JSON.stringify(pidsFile)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
  await writeFile(fixture, `\ufeff[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'approval.flag'),'approved');& '${node}' '${script}'`);
  const owner = await agents.newSession({ harness: 'codex', cwd }, caller); ids.push(owner.sessionId);
  const spectator = await agents.newSession({ harness: 'codex', cwd }, caller); ids.push(spectator.sessionId);
  const p = { harness: 'codex', sessionId: owner.sessionId, cwd };
  const marker = `NATIVE_BRIDGE_${crypto.randomUUID()}`;
  const turn = async (sessionId: string, text: string) => {
    const start = events.length;
    await agents.prompt({ harness: 'codex', sessionId, cwd, prompt: [{ type: 'text', text }] });
    await until(() => events.slice(start).some(row => row.topic === 'session:' + sessionId && ['turn', 'error'].includes(row.event.kind)), 120000, 'production agent turn');
    const end = events.slice(start).find(row => row.topic === 'session:' + sessionId && ['turn', 'error'].includes(row.event.kind));
    assert.equal(end!.event.kind, 'turn', JSON.stringify(end));
    return events.slice(start).filter(row => row.topic === 'session:' + sessionId && row.event.kind === 'update').map(row => row.event.data.content?.text ?? '').join('');
  };
  await turn(owner.sessionId, `Remember exactly ${marker}. Reply only READY. Do not use tools.`);
  await agents.setMode({ ...p, modeId: 'read-only' });
  const before = new Set(snapshot().map(row => row.pid));
  await agents.prompt({ ...p, prompt: [{ type: 'text', text: `Execute exactly this shell command and wait: ${command}. It writes a fixture file, so request sandbox escalation and user approval first. Do not use other tools or inspect files.` }] });
  await until(() => { if (approvalFailure) throw approvalFailure; return existsSync(pidsFile); }, 120000, 'production approval command started');
  assert.equal(approved, 1);
  const fixturePids: number[] = JSON.parse(await readFile(pidsFile, 'utf8'));
  const table = snapshot(), commandPids = new Set(fixturePids);
  for (const pid of fixturePids) {
    let current = table.find(row => row.pid === pid);
    while (current && !before.has(current.parentPid)) { commandPids.add(current.parentPid); current = table.find(row => row.pid === current!.parentPid); }
  }
  const start = performance.now(), cancellation = agents.cancel(p);
  await until(() => snapshot().every(row => !commandPids.has(row.pid)), 3000, 'production command tree gone within 3 seconds');
  const cleanupMs = performance.now() - start; await cancellation; await assertGone([...commandPids]);
  const answer = await turn(owner.sessionId, 'What exact marker did I ask you to remember? Reply only the marker. Do not use tools.'); assert(answer.includes(marker));
  const other = await turn(spectator.sessionId, 'Reply only SPECTATOR_HEALTHY. Do not use tools.'); assert(other.includes('SPECTATOR_HEALTHY'));
  const evidence = { name: 'production-agents-isolated-cancel-recover', status: 'PASS', approved, cleanupMs, commandCount: commandPids.size, remaining: 0, historyRestored: true, spectatorHealthy: true, fixturePidsUsedFor: 'assertions only' };
  console.log(JSON.stringify(evidence));
  await Bun.write(join(artifacts, 'production-agents-latest.json'), JSON.stringify(evidence, null, 2));
} finally {
  for (const sessionId of ids) await agents.close({ harness: 'codex', sessionId }); agents.shutdown();
  if (previous === undefined) delete process.env.CODERAIL_HOME; else process.env.CODERAIL_HOME = previous;
  if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup'); await retry(() => rm(root, { recursive: true }));
}
