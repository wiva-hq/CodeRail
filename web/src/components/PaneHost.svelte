<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The pane tree of a project, laid out by hand: panes.place gives every card (and the chat) a box in the area, and
  // each is drawn once, absolutely, in a flat list by id — so a card moved to another place in the tree is the same
  // element moved, never a new one (the chat, a terminal or a page never reload), and the browser slides it there
  // (transform, width and height transitions).
  //
  // A drag: the held card lifts (a shadow) and stays under the pointer, moved straight on the element each frame — the
  // pointer is never state, so nothing renders while it moves. Where it would land is read against the boxes as they
  // were when it was picked up; only when that changes does the tree change, to the tree as it will be (panes.view),
  // and the other cards slide out of its way. Let go, it slides into the place left for it. Over a card's middle it
  // would join its tabs (a ring on that card); over a tab strip, a thin bar between tabs. A tab carries as a chip.
  //
  // Dividers sit in the gaps: drag to resize (each side keeps its minimum: the chat 380×400, a card 260×160), Esc
  // puts it back, a double-click shares the two sides evenly, ← → (↑ ↓) move it from the keyboard. While one drags,
  // nothing slides, and pages and terminals don't take the pointer. A maximized card covers the area.
  import type { Snippet } from 'svelte';
  import { panes, place, leaves, minSize, GLYPH, GAP, type Group, type Side, type Drop, type Box, type Gap } from '../lib/panes.svelte';
  import { tabTitle } from '../lib/tabs';
  import { ease, ms, reduced } from '../lib/motion';
  import Icon from './Icon.svelte';
  let { conv, chat, card }: { conv: string; chat: Snippet; card: Snippet<[Group]> } = $props();

  let area = $state<HTMLElement>();
  let w = $state(0), h = $state(0);
  $effect(() => { panes.rect = { w, h }; });

  let l = $derived(panes.get(conv));
  let ids = $derived(leaves(l.root).sort());
  let geo = $derived(place(panes.view(conv), { x: 0, y: 0, w, h }));
  let held = $derived(panes.drag?.conv === conv && panes.drag.item.type === 'pane' ? panes.drag.item.id : null);

  /** A card's box: its place, the whole area when it is maximized. A card at the area's left edge keeps the gap from the
   * sidebar that the chat (no frame of its own) doesn't need. */
  function boxOf(id: string): Box {
    const b = l.expanded === id ? { x: 0, y: 0, w, h } : geo.leaves[id] ?? { x: 0, y: 0, w: 0, h: 0 };
    return id !== 'chat' && b.x < 1 ? { ...b, x: GAP, w: b.w - GAP } : b;
  }

  // ---- sliding: on while the tree changes by a drag, an opened or closed card or a drop; off while a divider or the
  // window resizes (those follow the pointer and the window at once).
  let slide = $state(false);
  let slideTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSize = '';
  $effect.pre(() => {
    void geo;
    const size = `${w}x${h}`;
    if (size !== lastSize || panes.resizing) { lastSize = size; slide = false; return; }
    slide = true;
    clearTimeout(slideTimer);
    slideTimer = setTimeout(() => (slide = false), ms.sheet + 60);
  });

  // ---- the drag
  /** The boxes when the card was picked up (in the window's coordinates) and where on the card it was taken. */
  let pick: { boxes: Record<string, DOMRect>; gx: number; gy: number; w: number; h: number } | null = null;
  /** The held card's size, kept while it is carried. */
  let size = $state<{ w: number; h: number } | null>(null);
  let px = 0, py = 0, frame = 0;
  let ghost = $state<HTMLElement>();

  $effect.pre(() => {
    const d = panes.drag;
    if (!d || d.conv !== conv) { pick = null; size = null; return; }
    if (pick || !area) return;
    const a = area.getBoundingClientRect();
    const boxes: Record<string, DOMRect> = {};
    for (const [id, b] of Object.entries(place(l.root, { x: 0, y: 0, w, h }).leaves)) boxes[id] = new DOMRect(a.left + b.x, a.top + b.y, b.w, b.h);
    const mine = d.item.type === 'pane' ? boxes[d.item.id] : undefined;
    pick = { boxes, gx: mine ? d.x - mine.left : 0, gy: mine ? d.y - mine.top : 0, w: mine?.width ?? 0, h: mine?.height ?? 0 };
    size = mine ? { w: mine.width, h: mine.height } : null;
    px = d.x; py = d.y;
    queueMicrotask(paint);
  });

  /** Where the held card is drawn: under the pointer, in the area's coordinates. */
  function paint() {
    frame = 0;
    const d = panes.drag;
    if (!d || !pick || !area) return;
    const a = area.getBoundingClientRect();
    const el = held ? area.querySelector<HTMLElement>(`[data-leaf="${CSS.escape(held)}"]`) : null;
    el?.style.setProperty('--fx', `${px - pick.gx - a.left}px`);
    el?.style.setProperty('--fy', `${py - pick.gy - a.top}px`);
    if (ghost) ghost.style.transform = `translate(${px + 14}px, ${py + 10}px)`;
    const drop = dropAt(px, py);
    if (!same(drop, d.drop)) panes.drag = { ...d, drop };
  }
  function moved(e: PointerEvent) {
    if (!panes.drag || panes.drag.conv !== conv) return;
    px = e.clientX; py = e.clientY;
    if (!frame) frame = requestAnimationFrame(paint);
  }
  function same(a: Drop | null, b: Drop | null) {
    if (!a || !b) return a === b;
    if (a.kind !== b.kind || a.target !== b.target) return false;
    if (a.kind === 'dock' && b.kind === 'dock') return a.side === b.side;
    if (a.kind === 'tabs' && b.kind === 'tabs') return a.index === b.index;
    return true;
  }

  /** Where a tab strip would take it: the gap nearest the pointer, as a thin bar. */
  function tabsDrop(el: HTMLElement, target: string, x: number): Drop | null {
    const strip = el.querySelector('[data-tabs]') as HTMLElement | null;
    if (!strip) return null;
    const tabs = [...strip.querySelectorAll('[data-tab]')] as HTMLElement[];
    const sr = strip.getBoundingClientRect();
    let index = tabs.length, at = tabs.length ? tabs[tabs.length - 1].getBoundingClientRect().right + 1 : sr.left + 4;
    for (let i = 0; i < tabs.length; i++) {
      const r = tabs[i].getBoundingClientRect();
      if (x < r.left + r.width / 2) { index = i; at = r.left - 1; break; }
    }
    const d = panes.drag!;
    // (A tab dropped where it already is changes nothing.)
    if (d.item.type === 'tab') {
      const own = panes.group(conv, target)?.tabs.findIndex((t) => t.id === d.item.id) ?? -1;
      if (own >= 0 && (index === own || index === own + 1)) return null;
    }
    return { kind: 'tabs', target, index, rect: new DOMRect(at - 1, sr.top + 6, 2, sr.height - 12) };
  }

  /** What the pointer is over, read against the boxes at pick-up (the cards moving out of the way don't move it). */
  function dropAt(x: number, y: number): Drop | null {
    const d = panes.drag;
    if (!d || !pick) return null;
    const hit = Object.entries(pick.boxes).find(([, r]) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom);
    if (!hit) return null;
    const [target, r] = hit;
    const self = d.item.type === 'pane' && d.item.id === target;
    if (self) return null;
    const inHeader = target !== 'chat' && y - r.top < 46; // (a card's header: --card-head + --grab-room, and a little)
    if (inHeader && d.item.id !== 'chat') {
      const el = area?.querySelector<HTMLElement>(`[data-leaf="${CSS.escape(target)}"]`);
      return el ? tabsDrop(el, target, x) : null;
    }
    const rx = (x - r.left) / r.width, ry = (y - r.top) / r.height;
    const edges: [Side, number][] = [['left', rx], ['right', 1 - rx], ['top', ry], ['bottom', 1 - ry]];
    edges.sort((a, b) => a[1] - b[1]);
    const [side, dist] = edges[0];
    if (target !== 'chat' && d.item.id !== 'chat' && dist > 0.3) return { kind: 'merge', target, rect: r };
    return { kind: 'dock', side, target, rect: r };
  }

  // (Esc while something is lifted puts it down where it was.)
  $effect(() => {
    if (!panes.drag) return;
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); panes.drag = null; } };
    document.addEventListener('keydown', esc, true);
    return () => document.removeEventListener('keydown', esc, true);
  });
  function up() {
    if (!panes.drag || panes.drag.conv !== conv) return;
    if (frame) { cancelAnimationFrame(frame); paint(); }
    panes.land();
  }

  /** A tab taken out of its card: the chip the pointer carries (a whole card moves itself). */
  let carried = $derived.by(() => {
    const d = panes.drag;
    if (!d || d.conv !== conv || d.item.type !== 'tab') return null;
    const t = panes.tabs(conv).find((x) => x.id === d.item.id);
    return t ? { icon: GLYPH[t.kind], title: tabTitle(t) } : null;
  });
  let ring = $derived(panes.drag?.conv === conv && panes.drag.drop?.kind === 'merge' ? panes.drag.drop.target : null);

  // ---- dividers
  let active = $state<string | null>(null);
  const gapKey = (g: Gap) => `${g.path.join('.')}:${g.i}`;
  /** The weights for the pair with the first `na` px wide (tall), each kept to its minimum. */
  function weightsAt(g: Gap, na: number, w0: number[]) {
    const v = g.v, n = g.node;
    const sizeA = v ? g.a.h : g.a.w, sizeB = v ? g.b.h : g.b.w;
    const minA = v ? minSize(n.items[g.i]).h : minSize(n.items[g.i]).w;
    const minB = v ? minSize(n.items[g.i + 1]).h : minSize(n.items[g.i + 1]).w;
    const total = sizeA + sizeB;
    // (A window too small for both minimums: the pair keeps what it has.)
    const lo = Math.min(minA, total / 2), hi = Math.max(total - minB, total / 2);
    const a = Math.min(Math.max(na, lo), hi);
    const out = [...w0], sum = w0[g.i] + w0[g.i + 1];
    out[g.i] = (sum * a) / total; out[g.i + 1] = sum - out[g.i];
    return out;
  }
  function grip(e: PointerEvent, g: Gap) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.focus({ preventScroll: true });
    handle.setPointerCapture(e.pointerId);
    const start = g.v ? e.clientY : e.clientX, sizeA = g.v ? g.a.h : g.a.w, w0 = [...g.node.w];
    active = gapKey(g);
    panes.resizing = g.v ? 'row' : 'col';
    let f = 0, at = start;
    const move = (m: PointerEvent) => { at = g.v ? m.clientY : m.clientX; if (!f) f = requestAnimationFrame(() => { f = 0; panes.weights(conv, g.path, weightsAt(g, sizeA + (at - start), w0)); }); };
    const end = () => {
      handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', end); handle.removeEventListener('pointercancel', end);
      handle.removeEventListener('keydown', esc);
      if (f) cancelAnimationFrame(f);
      active = null; panes.resizing = null;
    };
    const esc = (k: KeyboardEvent) => { if (k.key === 'Escape') { k.preventDefault(); k.stopPropagation(); if (f) cancelAnimationFrame(f); f = 0; panes.weights(conv, g.path, w0); try { handle.releasePointerCapture(e.pointerId); } catch { /* gone */ } end(); } };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', esc);
  }
  /** Both sides even again. */
  function even(g: Gap) { panes.weights(conv, g.path, weightsAt(g, ((g.v ? g.a.h + g.b.h : g.a.w + g.b.w)) / 2, g.node.w)); }
  function key(e: KeyboardEvent, g: Gap) {
    const back = g.v ? 'ArrowUp' : 'ArrowLeft', fwd = g.v ? 'ArrowDown' : 'ArrowRight';
    if (e.key !== back && e.key !== fwd) return;
    e.preventDefault();
    panes.weights(conv, g.path, weightsAt(g, (g.v ? g.a.h : g.a.w) + (e.key === fwd ? 1 : -1) * (e.shiftKey ? 64 : 16), g.node.w));
  }

  /** A card that opens (or comes back) settles in: opacity and a hair of scale; a card moved by a drag just slides. */
  function cardIn(_n: Element) {
    if (reduced() || panes.drag) return { duration: 0 };
    return { duration: ms.base, easing: ease.base, css: (t: number) => `opacity:${t};scale:${0.985 + 0.015 * t}` };
  }
</script>

<svelte:window onpointermove={moved} onpointerup={up} />

<div class="host" class:dragging={!!panes.drag} data-resizing={panes.resizing}>
  <div class="area" class:slide bind:this={area} bind:clientWidth={w} bind:clientHeight={h}>
    {#each ids as id (id)}
      {@const b = boxOf(id)}
      {@const g = id === 'chat' ? null : panes.group(conv, id)}
      <div class="leaf" class:chat={id === 'chat'} class:lifted={held === id} class:ring={ring === id} class:max={l.expanded === id}
        class:behind={!!l.expanded && l.expanded !== id} data-leaf={id}
        style:transform={held === id ? `translate3d(var(--fx, ${b.x}px), var(--fy, ${b.y}px), 0) scale(0.98)` : `translate3d(${b.x}px, ${b.y}px, 0)`}
        style:width="{held === id && size ? size.w : b.w}px" style:height="{held === id && size ? size.h : b.h}px"
        in:cardIn>
        {#if id === 'chat'}{@render chat()}{:else if g}{@render card(g)}{/if}
      </div>
    {/each}
    {#if !l.expanded}
      {#each geo.gaps as g (gapKey(g))}
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions (a focusable separator is a widget: ARIA's window splitter) -->
        <div class="divider" class:v={g.v} class:active={active === gapKey(g)} tabindex="-1" role="separator" aria-orientation={g.v ? 'horizontal' : 'vertical'}
          aria-label="Resize; double-click to equalize" style="left:{g.box.x}px;top:{g.box.y}px;width:{g.box.w}px;height:{g.box.h}px"
          onpointerdown={(e) => grip(e, g)} ondblclick={() => even(g)} onkeydown={(e) => key(e, g)}><i></i></div>
      {/each}
    {/if}
  </div>
</div>
{#if panes.drag?.conv === conv}
  {#if panes.drag.drop?.kind === 'tabs'}
    {@const r = panes.drag.drop.rect}
    <div class="bar" style="left:{r.left}px;top:{r.top}px;width:{r.width}px;height:{r.height}px"></div>
  {/if}
  {#if carried}
    <div class="ghost" bind:this={ghost}><Icon name={carried.icon} size={14} /><span class="cut">{carried.title}</span></div>
  {/if}
{/if}

<style>
  .host { flex: 1; display: flex; min-width: 0; min-height: 0; padding: 0 var(--sp-2) var(--sp-2) 0; }
  .area { flex: 1; position: relative; min-width: 0; min-height: 0; }
  .host.dragging { cursor: grabbing; }
  .host.dragging :global(*) { cursor: grabbing !important; }
  /* (A divider drags: pages and terminals don't swallow the pointer; the cursor stays the divider's.) */
  .host[data-resizing] :global(iframe), .host[data-resizing] :global(.xterm), .host.dragging :global(iframe) { pointer-events: none; }
  .host[data-resizing='col'], .host[data-resizing='col'] :global(*) { cursor: col-resize !important; }
  .host[data-resizing='row'], .host[data-resizing='row'] :global(*) { cursor: row-resize !important; }

  .leaf { position: absolute; left: 0; top: 0; display: flex; min-width: 0; min-height: 0; will-change: transform; }
  .slide .leaf:not(.lifted) { transition: transform var(--t-sheet) var(--ease-base), width var(--t-sheet) var(--ease-base), height var(--t-sheet) var(--ease-base); }
  /* Held: above everything, under the pointer, with a shadow; it doesn't take the pointer (what is under it does). */
  .leaf.lifted { z-index: var(--z-layer); pointer-events: none; border-radius: var(--r-xl); background: var(--content); box-shadow: var(--shadow-sheet); transform-origin: 0 0; }
  .leaf.ring > :global(*) { box-shadow: 0 0 0 2px var(--hair2); border-radius: var(--r-xl); }
  /* Maximized: the card fills the area; the others stay mounted under it, out of sight. */
  .leaf.max { z-index: var(--z-raised); }
  .leaf.behind { visibility: hidden; }

  .divider { position: absolute; cursor: col-resize; display: flex; align-items: center; justify-content: center; touch-action: none; }
  .divider.v { cursor: row-resize; }
  .divider:focus-visible { outline: none; }
  .divider i { width: 4px; height: 36px; border-radius: 2px; background: var(--hair2); opacity: 0; transition: opacity var(--t-fast) ease-out, background var(--t-quick) var(--ease-snap), height var(--t-quick) var(--ease-snap); }
  .divider.v i { width: 36px; height: 4px; }
  .divider:hover i, .divider:focus-visible i { opacity: 1; }
  .divider.active i, .divider:focus-visible i { opacity: 1; background: var(--muted); height: 48px; }
  .divider.v.active i, .divider.v:focus-visible i { height: 4px; width: 48px; }
  .host.dragging .divider { visibility: hidden; }

  .bar { position: fixed; z-index: var(--z-layer); border-radius: 1px; background: var(--accent); pointer-events: none;
    transition: left var(--t-quick) var(--ease-snap), top var(--t-quick) var(--ease-snap); }
  .ghost { position: fixed; left: 0; top: 0; z-index: var(--z-tooltip); display: inline-flex; align-items: center; gap: var(--sp-1h); height: 28px; padding: 0 var(--row-x); border-radius: var(--r-md);
    background: var(--pop); box-shadow: var(--shadow-pop); color: var(--ink); font-size: var(--fs-small); font-weight: var(--w-control); pointer-events: none; white-space: nowrap; max-width: 240px; }
  .ghost span { overflow: hidden; text-overflow: ellipsis; }
  .ghost :global(svg) { color: var(--ink2); }
</style>
