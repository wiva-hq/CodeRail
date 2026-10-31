<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A tool card: its 44 pt header (the tabs, "+", split, ⋯, maximize, ×) over the front tab. Every
  // tab stays mounted (a terminal keeps running behind another tab). A short grab bar fades in at the top on hover:
  // dragging the header's empty room moves the card; dragging a tab moves the tab (beside a card, into a card's tabs
  // at a place, or along its own tabs). The front tab keeps its whole title, the others share what is left (44 at
  // least), so "+" and the controls never clip. A card at the window's top left with the sidebar folded keeps its
  // tabs clear of the traffic lights.
  import type { Snippet } from 'svelte';
  import { panes, SINGLE, TITLE, GLYPH, KINDS, type Group, type Tab, type Kind } from '../lib/panes.svelte';
  import { tabTitle } from '../lib/tabs';
  import type { MachineConn } from '../lib/machine.svelte';
  import Icon from './Icon.svelte';
  import HarnessMark from './HarnessMark.svelte';
  import Menu, { type Item } from './ui/Menu.svelte';
  import Button from './ui/Button.svelte';
  import { tip } from '../lib/tip';
  let { conv, g, body, conn }: { conv: string; g: Group; body: Snippet<[Tab, boolean]>; conn: MachineConn } = $props();
  let w = $state(400), h = $state(400);
  let menu = $state<{ kind: 'add' | 'more' | 'split'; anchor: HTMLElement } | null>(null);
  let expanded = $derived(panes.get(conv).expanded === g.id);
  let wide = $derived(w >= h * 1.15);
  let compact = $derived(w < 300);
  let solo = $derived(g.tabs.length === 1);
  let active = $derived(g.tabs.find((t) => t.id === g.active));
  /** Background alone in its card: only maximize and close. */
  let bare = $derived(solo && active?.kind === 'background');
  let corner = $state(false);

  /** Closing a terminal's tab ends its shell on the machine. */
  function ended(tabs: Tab[]) { for (const t of tabs) if (t.kind === 'terminal' && t.term && conn.canTerminal && conn.online) conn.call('term.close', { id: t.term }).catch(() => {}); }

  function addItems(): Item[] {
    const here = new Set(g.tabs.map((t) => t.kind));
    return [
      ...(conn.canTerminal ? [{ id: 'terminal', label: 'Terminal', icon: 'terminal' }] : []),
      { id: 'browser', label: 'Browser', icon: 'globe' },
      { id: 's1', sep: true },
      ...KINDS.filter((k) => SINGLE.has(k) && !here.has(k)).map((k) => ({ id: k, label: TITLE[k], icon: GLYPH[k] })),
    ];
  }
  /** A single tool (Files, Changes, Background) has no second of its own: a split asks what goes in the new card. */
  function splitItems(side: 'right' | 'bottom'): Item[] {
    const here = new Set(g.tabs.map((t) => t.kind));
    return [
      { id: 'h', header: true, label: side === 'right' ? 'Open on the right' : 'Open below' },
      ...(conn.canTerminal ? [{ id: `split:${side}:terminal`, label: 'Terminal', icon: 'terminal' }] : []),
      { id: `split:${side}:browser`, label: 'Browser', icon: 'globe' },
      ...KINDS.filter((k) => SINGLE.has(k) && !here.has(k)).map((k) => ({ id: `split:${side}:${k}`, label: TITLE[k], icon: GLYPH[k] })),
    ];
  }
  function moreItems(): Item[] {
    const ok = panes.canSplit(conv, g.id);
    const term = active?.kind === 'terminal';
    return [
      ...(term && conn.canTerminal ? [{ id: 'terminal', label: 'New terminal', icon: 'terminal' }, { id: 's2', sep: true }] : []),
      { id: 'split:right', label: 'Split right', icon: 'splitcols', ...(ok ? {} : { sub: splitItems('right') }) },
      { id: 'split:bottom', label: 'Split down', icon: 'splitrows', ...(ok ? {} : { sub: splitItems('bottom') }) },
      { id: 's0', sep: true },
      { id: 'max', label: expanded ? 'Restore' : 'Maximize', icon: expanded ? 'minimize' : 'maximize' },
      { id: 'reset', label: 'Reset layout', icon: 'refresh' },
      { id: 'close', label: 'Close pane', icon: 'close' },
    ];
  }
  function pick(id: string) {
    const sp = id.match(/^split:(right|bottom):(\w+)$/);
    if (sp) panes.split(conv, g.id, sp[1] as 'right' | 'bottom', sp[2] as Kind);
    else if (id === 'split:right') panes.split(conv, g.id, 'right');
    else if (id === 'split:bottom') panes.split(conv, g.id, 'bottom');
    else if (id === 'max') panes.toggleExpanded(conv, g.id);
    else if (id === 'reset') panes.reset(conv);
    else if (id === 'close') ended(panes.closePane(conv, g.id));
    else if (KINDS.includes(id as Kind)) panes.addTab(conv, id as Kind, g.id);
  }
  function open(kind: 'add' | 'more' | 'split', e: MouseEvent) {
    menu = menu?.kind === kind ? null : { kind, anchor: e.currentTarget as HTMLElement };
  }
  /** Press, then move 4 px: the card (or the tab) is lifted. */
  function lift(e: PointerEvent, item: { type: 'pane' | 'tab'; id: string }) {
    if (e.button !== 0 || (e.target as HTMLElement).closest('[data-nolift]')) return;
    const x0 = e.clientX, y0 = e.clientY;
    const move = (m: PointerEvent) => {
      if (Math.hypot(m.clientX - x0, m.clientY - y0) < 4) return;
      done();
      menu = null;
      panes.drag = { conv, item: solo && item.type === 'tab' ? { type: 'pane', id: g.id } : item, x: m.clientX, y: m.clientY, drop: null };
    };
    const done = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', done); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', done);
  }
  function close(t: Tab) { ended(panes.closeTab(conv, t.id)); }
  /** Many tabs: the strip scrolls sideways (the wheel too), fades at a cut edge, and keeps the chosen tab in view. */
  function strip(node: HTMLElement) {
    const f = () => {
      node.toggleAttribute('data-cut-l', node.scrollLeft > 2);
      node.toggleAttribute('data-cut-r', node.scrollLeft + node.clientWidth < node.scrollWidth - 2);
    };
    const wheel = (e: WheelEvent) => { if (node.scrollWidth > node.clientWidth && Math.abs(e.deltaY) > Math.abs(e.deltaX)) { node.scrollLeft += e.deltaY; e.preventDefault(); } };
    node.addEventListener('scroll', f, { passive: true });
    node.addEventListener('wheel', wheel, { passive: false });
    const ro = new ResizeObserver(f);
    ro.observe(node);
    const mo = new MutationObserver(() => requestAnimationFrame(() => { (node.querySelector('.tab.on') as HTMLElement | null)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); f(); }));
    mo.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    f();
    return () => { node.removeEventListener('scroll', f); node.removeEventListener('wheel', wheel); ro.disconnect(); mo.disconnect(); };
  }
</script>

{#snippet mark(t: Tab)}
  {#if t.kind === 'terminal' && t.sub && t.sub !== 'shell'}<HarnessMark harness={t.sub} size={16} name={tabTitle(t)} />{/if}
{/snippet}

<section class="card" bind:clientWidth={w} bind:clientHeight={h}>
  <header role="toolbar" tabindex="-1" aria-label="{active ? tabTitle(active) : ''} card" class:corner
    onpointerdown={(e) => lift(e, { type: 'pane', id: g.id })} ondblclick={(e) => { if (!(e.target as HTMLElement).closest('button')) panes.toggleExpanded(conv, g.id); }}>
    <span class="grab" {@attach tip('Move')}></span>
    <div class="tabs" data-tabs role="tablist" {@attach strip}>
      {#each g.tabs as t (t.id)}
        {#if solo}
          <span class="title" data-tab>{@render mark(t)}<span class="cut">{tabTitle(t)}</span></span>
        {:else}
          <!-- svelte-ignore a11y_no_static_element_interactions (the press that lifts the tab; its buttons are inside) -->
          <div class="tab" class:on={t.id === g.active} data-tab onpointerdown={(e) => lift(e, { type: 'tab', id: t.id })}>
            <button class="sel" role="tab" aria-selected={t.id === g.active} {@attach tip(tabTitle(t))} onclick={() => panes.activate(conv, t.id)}
              onauxclick={(e) => { if (e.button === 1) close(t); }}>{@render mark(t)}<span class="cut">{tabTitle(t)}</span></button>
            <button class="x" data-nolift aria-label="Close {tabTitle(t)}" {@attach tip('Close tab')} onclick={() => close(t)}><Icon name="close" size={12} /></button>
          </div>
        {/if}
      {/each}
    </div>
    {#if w >= 210 && !bare}
      <span data-nolift class="plus">
        {#if active && !SINGLE.has(active.kind)}
          <Button icon="plus" variant="icon" size="sm" disabled={active.kind === 'terminal' && !conn.canTerminal} tip={active.kind === 'terminal' ? 'New terminal' : 'New tab'} onclick={() => panes.addTab(conv, active!.kind, g.id)} />
        {:else}
          <Button icon="plus" variant="icon" size="sm" on={menu?.kind === 'add'} tip="Add tab" onclick={(e) => open('add', e)} />
        {/if}
      </span>
    {/if}
    <span class="sp"></span>
    <span class="ctl" data-nolift>
      {#if !compact && !bare}
        <Button icon={wide ? 'splitcols' : 'splitrows'} variant="icon" size="sm" on={menu?.kind === 'split'} tip={wide ? 'Split right' : 'Split down'}
          onclick={(e) => { if (panes.canSplit(conv, g.id)) panes.split(conv, g.id, wide ? 'right' : 'bottom'); else open('split', e); }} />
      {/if}
      {#if !bare}<Button icon="more" variant="icon" size="sm" on={menu?.kind === 'more'} tip="More" onclick={(e) => open('more', e)} />{/if}
      {#if !compact}
        <Button icon={expanded ? 'minimize' : 'maximize'} variant="icon" size="sm" tip={expanded ? 'Restore' : 'Maximize'} onclick={() => panes.toggleExpanded(conv, g.id)} />
      {/if}
      <Button icon="close" variant="icon" size="sm" tip="Close pane" onclick={() => ended(panes.closePane(conv, g.id))} />
    </span>
  </header>
  <div class="content">
    {#each g.tabs as t (t.id)}
      <div class="tabbody" class:hidden={t.id !== g.active} role="tabpanel">{@render body(t, t.id === g.active)}</div>
    {/each}
  </div>
</section>

{#if menu}
  <Menu anchor={menu.anchor} end={menu.kind !== 'add'} width={240} items={menu.kind === 'add' ? addItems() : menu.kind === 'split' ? splitItems(wide ? 'right' : 'bottom') : moreItems()} onpick={pick} onclose={() => (menu = null)} />
{/if}

<style>
  .card { position: relative; flex: 1; display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--content); border: 0; border-radius: var(--r-xl);
    overflow: hidden; transition: opacity var(--t-quick) var(--ease-snap); }
  /* The outline over the card's contents, so a pane with its own background (a terminal) can't paint over it. */
  .card::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 var(--hairline) var(--hair2); pointer-events: none; z-index: 3; }
  header { position: relative; height: calc(var(--card-head) + var(--grab-room)); flex: none; display: flex; align-items: center; gap: var(--sp-1); padding: var(--grab-room) var(--gutter) 0; box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair);
    -webkit-user-select: none; user-select: none; }
  header.corner { padding-left: calc(var(--gutter) + var(--fold-inset, 0px)); }
  .grab { position: absolute; top: 2px; left: 50%; width: 28px; height: 3px; margin-left: -14px; border-radius: 2px; background: var(--hair2); opacity: 0; cursor: grab;
    transition: opacity var(--t-fast) ease-out; }
  header:hover .grab { opacity: 1; }
  .tabs { display: flex; align-items: center; gap: var(--sp-0h); min-width: 0; flex: 0 1 auto; overflow-x: auto; overscroll-behavior-x: contain; scrollbar-width: none; }
  .tabs::-webkit-scrollbar { display: none; }
  .tabs:global([data-cut-r]) { mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent); }
  .tabs:global([data-cut-l]) { mask-image: linear-gradient(to right, transparent, #000 20px); }
  .tabs:global([data-cut-l][data-cut-r]) { mask-image: linear-gradient(to right, transparent, #000 20px, #000 calc(100% - 20px), transparent); }
  .title { display: inline-flex; align-items: center; gap: var(--sp-1h); font-size: var(--fs-title); font-weight: 500; letter-spacing: -0.1px; padding: 0 var(--sp-1h) 0 0; white-space: nowrap; min-width: 0; }
  .title span { overflow: hidden; text-overflow: ellipsis; }
  .tab { display: inline-flex; align-items: center; height: 28px; border-radius: 7px; color: var(--ink2); font-size: var(--fs-dense);
    flex: 0 1 auto; min-width: 72px; max-width: 200px; transition: background var(--t-fast) ease-out, color var(--t-fast) ease-out; }
  .tab.on { flex-shrink: 0; max-width: 260px; background: var(--sel); color: var(--ink); font-weight: var(--w-control); }
  .tab:not(.on):hover { background: var(--hover); color: var(--ink); }
  .sel { display: inline-flex; align-items: center; gap: var(--sp-1h); height: 100%; min-width: 0; flex: 1; padding: 0 var(--sp-0h) 0 var(--sp-2); border-radius: var(--r-md); }
  .sel span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .x { display: inline-flex; flex: none; border-radius: var(--r-xs); padding: var(--sp-0h); margin-right: var(--sp-1); color: var(--muted); opacity: 0; transition: opacity var(--t-fast) ease-out, background var(--t-fast) ease-out; }
  .tab:hover .x, .tab.on .x, .x:focus-visible { opacity: 1; }
  .x:hover { background: var(--sel); color: var(--ink); }
  .plus { display: inline-flex; flex: none; }
  .ctl { display: inline-flex; align-items: center; gap: var(--sp-1); flex: none; }
  .sp { flex: 1; align-self: stretch; min-width: var(--sp-2); }
  /* (A size container: a card's empty and error states drop their glyph when the card is short.) */
  /* (A card's lists sit closer than the window's: its rows, menus' triggers and buttons at the dense size.) */
  .content { flex: 1; min-height: 0; position: relative; container: card / size; --fs-body: var(--fs-dense); }
  .tabbody { position: absolute; inset: 0; display: flex; flex-direction: column; animation: fade var(--t-base) var(--ease-base); }
  .tabbody.hidden { visibility: hidden; pointer-events: none; animation: none; }
  /* (More below the fold: a hairline at the card's bottom edge, lib/edges.ts; a card with a footer that stays
     ([data-card-foot]) draws it over the footer instead.) */
  .tabbody::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: var(--hairline); background: var(--hair2); opacity: 0; transition: opacity var(--t-quick) ease-out; pointer-events: none; }
  .tabbody:global([data-more-bottom]:not(:has(> [data-card-foot])))::after { opacity: 1; }
</style>
