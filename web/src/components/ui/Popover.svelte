<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A popover in the top layer (the mockup's .menu): anchored to its trigger (or a point) with
  // @floating-ui/dom, flipped and shifted at the window's edges, its height capped to the room (it scrolls), pops
  // in from the anchored corner (200 ms, pop curve) and fades out (120 ms). A transparent scrim catches the click
  // outside and closes only this popover; Esc closes it (the top layer only); focus stays inside while it is open
  // (focus-trap) and goes back to where it was after. Works inside sheets and above scrims: it renders in #layer.
  //
  //   <Popover anchor={buttonEl} placement="bottom-end" onclose={() => (open = false)}>…</Popover>
  import type { Snippet } from 'svelte';
  import type { Placement } from '@floating-ui/dom';
  import { edges } from '../../lib/edges';
  import { createFocusTrap, type FocusTargetValueOrFalse } from 'focus-trap';
  import Portal from './Portal.svelte';
  import { layer } from '../../lib/layer.svelte';
  import { float, type Anchor } from '../../lib/floating';
  import { pop } from '../../lib/motion';

  let {
    anchor, placement = 'bottom-start', gap = 6, width, maxHeight = 420, matchWidth = false, onclose,
    role = 'dialog', label, class: cls = '', initialFocus, trap = true, scrim = true, onkeydown, children,
  }: {
    anchor: Anchor;
    placement?: Placement;
    gap?: number;
    width?: number;
    maxHeight?: number;
    /** At least the trigger's width (selects). */
    matchWidth?: boolean;
    onclose: () => void;
    role?: string;
    label?: string;
    class?: string;
    /** What gets focus on open (an element or a function giving one); the popover itself by default. */
    initialFocus?: FocusTargetValueOrFalse | (() => HTMLElement | undefined);
    /** Keep Tab inside (default). */
    trap?: boolean;
    /** A transparent scrim takes the outside click (default); off for a list that follows typing elsewhere (the
     * composer's @mention list: the text keeps focus and the clicks). */
    scrim?: boolean;
    onkeydown?: (e: KeyboardEvent) => void;
    children: Snippet;
  } = $props();

  let el = $state<HTMLDivElement>();
  // (A long list: soft fades at the edges where rows are cut, base.css.)
  const y = $derived(placement.startsWith('top') ? 4 : placement.startsWith('bottom') ? -4 : 0);

  // On the layer stack: Esc closes this one only.
  $effect(() => layer.push('popover', () => onclose()));

  $effect(() => {
    if (!el || !trap) return;
    const node = el;
    const t = createFocusTrap(node, {
      initialFocus: () => {
        const f = typeof initialFocus === 'function' ? (initialFocus as () => HTMLElement | undefined)() : initialFocus;
        return (f as HTMLElement | undefined) ?? node;
      },
      fallbackFocus: node,
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      returnFocusOnDeactivate: true,
      preventScroll: true,
    });
    // (After the first frame: the rows exist and are placed.)
    const raf = requestAnimationFrame(() => { try { t.activate(); } catch { /* nothing focusable */ } });
    return () => { cancelAnimationFrame(raf); t.deactivate(); };
  });

  function outside(e: Event) { e.preventDefault(); e.stopPropagation(); onclose(); }
</script>

<Portal>
  {#if scrim}<div class="layer-scrim" role="presentation" onpointerdown={outside} oncontextmenu={outside}></div>{/if}
  <div bind:this={el} class="popover {cls}" {role} aria-label={label} tabindex="-1" {onkeydown}
    style:width={width ? `${width}px` : undefined}
    transition:pop|global={{ y }}
    {@attach (node) => float(node, { anchor, placement, gap, maxHeight, matchWidth })} {@attach edges({ host: (n) => n })}>
    {@render children()}
  </div>
</Portal>
