<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts" module>
  /** A row of a grouped list: a title, a muted line under it, a glyph before it, a value and › after it, or a check. */
  export interface Row {
    id: string;
    label: string;
    desc?: string;
    icon?: string;
    tint?: string;
    value?: string;
    on?: boolean;
    next?: boolean;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  // The phone's bottom sheet, as the Claude app draws it: a grab bar, a round × (or ‹ on a sheet's second page) and
  // the centred title, then grouped lists on the sheet's ground: white cards of rows, a title with a muted line
  // under it, a check on the current one, or a value and › for a row that opens another page. `groups` are the
  // lists; `children` is anything else (the usage bars, the tiles). On ui/Modal (scrim, focus, Esc, slide up).
  import type { Snippet } from 'svelte';
  import Modal from './Modal.svelte';
  import Icon from '../Icon.svelte';
  let { title, onclose, onback, groups = [], onpick, children, full = false }: {
    title: string;
    onclose: () => void;
    /** Shown as ‹ in the ×'s place: back to the sheet's first page. */
    onback?: () => void;
    groups?: Row[][];
    onpick?: (id: string) => void;
    children?: Snippet;
    /** The screen's height (Usage), not the content's. */
    full?: boolean;
  } = $props();
</script>

<Modal {onclose} label={title} scrimCloses autofocus={false} class="psheet{full ? ' full' : ''}">
  <span class="grab" aria-hidden="true"></span>
  <div class="ph">
    {#if onback}<button class="round" onclick={onback} aria-label="Back"><Icon name="chevl" size={22} stroke={1.8} /></button>
    {:else}<button class="round" onclick={onclose} aria-label="Close"><Icon name="close" size={20} stroke={1.8} /></button>{/if}
    <h2>{title}</h2>
    <span class="round ghost" aria-hidden="true"></span>
  </div>
  <div class="pb scroll">
    {@render children?.()}
    {#each groups as g, gi (gi)}
      <div class="pg" role="menu">
        {#each g as r (r.id)}
          <button class="pr" role={r.on !== undefined ? 'menuitemradio' : 'menuitem'} aria-checked={r.on} disabled={r.disabled} onclick={() => onpick?.(r.id)}>
            {#if r.icon}<span class="pi" style:color={r.tint}><Icon name={r.icon} size={22} stroke={1.7} /></span>{/if}
            <span class="pt"><span class="pl">{r.label}</span>{#if r.desc}<span class="pd">{r.desc}</span>{/if}</span>
            {#if r.value}<span class="pv">{r.value}</span>{/if}
            {#if r.on}<span class="ck"><Icon name="check" size={22} stroke={2} /></span>{/if}
            {#if r.next}<span class="nx"><Icon name="chevr" size={18} stroke={1.8} /></span>{/if}
          </button>
        {/each}
      </div>
    {/each}
  </div>
</Modal>

<style>
  :global(.modal.psheet) { left: var(--sp-2); right: var(--sp-2); bottom: var(--sp-2); top: auto; width: auto; margin: 0; max-height: calc(100% - var(--safe-t, 0px) - var(--sp-6));
    display: flex; flex-direction: column; background: var(--content); border-radius: 34px; box-shadow: 0 -4px 40px rgba(0, 0, 0, 0.18); padding-bottom: max(var(--safe-b, 0px), var(--sp-4)); }
  :global(.modal.psheet.full) { top: calc(var(--safe-t, 0px) + var(--sp-4)); left: 0; right: 0; bottom: 0; border-radius: 34px 34px 0 0; }
  .grab { align-self: center; width: 40px; height: 5px; border-radius: 3px; background: var(--hair2); margin-top: var(--sp-2); flex: none; }
  .ph { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4) var(--sp-3); flex: none; }
  .ph h2 { flex: 1; margin: 0; text-align: center; font-size: 17px; font-weight: 600; color: var(--ink); }
  .round { width: 44px; height: 44px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--ink);
    background: var(--panel); box-shadow: inset 0 0 0 var(--hairline) var(--hair2), 0 2px 8px rgba(0, 0, 0, 0.06); }
  .round:active { transform: scale(0.94); }
  .round.ghost { visibility: hidden; }
  .pb { overflow-y: auto; flex: 1 1 auto; min-height: 0; padding: var(--sp-2) var(--sp-5) var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-4); }
  .pg { display: flex; flex-direction: column; background: var(--panel); border-radius: 22px; padding: 0 var(--sp-5); }
  .pr { display: flex; align-items: center; gap: var(--sp-4); min-height: 56px; padding: var(--sp-3) 0; text-align: left; color: var(--ink); position: relative; }
  .pr + .pr::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: var(--hairline); background: var(--hair2); }
  .pr:has(.pi) + .pr::before { left: 38px; }
  .pr:disabled { opacity: 0.45; }
  .pi { display: inline-flex; flex: none; color: var(--ink2); }
  .pt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .pl { font-size: 17px; line-height: 22px; }
  .pd { font-size: 15px; line-height: 20px; color: var(--muted); }
  .pv { color: var(--muted); font-size: 17px; flex: none; }
  .ck { color: var(--link, #3b82f6); display: inline-flex; flex: none; }
  .nx { color: var(--faint); display: inline-flex; flex: none; margin-right: calc(-1 * var(--sp-1)); }
</style>
