<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The modal base under Sheet and Settings (open-claude-ui ConfirmationDialog.tsx): in the top
  // layer, a scrim that fades (200 ms) and a card that rises (300 ms, base curve; the phone's slides up from the
  // bottom edge) and leaves the same way. Focus moves in (the first field, else the card) and stays in
  // (focus-trap), then goes back to where it was. Esc closes the top layer only. Return presses the card's primary
  // button (`.btn.primary` / `[data-primary]`) unless focus is in a text area. A scrim click closes only when
  // `scrimCloses` (a half-filled sheet is not lost by a stray click).
  import type { Snippet } from 'svelte';
  import { createFocusTrap } from 'focus-trap';
  import Portal from './Portal.svelte';
  import { layer } from '../../lib/layer.svelte';
  import { fade, rise, sheetUp } from '../../lib/motion';

  let { onclose, label, scrimCloses = false, class: cls = '', style = '', autofocus, phoneSheet = true, children }: {
    onclose: () => void;
    label: string;
    scrimCloses?: boolean;
    class?: string;
    style?: string;
    /** What to focus first: a selector inside the card, or false for the card itself. */
    autofocus?: string | false;
    /** On the phone, slide up from the bottom (default) rather than rise. */
    phoneSheet?: boolean;
    children: Snippet;
  } = $props();

  let card = $state<HTMLDivElement>();
  const phone = typeof document !== 'undefined' && !!document.documentElement.dataset.phone;
  // svelte-ignore state_referenced_locally
  const enter = phone && phoneSheet ? sheetUp : rise;
  $effect(() => layer.push('modal', () => onclose()));

  $effect(() => {
    if (!card) return;
    const node = card;
    const trap = createFocusTrap(node, {
      initialFocus: () => {
        if (autofocus === false) return node;
        const sel = autofocus ?? 'input:not([type=checkbox]):not([type=radio]):not([disabled]), textarea:not([disabled])';
        return node.querySelector<HTMLElement>(sel) ?? node;
      },
      fallbackFocus: node,
      escapeDeactivates: false,
      clickOutsideDeactivates: false,
      allowOutsideClick: true,
      returnFocusOnDeactivate: true,
      preventScroll: true,
    });
    const t = setTimeout(() => { try { trap.activate(); } catch { /* nothing to focus */ } }, 50);
    return () => { clearTimeout(t); trap.deactivate(); };
  });

  function key(e: KeyboardEvent) {
    if (e.key !== 'Enter' || e.defaultPrevented || e.isComposing || e.keyCode === 229 || e.shiftKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('textarea, [contenteditable], select') && !e.metaKey) return;
    if (t.closest('button, a, [role=radio], [role=menuitem]') && t !== card) return;
    const primary = card?.querySelector<HTMLButtonElement>('[data-primary]:not(:disabled), .foot .btn.primary:not(:disabled)');
    if (primary) { e.preventDefault(); primary.click(); }
  }
</script>

<Portal>
  <div class="modal-scrim" role="presentation" transition:fade|global onpointerdown={() => scrimCloses && onclose()}></div>
  <div bind:this={card} class="modal {cls}" {style} role="dialog" aria-modal="true" aria-label={label} tabindex="-1" onkeydown={key}
    transition:enter|global>
    {@render children()}
  </div>
</Portal>

<style>
  .modal-scrim { position: fixed; inset: 0; z-index: var(--z-layer); background: var(--scrim); }
  .modal { position: fixed; z-index: var(--z-layer); outline: none; }
</style>
