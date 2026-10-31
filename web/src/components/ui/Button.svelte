<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts" module>
  export type ButtonVariant = 'default' | 'primary' | 'quiet' | 'danger' | 'solid-danger' | 'icon';
  export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';
</script>

<script lang="ts">
  // The one button (the mockup's .btn / .btn.primary / .btn.quiet / .iconbtn;
  // open-claude-ui CdsButton.tsx's states): default, primary (one per screen), quiet (no edge), danger,
  // solid-danger (a confirm that can't be undone), icon (square, glyph only, named by its tip). States: hover 60 ms,
  // pressed 120 ms snap, focus-visible ring, disabled, `on` (lit while its menu or tool is open), `busy` (a spinner,
  // the width kept). A press that travels more than 4px before release is not a click (CdsButton's dead zone).
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Icon from '../Icon.svelte';
  import { tip as tipAt } from '../../lib/tip';

  interface Props extends Omit<HTMLButtonAttributes, 'class'> {
    variant?: ButtonVariant;
    /** Text buttons: sm 28, md --control (32), lg 40. Icon buttons: xs 24, sm 28, md 32. */
    size?: ButtonSize;
    /** A glyph before the label (or the only content of an icon button). */
    icon?: string;
    /** A glyph after the label (a chevron, an arrow). */
    iconEnd?: string;
    iconSize?: number;
    busy?: boolean;
    /** Lit: its menu, popover or tool is open. */
    on?: boolean;
    block?: boolean;
    /** Tooltip (and the accessible name of an icon button). */
    tip?: string;
    /** A key hint at the end, e.g. "⌘N". */
    kbd?: string;
    /** The <button> element (for anchoring a menu to it). */
    el?: HTMLButtonElement;
    class?: string;
    children?: Snippet;
  }
  let {
    variant = 'default', size = 'md', icon, iconEnd, iconSize, busy = false, on = false, block = false, tip, kbd,
    el = $bindable(), class: cls = '', children, onclick, disabled, type = 'button', ...rest
  }: Props = $props();

  const isIcon = $derived(variant === 'icon');
  const glyph = $derived(iconSize ?? (isIcon ? (size === 'xs' ? 16 : size === 'sm' ? 18 : 20) : size === 'lg' ? 18 : 16));
  const classes = $derived(
    [isIcon ? 'iconbtn' : 'btn', !isIcon && variant !== 'default' ? variant : '', size !== 'md' ? size : '', on ? 'on' : '', block ? 'block' : '', busy ? 'busy' : '', cls]
      .filter(Boolean).join(' '),
  );

  // (The 4px dead zone: a press that moved is a drag, not a click.)
  let down: { x: number; y: number } | null = null;
  let moved = false;
  function pointerdown(e: PointerEvent) { down = { x: e.clientX, y: e.clientY }; moved = false; }
  function pointerup(e: PointerEvent) { if (down && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) moved = true; down = null; }
  function click(e: MouseEvent & { currentTarget: EventTarget & HTMLButtonElement }) {
    if (moved) { moved = false; e.preventDefault(); e.stopPropagation(); return; }
    onclick?.(e);
  }
</script>

<button bind:this={el} {type} class={classes} disabled={disabled || busy} aria-busy={busy || undefined}
  onpointerdown={pointerdown} onpointerup={pointerup} onclick={click} {@attach tipAt(tip)} {...rest}>
  {#if icon}<Icon name={icon} size={glyph} />{/if}
  {#if children}<span class="lbl cut">{@render children()}</span>{/if}
  {#if iconEnd}<Icon name={iconEnd} size={glyph} />{/if}
  {#if kbd}<span class="kbd">{kbd}</span>{/if}
  {#if busy}<span class="spinner btn-spin"></span>{/if}
</button>

<style>
  .lbl { display: inline-flex; align-items: center; gap: var(--sp-1h); min-width: 0; overflow: hidden; text-overflow: ellipsis; }
</style>
