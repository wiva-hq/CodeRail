<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // An approval (Forest's AskCard): what the agent wants to do (the tool call's title, the command or path, its edit
  // as a diff), then the harness's options as buttons, Allow once the primary (Return takes it when docked). Answered:
  // how it went and who answered. Viewers and an offline machine see it without the buttons.
  import type { Approval } from '@coderail/protocol';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { approvalText, sortedOptions } from '../../lib/approval';
  import { textDiff, extOf } from '../../lib/diffs';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  import HarnessMark from '../HarnessMark.svelte';
  import DiffView from '../DiffView.svelte';
  import { layout } from '../../lib/layout.svelte';
  let { a, conn, answer = null, docked = false, count = 1, session }: {
    a: Approval; conn: MachineConn; answer?: { optionId: string | null; by: string | null } | null; docked?: boolean; count?: number; session?: string;
  } = $props();
  const w = $derived(approvalText(a));
  const pending = $derived(!answer && conn.approvals.some((x) => x.id === a.id));
  const opts = $derived(sortedOptions(a));
  const chosen = $derived(answer ? a.options.find((o) => o.optionId === answer.optionId) : null);
  const diff = $derived.by(() => { const d = (a.toolCall?.content ?? []).find((c: any) => c?.type === 'diff'); return d ? textDiff(d.oldText, d.newText ?? '', d.path) : null; });
  let busy = $state<string | null>(null);
  async function pick(optionId: string | null) {
    busy = optionId ?? 'cancel';
    try {
      await conn.call('agent.answer', { approvalId: a.id, optionId });
      conn.approvals = conn.approvals.filter((x) => x.id !== a.id);
    } catch (e) { app.toast(plainError(e), 'warning'); }
    busy = null;
  }
  let once = $state<HTMLButtonElement>();
  $effect(() => {
    if (!docked || !once) return;
    const f = document.activeElement as HTMLElement | null;
    if (!f || f === document.body || !f.closest('input, textarea, [contenteditable], .xterm')) once.focus({ preventScroll: true });
  });
</script>

<div class="ap" class:docked class:waiting={pending}>
  {#if docked}
    <div class="who"><HarnessMark harness={a.harness} size={20} /><span class="nm cut">{session ?? 'Approval'}</span>{#if count > 1}<span class="of">1 of {count}</span>{/if}</div>
  {/if}
  <div class="q"><Icon name={w.icon} size={16} /><span>{w.title}</span></div>
  {#if w.target && w.target !== w.title}<div class="target code selectable">{w.target}</div>{/if}
  {#if diff && docked}<div class="diff"><DiffView lines={diff.lines} lang={extOf(diff.path)} /></div>{/if}
  {#if pending}
    {#if conn.canAct}
      <div class="acts">
        {#each opts as o (o.optionId)}
          {#if o.kind === 'allow_once'}
            <Button variant="primary" bind:el={once} busy={busy === o.optionId} disabled={!!busy && busy !== o.optionId} kbd={docked && !layout.phone ? '⏎' : undefined} onclick={() => pick(o.optionId)}>{o.name}</Button>
          {:else}
            <Button variant={o.kind.startsWith('reject') ? 'quiet' : 'default'} busy={busy === o.optionId} disabled={!!busy && busy !== o.optionId} onclick={() => pick(o.optionId)}>{o.name}</Button>
          {/if}
        {/each}
      </div>
    {:else}
      <div class="line"><span class="warn"><Icon name="hand" size={15} /></span>{!conn.online ? 'Waiting · the computer is offline' : 'Waiting for an operator'}</div>
    {/if}
  {:else if answer || chosen}
    <div class="line"><span class={chosen?.kind.startsWith('allow') ? 'ok' : 'faint'}><Icon name={chosen?.kind.startsWith('allow') ? 'success' : 'error'} size={15} /></span>
      {chosen ? chosen.name : answer?.optionId === null ? 'Cancelled' : 'Answered'}{answer?.by ? ` · ${answer.by}` : ''}</div>
  {:else}
    <div class="line"><span class="faint"><Icon name="clock" size={15} /></span>No longer waiting</div>
  {/if}
</div>

<style>
  .ap { padding: var(--sp-3) 0; }
  .ap.docked { padding: var(--gutter); border-radius: var(--r-composer); background: var(--panel); border: var(--hairline) solid var(--hair2); box-shadow: var(--shadow-composer); animation: rise var(--t-sheet) var(--ease-base) both; }
  .ap.docked.waiting { border-color: color-mix(in srgb, var(--warn) 50%, transparent); box-shadow: var(--shadow-composer), 0 0 0 2px var(--warn-soft); }
  .ap:not(.docked).waiting { padding: var(--sp-3) var(--sp-4); border-radius: var(--r-card); box-shadow: inset 0 0 0 var(--hairline) color-mix(in srgb, var(--warn) 50%, transparent); background: var(--panel); margin: var(--sp-2) 0; }
  .who { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .nm { flex: 1; min-width: 0; font-weight: 500; white-space: nowrap; overflow: hidden; }
  .of { color: var(--muted); font-size: var(--fs-small); }
  .q { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-message); font-weight: var(--w-control); line-height: 1.45; }
  .q :global(svg) { color: var(--ink2); flex: none; }
  .target { margin-top: var(--sp-2); white-space: pre-wrap; word-break: break-all; max-height: min(30vh, 220px); overflow-y: auto; }
  .diff { margin-top: var(--sp-2); max-height: 220px; overflow: auto; border-radius: var(--r-md); background: var(--tint); }
  .acts { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
  .line { display: flex; align-items: center; gap: var(--sp-2); min-height: 24px; margin-top: var(--sp-2); color: var(--ink2); font-size: var(--fs-body); }
  .warn { color: var(--warn); display: inline-flex; }
  .ok { color: var(--ok); display: inline-flex; }
  .faint { color: var(--muted); display: inline-flex; }
  :global(:root[data-phone]) .acts { flex-direction: column-reverse; align-items: stretch; }
  :global(:root[data-phone]) .acts :global(.btn) { height: 44px; font-size: 16px; justify-content: center; }
</style>
