<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A radio row with a title and a description (the mockup's .opt / .radio): the chosen row takes the accent edge
  // and a soft accent fill, its dot pops in (200 ms, pop curve). Put rows in an OptionGroup (↑ ↓ move and choose,
  // one Tab stop). A trailing snippet holds what sits at the row's end (a label, a "Sign in" button).
  //
  //   <OptionGroup label="Who can see it">
  //     <OptionRow selected={vis === 'public'} icon="public" title="Public" description="…" onselect={() => (vis = 'public')} />
  //   </OptionGroup>
  import type { Snippet } from 'svelte';
  import Icon from '../Icon.svelte';
  import { tip as tipAt } from '../../lib/tip';
  let { selected = false, title, description, icon, lead, trailing, disabled = false, onselect, tip, compact = false }: {
    selected?: boolean;
    title: string;
    description?: string;
    icon?: string;
    /** Drawn before the title instead of an icon (a picture, a harness mark). */
    lead?: Snippet;
    trailing?: Snippet;
    disabled?: boolean;
    onselect: () => void;
    tip?: string;
    /** One line, no frame until chosen (long lists). */
    compact?: boolean;
  } = $props();
  function key(e: KeyboardEvent) {
    if ((e.key === ' ' || e.key === 'Enter') && e.target === e.currentTarget) { e.preventDefault(); if (!disabled) onselect(); }
  }
</script>

<div class="opt" class:sel={selected} class:compact class:disabled role="radio" aria-checked={selected} aria-disabled={disabled || undefined}
  tabindex={selected ? 0 : -1} onclick={() => !disabled && onselect()} onkeydown={key} {@attach tipAt(tip)}>
  <span class="radio"></span>
  {#if lead}<span class="lead">{@render lead()}</span>{:else if icon}<span class="ic"><Icon name={icon} size={20} /></span>{/if}
  <span class="m">
    <span class="t">{title}</span>
    {#if description}<span class="d">{description}</span>{/if}
  </span>
  {#if trailing}<span class="end">{@render trailing()}</span>{/if}
</div>

<style>
  .opt {
    display: flex; gap: var(--sp-3); align-items: flex-start; width: 100%; padding: var(--sp-3); text-align: left;
    border: var(--hairline) solid var(--hair); border-radius: var(--r-lg); background: transparent;
    transition: background var(--t-fast) ease-out, border-color var(--t-quick) var(--ease-snap);
  }
  .opt:hover { background: var(--hover); }
  .opt.sel { border-color: var(--accent); background: var(--accent-tint); }
  .opt.disabled { opacity: 0.55; }
  .opt.compact { align-items: center; padding: var(--sp-2) var(--sp-3); }
  .radio {
    width: 16px; height: 16px; border-radius: 999px; border: 1.5px solid var(--hair2); flex: none; margin-top: var(--sp-0h);
    display: inline-flex; align-items: center; justify-content: center; transition: border-color var(--t-quick) var(--ease-snap);
  }
  .compact .radio { margin-top: 0; }
  .sel .radio { border-color: var(--accent); }
  .sel .radio::after { content: ''; width: 8px; height: 8px; border-radius: 999px; background: var(--accent); animation: dot var(--t-base) var(--ease-pop) both; }
  @keyframes dot { from { opacity: 0; transform: scale(0.4); } }
  .ic { color: var(--ink2); display: inline-flex; }
  .lead { display: inline-flex; flex: none; }
  .m { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-0h); }
  .t { font-size: var(--fs-title); line-height: 20px; font-weight: var(--w-head); display: inline-flex; gap: var(--sp-2); align-items: center; }
  .d { font-size: var(--fs-body); line-height: 20px; color: var(--ink2); }
  .end { flex: none; display: inline-flex; align-items: center; gap: var(--sp-2); align-self: center; }
</style>
