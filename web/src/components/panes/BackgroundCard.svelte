<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Background: what runs on the machine without you looking: every approval waiting (answered here, or opened in its
  // session), what the agents left running in the background (a backgrounded shell, a subagent: stopped here), the
  // sessions working now, and its terminals (open one in a Terminal tab, or end it).
  import type { AgentTask } from '@coderail/protocol';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { edges } from '../../lib/edges';
  import { ago } from '../../lib/format';
  import { tilde, baseName } from '../../lib/machineText';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import HarnessMark from '../HarnessMark.svelte';
  import Approval from '../chat/Approval.svelte';
  let { conn, phone = false, onterminal, onsession }: { conn: MachineConn; phone?: boolean; onterminal: (id: string) => void; onsession: (id: string) => void } = $props();
  const terms = $derived(conn.terminals.filter((t) => t.exited == null));
  const working = $derived(conn.sessions.filter((s) => s.state === 'running'));
  function stop(t: AgentTask) {
    app.confirmIt({ title: `Stop “${t.name}”?`, body: 'The agent’s turn goes on; only this task stops.', yes: 'Stop', danger: true,
      run: async () => { await conn.call('agent.task_stop', { sessionId: t.sessionId, taskId: t.id }).catch((e) => app.toast(plainError(e), 'warning')); } });
  }
  function end(id: string) {
    app.confirmIt({ title: 'End this terminal?', body: 'Whatever runs in it stops.', yes: 'End', danger: true,
      run: async () => { await conn.call('term.close', { id }).catch((e) => app.toast(plainError(e), 'warning')); conn.terminals = conn.terminals.filter((t) => t.id !== id); } });
  }
</script>

<div class="body scroll" class:phone {@attach edges()}>
  {#if !conn.approvals.length && !conn.tasks.length && !terms.length && !working.length}
    <EmptyState icon="activity" compact={!phone} text="Nothing running" tip="Approvals waiting, agents' background tasks, working sessions and terminals show here" />
  {:else}
    {#if conn.approvals.length}
      <div class="label">Waiting for approval</div>
      {#each conn.approvals as a (a.id)}
        {@const s = conn.session(a.sessionId)}
        <div class="ap">
          <button class="open" onclick={() => onsession(a.sessionId)}><HarnessMark harness={a.harness} size={16} bare /><span class="cut">{s?.title || baseName(s?.cwd ?? '') || 'Session'}</span><Icon name="chevr" size={12} /></button>
          <Approval {a} {conn} />
        </div>
      {/each}
    {/if}
    {#if conn.tasks.length}
      <div class="label">Agent tasks</div>
      {#each conn.tasks as t (t.id)}
        {@const s = conn.session(t.sessionId)}
        <div class="trow">
          <button class="row" onclick={() => onsession(t.sessionId)} title={t.summary ?? t.description ?? t.name}>
            <span class="sdot" class:run={t.state === 'running'}></span><HarnessMark harness={t.harness} size={16} bare /><span class="t cut">{t.name}</span><span class="m cut">{s?.title || baseName(s?.cwd ?? '')}{t.state === 'paused' ? ' · paused' : ''}</span>
          </button>
          {#if t.canStop && conn.canAct}<Button icon="close" variant="icon" size="xs" tip="Stop" onclick={() => stop(t)} />{/if}
        </div>
      {/each}
    {/if}
    {#if working.length}
      <div class="label">Working</div>
      {#each working as s (s.sessionId)}
        <button class="row" onclick={() => onsession(s.sessionId)}><span class="sdot run"></span><HarnessMark harness={s.harness} size={16} bare /><span class="t cut">{s.title || baseName(s.cwd)}</span><span class="m">{ago(s.updatedAt, app.now)}</span></button>
      {/each}
    {/if}
    {#if terms.length}
      <div class="label">Terminals</div>
      {#each terms as t (t.id)}
        <div class="trow">
          <button class="row" disabled={!conn.canTerminal} onclick={() => onterminal(t.id)}>
            <Icon name="terminal" size={16} /><span class="t cut">{t.title || baseName(t.cwd)}</span><span class="m cut">{tilde(t.cwd, conn.info?.home)}{t.by ? ` · ${t.by}` : ''}</span>
          </button>
          {#if conn.canTerminal}<Button icon="close" variant="icon" size="xs" tip="End" onclick={() => end(t.id)} />{/if}
        </div>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .body { flex: 1; min-height: 0; padding: var(--sp-3) var(--gutter) var(--gutter); display: flex; flex-direction: column; }
  .body > :global(*) { flex-shrink: 0; }
  .label { padding: var(--section-gap) 0 var(--section-title); font-size: var(--fs-body); color: var(--muted); }
  .label:first-child { padding-top: 0; }
  .row { height: 32px; gap: var(--sp-2); color: var(--ink); margin: 0 calc(-1 * var(--row-x)); width: calc(100% + 2 * var(--row-x)); }
  .row .t { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; }
  .row .m { flex: 1; min-width: 0; text-align: right; color: var(--muted); font-size: var(--fs-small); white-space: nowrap; overflow: hidden; }
  .trow { display: flex; align-items: center; gap: var(--sp-1); }
  .trow .row { flex: 1; min-width: 0; width: auto; margin-right: 0; }
  .ap { padding: var(--sp-1) 0 var(--sp-2); box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair); }
  .open { display: inline-flex; align-items: center; gap: var(--sp-1h); color: var(--muted); font-size: var(--fs-small); max-width: 100%; }
  .open:hover { color: var(--ink); }
  .ap :global(.ap) { padding-top: var(--sp-1); }
  .phone { padding: var(--sp-3) calc(var(--gutter) + var(--safe-r, 0px)) calc(var(--safe-b, 0px) + var(--gutter)) calc(var(--gutter) + var(--safe-l, 0px)); }
</style>
