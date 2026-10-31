<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // An empty place (CLAUDE-FEEL): the place's glyph, large, in a thin line; one sentence; at
  // most one button. Centred in the space it has (it scrolls rather than asking for more). `compact` for a card
  // or a box inside a sheet.
  //
  //   <EmptyState icon="agents" text="No agents yet" action={{ label: 'New agent', icon: 'plus', run: () => … }} />
  import type { Snippet } from 'svelte';
  import Icon from '../Icon.svelte';
  import Button from './Button.svelte';
  import { tip as tipAt } from '../../lib/tip';
  let { icon, text, tip, action, compact = false, fill = true, children }: {
    icon?: string;
    text: string;
    /** What it means, when that needs saying: the line's tooltip. */
    tip?: string;
    action?: { label: string; icon?: string; run: () => void; primary?: boolean; kbd?: string };
    compact?: boolean;
    /** Take the space it is in and centre in it (default); false sits in the flow. */
    fill?: boolean;
    /** Instead of `action`: the one control, as markup. */
    children?: Snippet;
  } = $props();
</script>

<div class="empty" class:compact class:fill>
  {#if icon}<span class="glyph"><Icon name={icon} size={compact ? 40 : 56} stroke={compact ? 1.25 : 1.1} /></span>{/if}
  <p class="line" {@attach tipAt(tip)}>{text}</p>
  {#if action}
    <Button variant={action.primary === false ? 'default' : 'primary'} icon={action.icon} kbd={action.kbd} onclick={action.run}>{action.label}</Button>
  {:else if children}{@render children()}{/if}
</div>

<style>
  /* Glyph to line --sp-3, line to its button --sp-4, at every size. */
  .empty { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: var(--sp-12) var(--gutter); text-align: center; }
  .empty.fill { flex: 1; align-self: stretch; }
  .empty.compact { padding: var(--sp-6) var(--sp-3); }
  .glyph { color: var(--faint); display: inline-flex; margin-bottom: var(--sp-3); }
  .line + :global(*) { margin-top: var(--sp-4); }
  .line { margin: 0; max-width: 420px; min-width: 180px; font-size: var(--fs-title); line-height: 20px; color: var(--muted); }
  .compact .line { font-size: var(--fs-body); }
  /* In a short card (PaneCard's size container): the line and its button, no glyph. */
  @container card (max-height: 220px) {
    .empty.compact { padding: var(--sp-3); }
    .empty.compact .glyph { display: none; }
  }
</style>
