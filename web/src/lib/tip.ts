// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Tooltips: a short ink pill in the top layer, never clipped, below its element and
 * flipped above near the edge. It shows after 400 ms of hover (at once when another tooltip just showed, and at
 * once on keyboard focus), goes on pointer down, Esc, scrolling or leaving, and waits while a menu is open.
 * Replaces the native `title=` (a grey system bubble after about a second).
 *
 *   <button {@attach tip('Close  Esc')}>…</button>
 *   <Button variant="icon" icon="close" tip="Close" />          (ui/Button passes it through)
 *   <span {@attach tip(text, { placement: 'right', align: 'start' })}>
 *
 * An element with no text and no aria-label takes the tip as its aria-label (icon buttons stay named).
 */
import type { Attachment } from 'svelte/attachments';
import type { Placement } from '@floating-ui/dom';
import { float } from './floating';
import { layer, layerRoot } from './layer.svelte';

export interface TipOptions { placement?: Placement }

let bubble: HTMLDivElement | null = null;
let owner: HTMLElement | null = null;
let stop: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastHidden = 0;
const DELAY = 400, WARM = 400;

function el(): HTMLDivElement {
  if (!bubble) {
    bubble = document.createElement('div');
    bubble.className = 'tooltip';
    bubble.id = 'cr-tooltip';
    bubble.setAttribute('role', 'tooltip');
  }
  if (!bubble.isConnected) layerRoot().appendChild(bubble);
  return bubble;
}

function show(target: HTMLElement, text: string, o: TipOptions) {
  if (!text || !target.isConnected) return;
  // (Not while a menu is open, except for the menu's own rows.)
  if (layer.popoverOpen && !target.closest('.popover')) return;
  hide(false);
  const b = el();
  b.textContent = text;
  owner = target;
  target.setAttribute('aria-describedby', b.id);
  stop = float(b, { anchor: target, placement: o.placement ?? 'bottom', gap: 6 });
  requestAnimationFrame(() => b.classList.add('on'));
}

function hide(mark = true) {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!owner) return;
  owner.removeAttribute('aria-describedby');
  owner = null;
  stop?.();
  stop = null;
  bubble?.classList.remove('on');
  if (mark) lastHidden = Date.now();
}

if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => hide(), true);
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); }, true);
  window.addEventListener('blur', () => hide());
}

export function tip(text: string | null | undefined, o: TipOptions = {}): Attachment<HTMLElement> {
  return (node) => {
    const t = (text ?? '').trim();
    if (!t) return;
    const named = !!node.getAttribute('aria-label') || !!node.textContent?.trim();
    if (!named) node.setAttribute('aria-label', t);
    const enter = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      if (timer) clearTimeout(timer);
      const wait = Date.now() - lastHidden < WARM ? 0 : DELAY;
      timer = setTimeout(() => show(node, t, o), wait);
    };
    const leave = () => { if (owner === node || timer) hide(); };
    // (Not on the phone: a tapped field is :focus-visible too, and the tip would cover what is under it.)
    const focus = () => { if (node.matches(':focus-visible') && !document.documentElement.hasAttribute('data-phone')) show(node, t, o); };
    node.addEventListener('pointerenter', enter);
    node.addEventListener('pointerleave', leave);
    node.addEventListener('pointerdown', leave);
    node.addEventListener('focus', focus);
    node.addEventListener('blur', leave);
    // (The text changed while showing: show the new words.)
    if (owner === node && bubble) bubble.textContent = t;
    return () => {
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('pointerdown', leave);
      node.removeEventListener('focus', focus);
      node.removeEventListener('blur', leave);
      if (!named) node.removeAttribute('aria-label');
      if (owner === node) hide();
    };
  };
}
