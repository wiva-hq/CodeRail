<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts" module>
  /** A choice. An empty label draws the glyph alone (a square item; `tip` names it). */
  export interface Segment { id: string; label: string; icon?: string; count?: number; disabled?: boolean; tip?: string }
</script>

<script lang="ts">
  // A segmented control (the Claude app's Settings): one choice of a few on a soft track (ink at 5 %, radius 10),
  // the chosen one a white chip with a hairline and a small shadow that slides (120 ms snap); the others in ink2.
  // Glyph-only items are square (the Theme control's monitor, sun and moon). `tabs` is the same control without a
  // track (page tabs: Needs you's filters, an agent's pages). ← → move and choose; the group is one Tab stop.
  //
  //   <SegmentedControl options={[{ id: 'system', label: 'System' }, …]} value={theme} onchange={setTheme} />
  //   <SegmentedControl options={[{ id: 'system', label: '', icon: 'monitor', tip: 'System' }, …]} … />
  import Icon from '../Icon.svelte';
  import { roving } from '../../lib/roving';
  import { tip } from '../../lib/tip';

  let { options, value, onchange, variant = 'segmented', full = false, size = 'md', label }: {
    options: Segment[];
    value: string | null | undefined;
    onchange: (id: string) => void;
    variant?: 'segmented' | 'tabs';
    /** Stretch to the container's width (equal items). */
    full?: boolean;
    size?: 'sm' | 'md';
    label?: string;
  } = $props();

  let box = $state<HTMLDivElement>();
  let pill = $state<{ left: number; width: number } | null>(null);
  let ready = $state(false);
  // The pill follows the chosen item's box (measured: items may differ in width).
  $effect(() => {
    void value; void options.length;
    if (!box) return;
    const measure = () => {
      const el = box?.querySelector<HTMLElement>('[aria-checked="true"]');
      pill = el ? { left: el.offsetLeft, width: el.offsetWidth } : null;
    };
    measure();
    // (Again after layout settles, and whenever the group or an item changes size.)
    const raf = requestAnimationFrame(() => { measure(); ready = true; });
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    for (const c of box.querySelectorAll('.seg-item')) ro.observe(c);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  });
</script>

<div bind:this={box} class="seg {variant} {size}" class:full role="radiogroup" aria-label={label}
  {@attach roving({ items: '.seg-item', orientation: 'horizontal' })}>
  {#if pill}<span class="pill" class:ready style:transform="translateX({pill.left}px)" style:width="{pill.width}px"></span>{/if}
  {#each options as o (o.id)}
    <button type="button" class="seg-item" class:glyph={!o.label && !!o.icon} data-seg={o.id} class:sel={o.id === value} role="radio" aria-checked={o.id === value} disabled={o.disabled}
      aria-label={!o.label ? o.tip : undefined}
      tabindex={o.id === value || (!options.some((x) => x.id === value) && o === options[0]) ? 0 : -1}
      onclick={() => onchange(o.id)} onfocus={(e) => { if (e.currentTarget.matches(':focus-visible') && o.id !== value) onchange(o.id); }}
      {@attach tip(o.tip)}>
      {#if o.icon}<Icon name={o.icon} size={!o.label ? 20 : 16} />{/if}
      {#if o.label}<span class="cut">{o.label}</span>{/if}
      {#if o.count}<span class="n">{o.count}</span>{/if}
    </button>
  {/each}
</div>

<style>
  /* --control tall: the track's --sp-0h inset around items of --control less that inset. */
  .seg { position: relative; display: inline-flex; gap: 0; padding: var(--sp-0h); border-radius: var(--r-lg); background: var(--well); max-width: 100%; flex: none; }
  .seg.full { display: flex; width: 100%; }
  .seg.full .seg-item { flex: 1; }
  .seg-item {
    position: relative; z-index: var(--z-raised); display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-1h);
    height: calc(var(--control) - 2 * var(--sp-0h)); padding: 0 var(--sp-3); border-radius: var(--r-md); white-space: nowrap;
    font-size: var(--fs-body); line-height: 20px; font-weight: var(--w-text); color: var(--ink2);
    transition: color var(--t-quick) var(--ease-snap);
  }
  .seg-item.glyph { width: 32px; padding: 0; }
  /* (Too narrow for every label: the labels shorten with an ellipsis rather than run out of the track.) */
  .seg-item { min-width: 0; }
  .seg-item > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .seg-item:hover { color: var(--ink); }
  .seg-item.sel { color: var(--ink); }
  .seg-item:disabled { color: var(--faint); }
  .seg-item .n { color: var(--muted); font-variant-numeric: tabular-nums; }
  .pill {
    position: absolute; top: var(--sp-0h); bottom: var(--sp-0h); left: 0; border-radius: var(--r-md); background: var(--panel); box-shadow: var(--shadow-raised);
    pointer-events: none;
  }
  .pill.ready { transition: transform var(--t-quick) var(--ease-snap), width var(--t-quick) var(--ease-snap); }
  /* Tabs: no track; the chosen one on a soft fill. */
  .seg.tabs { background: none; padding: 0; gap: var(--sp-1); }
  .seg.tabs .pill { top: 0; bottom: 0; background: var(--sel); box-shadow: none; border-radius: var(--r-md); }
  .seg.tabs .seg-item { height: var(--control); border-radius: var(--r-md); flex-shrink: 0; color: var(--ink2); }
  .seg.tabs .seg-item.sel { color: var(--ink); font-weight: var(--w-control); }
  .seg.tabs .seg-item:hover:not(.sel) { background: var(--hover); }
  .seg.sm { border-radius: 9px; }
  .seg.sm .seg-item { height: 24px; padding: 0 var(--row-x); font-size: var(--fs-small); border-radius: 7px; }
  .seg.sm .pill { border-radius: 7px; }
  .seg.sm .seg-item.glyph { width: 24px; padding: 0; }
  :global(:root[data-phone]) .seg-item { height: 34px; font-size: 15px; }
</style>
