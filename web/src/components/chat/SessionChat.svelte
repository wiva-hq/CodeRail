<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A session's conversation column: the transcript, then the foot (the message column's width): the approval
  // waiting in this session docked over the composer, the composer and its chips. In the composer's place, one line
  // when nothing can be sent: the machine offline (history, read only), a viewer, or a session whose agent stopped
  // (Resume: `agent.open`). Pictures dropped on the conversation go to the composer.
  import { untrack } from 'svelte';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { rise, fade, ms } from '../../lib/motion';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  import Transcript from './Transcript.svelte';
  import Composer from './Composer.svelte';
  import SessionChips from './SessionChips.svelte';
  import Approval from './Approval.svelte';
  import { layout } from '../../lib/layout.svelte';
  let { conn, sessionId }: { conn: MachineConn; sessionId: string } = $props();
  const view = $derived(conn.view(sessionId));
  // (Only the view itself: hold() loads the history, and tracking what that reads would hold it again after each
  // load, a subscribe and a history request in a loop.)
  $effect(() => {
    const v = view;
    return untrack(() => v.hold());
  });
  const row = $derived(conn.session(sessionId) ?? view.row);
  const asks = $derived(conn.pendingFor(sessionId));
  let composer = $state<{ focus: () => void; drop: (f: File[]) => void; pick: (camera?: boolean) => void }>();
  let transcript = $state<{ pin: () => void }>();
  let dropping = $state(false);
  let resuming = $state(false);
  async function resume() {
    if (!row) return;
    resuming = true;
    try { const r = await conn.call('agent.open', { harness: row.harness, sessionId: row.sessionId, cwd: row.cwd }, 120_000); conn.patchSession(row.sessionId, (s) => Object.assign(s, r)); }
    catch (e) { app.toast(plainError(e), 'warning'); }
    resuming = false;
  }
  function over(e: DragEvent) { if (conn.canAct && e.dataTransfer?.types.includes('Files')) { e.preventDefault(); dropping = true; } }
  function drop(e: DragEvent) {
    dropping = false;
    const fs = [...(e.dataTransfer?.files ?? [])];
    if (!fs.length) return;
    e.preventDefault();
    composer?.drop(fs);
  }
</script>

<div class="schat" role="presentation" ondragover={over} ondragleave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropping = false; }} ondrop={drop}>
  <Transcript bind:this={transcript} {view} {conn} running={row?.state === 'running'} />
  <div class="foot">
    {#if asks.length && conn.canAct}
      {@const a = asks[0]}
      {#key a.id}<div in:rise={{ y: 8, duration: ms.base }} out:fade><Approval {a} {conn} docked count={asks.length} session={row?.title ?? undefined} /></div>{/key}
    {/if}
    {#if !conn.online}
      <div class="ended"><b>{conn.connected ? 'The computer is offline' : 'Reconnecting…'}</b><span>The history is here to read. It opens for prompts when the computer is back.</span></div>
    {:else if !conn.canOperate}
      <div class="ended"><b>View only</b><span>Your access to this computer is Viewer. An owner can make you an Operator.</span></div>
    {:else if row?.state === 'closed'}
      <div class="ended"><b>This session’s agent has stopped</b><span>Resume it to go on where it left off.</span><Button size="sm" busy={resuming} onclick={resume}>Resume</Button></div>
    {:else if row && layout.phone}
      {@const r = row}
      <Composer bind:this={composer} {conn} row={r} {view} phone onsent={() => transcript?.pin()}>
        {#snippet bar()}<SessionChips {conn} row={r} {view} phone onattach={(cam) => composer?.pick(cam)} />{/snippet}
      </Composer>
    {:else if row}
      <Composer bind:this={composer} {conn} {row} {view} onsent={() => transcript?.pin()} />
      <SessionChips {conn} {row} {view} />
    {/if}
  </div>
  {#if dropping}<div class="drop" transition:fade><Icon name="attach" size={20} /><span>Drop to attach</span></div>{/if}
</div>

<style>
  .schat { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .foot { width: 100%; max-width: var(--chat-column); margin: 0 auto; padding: 0 var(--sp-5); flex: none; display: flex; flex-direction: column; gap: var(--sp-3); }
  @container chat (min-width: 600px) { .foot { padding: 0 var(--sp-8); } }
  .ended { display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); padding: var(--sp-4) var(--sp-6) var(--sp-6); text-align: center; border-top: var(--hairline) solid var(--hair); }
  .ended b { font-weight: var(--w-head); color: var(--ink); }
  .ended span { color: var(--muted); font-size: var(--fs-quiet); }
  .ended :global(.btn) { margin-top: var(--sp-2); }
  .drop { position: absolute; inset: var(--sp-2) var(--sp-3); border-radius: var(--r-card); border: 1.5px dashed var(--accent); background: var(--accent-tint);
    display: flex; align-items: center; justify-content: center; gap: var(--sp-2); color: var(--accent); font-weight: var(--w-head); pointer-events: none; z-index: var(--z-chrome); }
  :global(:root[data-phone]) .foot { padding: var(--sp-1h) calc(var(--gutter) + var(--safe-r, 0px)) calc(var(--safe-b, 0px) + var(--sp-2)) calc(var(--gutter) + var(--safe-l, 0px)); }
</style>
