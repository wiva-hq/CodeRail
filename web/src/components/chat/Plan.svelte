<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The agent's plan (ACP `plan`): its entries with a check when done, a ring while in progress.
  import type { Item } from '../../lib/transcript';
  import Icon from '../Icon.svelte';
  let { p }: { p: Extract<Item, { k: 'plan' }> } = $props();
  const done = $derived(p.entries.filter((e) => e.status === 'completed').length);
</script>

<div class="plan">
  <div class="ph"><Icon name="details" size={15} /><span>Plan</span><span class="n">{done} of {p.entries.length}</span></div>
  {#each p.entries as e, i (i)}
    <div class="pe" class:done={e.status === 'completed'} class:now={e.status === 'in_progress'}>
      <span class="box">{#if e.status === 'completed'}<Icon name="check" size={12} stroke={2.2} />{:else if e.status === 'in_progress'}<i></i>{/if}</span>
      <span class="tx">{e.content}</span>
    </div>
  {/each}
</div>

<style>
  .plan { padding: var(--sp-3) var(--sp-4); border-radius: var(--r-xl); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); background: var(--panel); margin: var(--sp-2) 0; }
  .ph { display: flex; align-items: center; gap: var(--sp-2); font-weight: var(--w-head); margin-bottom: var(--sp-2); color: var(--ink); }
  .ph :global(svg) { color: var(--ink2); }
  .n { margin-left: auto; color: var(--muted); font-weight: var(--w-text); font-size: var(--fs-small); }
  .pe { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-1) 0; color: var(--ink2); font-size: var(--fs-quiet); line-height: 20px; }
  .pe.done .tx { color: var(--muted); text-decoration: line-through; text-decoration-color: var(--hair2); }
  .pe.now { color: var(--ink); font-weight: var(--w-control); }
  .box { width: 16px; height: 16px; margin-top: 2px; border-radius: 5px; box-shadow: inset 0 0 0 1.25px var(--hair2); display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .done .box { background: var(--accent); color: var(--onprimary); box-shadow: none; }
  :global(:root[data-scheme='dark']) .done .box { color: #09090b; }
  .now .box { box-shadow: inset 0 0 0 1.25px var(--ink2); }
  .now .box i { width: 6px; height: 6px; border-radius: 50%; background: var(--ink2); }
</style>
