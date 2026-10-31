<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts" module>
  /** A menu row: a glyph, a label, a description line, a key hint or a check; or a separator or a header. */
  export interface Item {
    id: string;
    label?: string;
    desc?: string;
    icon?: string;
    kbd?: string;
    danger?: boolean;
    sep?: boolean;
    header?: boolean;
    /** Checked (a choice's current value). */
    on?: boolean;
    disabled?: boolean;
    tip?: string;
    /** A picture before the label instead of a glyph (a person, an agent, a project; or a harness mark). */
    pic?: { kind: 'harness'; harness?: string };
    /** The current choice inside its submenu, in the muted ink at the row's end ("Folder", "Last updated"). */
    value?: string;
    /** A submenu: it opens beside the row on hover, a click or →, and ← or Esc closes it. */
    sub?: Item[];
  }
</script>

<script lang="ts">
  // A menu (the mockup's .menu/.mi/.mlabel/.sep) on ui/Popover: anchored to its trigger
  // (or a point, for right-clicks), flip/shift at the edges, at most 300 tall (520 on the phone). Keys (open-claude-ui
  // useClaudeRovingFocus): ↑ ↓ Home End move, typed letters jump (600 ms), Return/Space pick, Tab and Esc close;
  // the pointer and the keys share one active row; the checked row is active on open. An optional search field
  // filters rows by label and description; an empty list says so ("No options" / "No match"). A row with `sub` opens
  // its submenu beside it (the Claude app's Group by › / Sort by ›); a pick there is the menu's pick.
  //
  //   <Menu anchor={el} items={[{ id: 'rename', label: 'Rename…', icon: 'edit' }]} onpick={…} onclose={…} />
  //   <Menu x={e.clientX} y={e.clientY} items={…} … />             (a context menu at the pointer)
  import type { Snippet } from 'svelte';
  import type { Placement } from '@floating-ui/dom';
  import Icon from '../Icon.svelte';
  import HarnessMark from '../HarnessMark.svelte';
  import Popover from './Popover.svelte';
  import Self from './Menu.svelte';
  import { roving, items as rows, focusItem } from '../../lib/roving';
  import { tip } from '../../lib/tip';
  import type { Anchor } from '../../lib/floating';

  let {
    items = [], anchor, x = 0, y = 0, up = false, end = false, placement, width = 220, matchWidth = false,
    onpick = () => {}, onclose, custom, search = false, empty = 'No options', label = 'Menu', child = false, autofocus = true,
  }: {
    items?: Item[];
    /** The trigger (preferred) or a point/rect; without it, (x, y). */
    anchor?: Anchor;
    x?: number;
    y?: number;
    /** Open above the anchor (it still flips when there is no room). */
    up?: boolean;
    /** Align its right edge with the anchor's. */
    end?: boolean;
    placement?: Placement;
    width?: number;
    matchWidth?: boolean;
    onpick?: (id: string) => void;
    onclose: () => void;
    /** Free content above the rows (or instead of them). */
    custom?: Snippet;
    /** A filter field on top (true, or its placeholder). */
    search?: boolean | string;
    /** The line when there are no rows. */
    empty?: string;
    label?: string;
    /** (A submenu: no scrim of its own, ← closes it.) */
    child?: boolean;
    /** (A submenu opened by the pointer leaves the focus where it is.) */
    autofocus?: boolean;
  } = $props();

  // ---- submenus: one open at a time, beside its row. A menu with any keeps no focus trap (the focus moves between
  // it and its submenu); it focuses its first row itself and gives the focus back when it closes.
  let sub = $state<{ id: string; el: HTMLElement; focus: boolean } | null>(null);
  const nested = $derived(child || items.some((it) => it.sub));
  function openSub(it: Item, el: HTMLElement, focus = false) {
    if (it.disabled) return;
    if (sub?.id === it.id && !focus) return;
    sub = { id: it.id, el, focus };
  }
  const subItems = $derived(sub ? items.find((it) => it.id === sub!.id)?.sub ?? [] : []);
  $effect(() => {
    if (!nested) return;
    const before = document.activeElement as HTMLElement | null;
    const raf = requestAnimationFrame(() => { if (autofocus) first()?.focus({ preventScroll: true }); });
    return () => {
      cancelAnimationFrame(raf);
      const a = document.activeElement;
      if (!child && (!a || a === document.body || list?.contains(a) || a.closest?.('.popover'))) before?.focus?.({ preventScroll: true });
    };
  });

  let q = $state('');
  let list = $state<HTMLDivElement>();
  let field = $state<HTMLInputElement>();
  const where = $derived<Placement>(placement ?? (`${up ? 'top' : 'bottom'}-${end ? 'end' : 'start'}` as Placement));
  const shown = $derived.by(() => {
    const t = q.trim().toLowerCase();
    if (!t) return items;
    return items.filter((it) => !it.sep && !it.header && `${it.label ?? ''} ${it.desc ?? ''}`.toLowerCase().includes(t));
  });
  const selectable = $derived(shown.filter((it) => !it.sep && !it.header));

  function pick(it: Item) {
    if (it.disabled) return;
    onpick(it.id);
    onclose();
  }
  function first(): HTMLElement | undefined {
    if (search) return field;
    if (!list) return undefined;
    const all = rows(list, '.mi');
    return all.find((el) => el.getAttribute('aria-checked') === 'true') ?? all[0];
  }
  function keys(e: KeyboardEvent) {
    // (A row's number, as the Claude app's mode and model menus take them, picks it.)
    const numbered = /^[1-9]$/.test(e.key) && !(e.target instanceof HTMLInputElement) ? selectable.find((it) => it.kbd === e.key && !it.sub) : undefined;
    if (numbered) { e.preventDefault(); pick(numbered); return; }
    if (e.key === 'Tab') { e.preventDefault(); onclose(); }
    else if (child && e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onclose(); }
  }
  function fieldKeys(e: KeyboardEvent) {
    if (!list) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusItem(rows(list, '.mi')[0], list, '.mi'); }
    else if (e.key === 'Enter') { e.preventDefault(); const one = selectable.find((it) => !it.disabled); if (one) pick(one); }
  }
</script>

<Popover anchor={anchor ?? { x, y }} placement={where} {width} {matchWidth} maxHeight={520} gap={child ? 2 : 6} {onclose} role="menu" {label}
  initialFocus={first} trap={!nested} scrim={!child} onkeydown={keys} class="menu">
  {#if search}
    <div class="find framed"><Icon name="search" size={16} />
      <input bind:this={field} bind:value={q} placeholder={typeof search === 'string' ? search : 'Search'} onkeydown={fieldKeys} aria-label="Filter" /></div>
  {/if}
  {#if custom}{@render custom()}{/if}
  <div class="rows" bind:this={list} {@attach roving({ items: '.mi', typeahead: !search, focusOnHover: true })}>
    {#each shown as it (it.id)}
      {#if it.sep}<div class="sep" role="separator"></div>
      {:else if it.header}<div class="mlabel" role="presentation">{it.label}</div>
      {:else}
        <button type="button" class="mi" class:danger={it.danger} class:tall={!!it.desc} class:open={sub?.id === it.id} tabindex="-1" data-label={it.label}
          role={it.on !== undefined ? 'menuitemradio' : 'menuitem'} aria-checked={it.on !== undefined ? !!it.on : undefined}
          aria-haspopup={it.sub ? 'menu' : undefined} aria-expanded={it.sub ? sub?.id === it.id : undefined}
          aria-disabled={it.disabled || undefined}
          onclick={(e) => (it.sub ? openSub(it, e.currentTarget, true) : pick(it))}
          onpointerenter={(e) => { if (e.pointerType === 'touch') return; if (it.sub) openSub(it, e.currentTarget); else sub = null; }}
          onkeydown={(e) => { if (it.sub && e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); openSub(it, e.currentTarget, true); } }}
          {@attach tip(it.tip ?? ((it.label?.length ?? 0) > 34 ? it.label : undefined), { placement: 'right' })}>
          {#if it.pic?.kind === 'harness'}<span class="ic"><HarnessMark harness={it.pic.harness} size={20} /></span>
          {:else if it.icon}<span class="ic"><Icon name={it.icon} size={20} /></span>{/if}
          <span class="l"><span class="t cut">{it.label}</span>{#if it.desc}<span class="d cut">{it.desc}</span>{/if}</span>
          {#if it.sub}{#if it.value}<span class="val cut">{it.value}</span>{/if}<span class="kbd sub"><Icon name="chevr" size={16} /></span>
          {:else}{#if it.on}<span class="kbd ck"><Icon name="check" size={16} /></span>{/if}{#if it.kbd}<span class="kbd">{it.kbd}</span>{/if}{/if}
        </button>
      {/if}
    {/each}
    {#if !selectable.length && (!custom || q)}<div class="none">{q.trim() ? 'No match' : empty}</div>{/if}
  </div>
</Popover>
{#if sub && subItems.length}
  <Self anchor={sub.el} placement="right-start" items={subItems} width={200} child autofocus={sub.focus} label={items.find((it) => it.id === sub?.id)?.label}
    onpick={(id: string) => { onpick(id); onclose(); }} onclose={() => { const el = sub?.el; sub = null; if (el && document.activeElement?.closest?.('.popover') == null) el.focus({ preventScroll: true }); }} />
{/if}

<style>
  .rows { display: flex; flex-direction: column; }
  .l { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .t, .d { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .d { color: var(--muted); font-size: var(--fs-small); }
  .mi.tall { padding-top: var(--sp-1h); padding-bottom: var(--sp-1h); min-height: var(--sp-10); }
  .mi[aria-disabled='true'] .d { color: var(--faint); }
  .mi.open { background: var(--hover); }
  /* (The label keeps its words; the value gives way.) */
  .mi:has(.val) .l { flex: none; max-width: 70%; }
  .val { flex: 1; min-width: 0; text-align: right; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-left: var(--sp-3); }
  .val + .kbd.sub { margin-left: var(--sp-1); }
  .kbd.ck { color: var(--accent); }
  .none { color: var(--muted); font-size: var(--fs-small); padding: var(--sp-2) var(--row-x); }
  .find { margin-bottom: var(--sp-1h); }
  /* The phone: the Claude app's menu, large rows on a rounder card; descriptions wrap rather than cut off. */
  :global(:root[data-phone] .popover.menu) { border-radius: 28px; padding: var(--sp-2); }
  :global(:root[data-phone] .popover.menu .mi) { min-height: 48px; gap: var(--sp-4); padding-left: var(--sp-4); padding-right: var(--sp-4); border-radius: 18px; font-size: 17px; }
  :global(:root[data-phone] .popover.menu .mi svg) { width: 22px; height: 22px; }
  :global(:root[data-phone]) .d { font-size: 14px; white-space: normal; }
</style>
