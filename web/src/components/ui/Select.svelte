<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A choice that opens a menu, in place of a native <select>: a field
  // with the value and a chevron; open = the accent edge and ring; Space, Return or ↓ open it with the current
  // value active. The menu is ui/Menu (top layer, anchored to this trigger, works inside sheets). `plain` is the
  // Claude app's Settings dropdown: the value in ink and a muted chevron, no frame (a soft fill on hover), its
  // chevron on the row's right edge.
  //
  //   <Select items={sets.map((s) => ({ id: s.id, label: s.name }))} value={set} onpick={(v) => (set = v)} />
  //   <Select items={…} onpick={…} icon="stack">{custom label}</Select>
  import type { Snippet } from 'svelte';
  import Icon from '../Icon.svelte';
  import Menu, { type Item } from './Menu.svelte';
  import { tip as tipAt } from '../../lib/tip';

  let {
    items, value, onpick, children, placeholder = 'Choose…', block = false, width, icon, tip = '',
    plain = false, label,
  }: {
    /** The rows (or a function giving them when it opens). */
    items: Item[] | (() => Item[]);
    /** The current id: its row is checked and its label shown (unless `children` draws the value). */
    value?: string | null;
    onpick: (id: string) => void;
    children?: Snippet;
    placeholder?: string;
    block?: boolean;
    /** The menu's width (at least the trigger's). */
    width?: number;
    icon?: string;
    tip?: string;
    /** No frame, the value in ink: a Settings row's control. */
    plain?: boolean;
    /** Accessible name. */
    label?: string;
  } = $props();

  let el = $state<HTMLButtonElement>();
  let open = $state(false);
  const list = $derived(typeof items === 'function' ? (open ? items() : []) : items);
  const rows = $derived(value === undefined ? list : list.map((it) => (it.sep || it.header ? it : { ...it, on: it.id === value })));
  const current = $derived((typeof items === 'function' ? [] : items).find((it) => it.id === value));
  function key(e: KeyboardEvent) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open = true; }
  }
</script>

<button bind:this={el} type="button" class="select" class:block class:open class:plain aria-haspopup="menu" aria-expanded={open}
  aria-label={label} onclick={() => (open = !open)} onkeydown={key} {@attach tipAt(tip || ((current?.label?.length ?? 0) > 30 ? current?.label : ''))}>
  {#if icon}<span class="ic"><Icon name={icon} size={18} /></span>{/if}
  <span class="v cut" class:ph={!children && !current}>{#if children}{@render children()}{:else}{current?.label ?? placeholder}{/if}</span>
  <span class="chev"><Icon name="chevd" size={plain ? 18 : 16} /></span>
</button>
{#if open && el}
  <!-- (A long list finds by typing: more than 12 choices bring the find field.) -->
  <Menu anchor={el} items={rows} width={width ?? 220} matchWidth={!plain} end={plain} search={rows.filter((it) => !it.sep && !it.header).length > 12} onpick={(id) => onpick(id)} onclose={() => (open = false)} label={label ?? 'Choices'} />
{/if}

<style>
  .select {
    display: inline-flex; align-items: center; gap: var(--sp-2); height: var(--control); padding: 0 var(--row-x); max-width: 100%;
    border-radius: var(--r-md); border: var(--hairline) solid var(--hair2); background: var(--panel); color: var(--ink);
    font-size: var(--fs-body); text-align: left;
    transition: background var(--t-fast) ease-out, border-color var(--t-quick) var(--ease-snap), box-shadow var(--t-quick) var(--ease-snap);
  }
  .select:hover { border-color: var(--faint); }
  .select.open { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .select.plain { border-color: transparent; background: transparent; padding: 0 var(--sp-2) 0 var(--row-x); margin-right: calc(-1 * var(--sp-2)); gap: var(--sp-2); }
  .select.plain:hover, .select.plain.open { background: var(--hover); box-shadow: none; border-color: transparent; }
  .select.plain .v { color: var(--ink); flex: none; }
  .select.block { display: flex; width: 100%; }
  .select:disabled { color: var(--faint); background: var(--tint); border-color: var(--hair); }
  .ic { color: var(--ink2); display: inline-flex; }
  .v { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .v.ph { color: var(--muted); }
  .chev { color: var(--muted); display: inline-flex; transition: transform var(--t-quick) var(--ease-snap); }
  .open .chev { transform: rotate(180deg); }
</style>
