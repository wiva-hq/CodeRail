<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Toasts (LANGUAGE.md "States"): an ink pill near the bottom — a glyph, one line, an action when there is one.
  // In 200 ms from below, out 150 ms upward; 3.8 s on screen (6 s with an action); the pointer over it holds it.
  //   app.toast('Saved')
  //   app.toast('Couldn’t reach the server', 'warning', { label: 'Retry', run: () => … })
  import { app as store, type Toast } from '../../lib/app.svelte';
  import { toast as motion } from '../../lib/motion';
  import Icon from '../Icon.svelte';

  function life(node: HTMLElement, t: Toast) {
    let left = t.action ? 6000 : 3800, started = Date.now(), timer = setTimeout(go, left);
    function go() { store.dismissToast(t.id); }
    const hold = () => { clearTimeout(timer); left -= Date.now() - started; };
    const resume = () => { started = Date.now(); timer = setTimeout(go, Math.max(left, 1200)); };
    node.addEventListener('pointerenter', hold);
    node.addEventListener('pointerleave', resume);
    return () => { clearTimeout(timer); node.removeEventListener('pointerenter', hold); node.removeEventListener('pointerleave', resume); };
  }

  // Above the composer area (the composer and a docked ask card over it), never on it: while a toast shows, its
  // bottom follows the top of the composer's footer. With no composer on screen, the fallback in the style below.
  let lift = $state<number | null>(null);
  $effect(() => {
    if (!store.toasts.length) return;
    const area = () => { const c = document.querySelector<HTMLElement>('.composer'); return c?.closest<HTMLElement>('.foot') ?? c ?? null; };
    const place = () => { const r = area()?.getBoundingClientRect(); lift = r && r.height ? window.innerHeight - r.top : null; };
    place();
    const ro = new ResizeObserver(place);
    const el = area();
    if (el) ro.observe(el);
    window.addEventListener('resize', place);
    return () => { ro.disconnect(); window.removeEventListener('resize', place); };
  });
</script>

<div class="toasts" aria-live="polite" style:bottom={lift === null ? undefined : `calc(${lift}px + var(--sp-3))`}>
  {#each store.toasts as t (t.id)}
    <div class="toast" role="status" transition:motion {@attach (n) => life(n, t)}>
      <span class="ic" class:ok={t.icon === 'success'} class:warn={t.icon === 'warning'}><Icon name={t.icon} size={18} /></span>
      <span class="tx cut">{t.text}</span>
      {#if t.action}{@const a = t.action}<button class="act" onclick={() => { a.run(); store.dismissToast(t.id); }}>{a.label}</button>{/if}
    </div>
  {/each}
</div>

<style>
  .toasts { position: fixed; left: 0; right: 0; bottom: var(--sp-12); display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); z-index: var(--z-toast); pointer-events: none; }
  .toast { display: flex; align-items: center; gap: var(--row-x); min-height: 40px; max-width: min(560px, calc(100vw - 2 * var(--gutter))); padding: 0 var(--sp-2) 0 var(--sp-3); border-radius: var(--r-lg);
    background: var(--primary); color: var(--onprimary); font-weight: var(--w-control); box-shadow: var(--shadow-pop); pointer-events: auto; }
  .tx { padding-right: var(--sp-1h); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ic { display: inline-flex; }
  .ic.ok { color: var(--ok); }
  .ic.warn { color: var(--warn); }
  .act { height: 28px; padding: 0 var(--row-x); border-radius: var(--r-sm); font-weight: var(--w-head); color: var(--onprimary); box-shadow: inset 0 0 0 var(--hairline) var(--onprimary-hair); }
  .act:hover { background: var(--onprimary-hair); }
  /* (The phone without a composer: over the tab bar.) */
  :global(:root[data-phone]) .toasts { bottom: calc(var(--safe-b, 0px) + var(--sp-16) + var(--sp-8)); }
</style>
