<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A sheet, also the dialog: on ui/Modal (top layer, scrim, 300 ms rise and exit, focus
  // trap, Esc, Return = the footer's primary button). The serif title, the step bars of a multi-step sheet ("2 of
  // 4", the bars slide), ×, the body (scrolls; a hairline above the footer while more is below), the footer.
  // The phone: from the bottom edge, the screen's width.
  //
  //   <Sheet title="Save version" onclose={…}>
  //     …fields…
  //     {#snippet footer()}<span class="sp"></span><Button onclick={…}>Cancel</Button><Button variant="primary" …>Save</Button>{/snippet}
  //   </Sheet>
  import type { Snippet } from 'svelte';
  import Modal from './Modal.svelte';
  import Button from './Button.svelte';
  let { title, onclose, width = 560, step, steps, autofocus, children, footer }: {
    title: string;
    onclose: () => void;
    width?: number;
    step?: number;
    steps?: number;
    autofocus?: string | false;
    children: Snippet;
    footer?: Snippet;
  } = $props();
  let more = $state(false);
  function sense(node: HTMLElement) {
    const f = () => { more = node.scrollTop + node.clientHeight < node.scrollHeight - 2; };
    f();
    const ro = new ResizeObserver(f);
    ro.observe(node);
    for (const c of node.children) ro.observe(c);
    node.addEventListener('scroll', f, { passive: true });
    return () => { ro.disconnect(); node.removeEventListener('scroll', f); };
  }
</script>

<Modal {onclose} label={title} {autofocus} class="sheet-card" style="--w:{width}px">
  <div class="head">
    <h2>{title}</h2>
    {#if steps}
      <span class="steps" aria-label="Step {step} of {steps}">{#each Array(steps) as _, i (i)}<i class:on={i + 1 === step} class:done={i + 1 < (step ?? 0)}></i>{/each}<span class="n">{step} of {steps}</span></span>
    {/if}
    <Button variant="icon" icon="close" tip="Close  Esc" class="sheet-x" onclick={onclose} />
  </div>
  <div class="body scroll" {@attach sense}>{@render children()}</div>
  {#if footer}<div class="foot" class:more>{@render footer()}</div>{/if}
</Modal>

<style>
  /* Insets: --sheet-pad on every side (the phone: --gutter), so the title, the body and the buttons share one left
     edge; title to body --sp-3; body to buttons --sp-6 (the body keeps --sp-2 of it, room for a field's focus ring
     inside its scroll); a sheet without buttons still ends --sheet-pad from its edge. The × sits in the corner with its
     glyph on the inset (its button's own padding is taken off). */
  :global(.modal.sheet-card) {
    inset: 0 0 6vh; margin: auto; height: fit-content; width: min(var(--w), calc(100vw - 2 * var(--gutter)));
    max-height: calc(100vh - 2 * var(--sp-12));
    display: flex; flex-direction: column; background: var(--panel); border-radius: var(--r-sheet); box-shadow: var(--shadow-sheet);
  }
  .head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sheet-pad) calc(var(--sheet-pad) - var(--sp-1h) - 2px) 0 var(--sheet-pad); }
  h2 { flex: 1; margin: 0; font: 500 var(--fs-sheet) / 28px var(--serif); letter-spacing: -0.3px; color: var(--ink); }
  .steps { display: inline-flex; align-items: center; gap: var(--sp-1); }
  .steps i { width: 20px; height: 2.5px; border-radius: 2px; background: var(--track); transition: background var(--t-base) var(--ease-base), width var(--t-base) var(--ease-base); }
  .steps i.done { background: var(--muted); }
  .steps i.on { background: var(--primary); width: 28px; }
  .steps .n { color: var(--muted); font-size: var(--fs-small); margin-left: var(--sp-2); font-variant-numeric: tabular-nums; }
  /* (Its content's height first, shrinking to scroll under the card's max-height: a basis of 0 in a card whose height
     fits its content left WebKit a body of no height, every field hidden.) */
  .body { padding: var(--sp-4) var(--sheet-pad) var(--sp-2); overflow-y: auto; flex: 1 1 auto; min-height: 0; }
  .body:last-child { padding-bottom: var(--sheet-pad); }
  .foot { display: flex; align-items: center; gap: var(--sp-2); padding: calc(var(--sp-6) - var(--sp-2)) var(--sheet-pad) var(--sheet-pad); transition: box-shadow var(--t-quick) ease-out; }
  .foot.more { box-shadow: 0 calc(-1 * var(--hairline)) 0 var(--hair); }
  .foot :global(.sp) { flex: 1; }
  /* The phone: a sheet from the bottom edge, the screen's width, over the home indicator; --gutter on every side. */
  :global(:root[data-phone] .modal.sheet-card) { left: 0; right: 0; top: auto; bottom: 0; width: 100%; height: auto; margin: 0; max-height: calc(100% - var(--safe-t, 0px) - var(--sp-2));
    border-radius: 18px 18px 0 0; padding-bottom: var(--safe-b, 0px);
    /* (No hairline ring: its sides lie on the screen's edges, where it showed as a stray line round the corners.) */
    box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.35); }
  :global(:root[data-phone]) .head { padding: var(--gutter) var(--gutter) 0; }
  :global(:root[data-phone] .sheet-x) { width: 36px; height: 36px; border-radius: 18px; background: var(--tint); }
  :global(:root[data-phone]) .body { padding: var(--sp-3) var(--gutter) var(--sp-2); }
  :global(:root[data-phone]) .body:last-child { padding-bottom: var(--gutter); }
  :global(:root[data-phone]) .foot { flex-wrap: wrap; padding: calc(var(--sp-6) - var(--sp-2)) var(--gutter) var(--gutter); }
  :global(:root[data-phone]) .foot :global(.btn) { height: 44px; font-size: 16px; }
</style>
