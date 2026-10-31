// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Roving focus (open-claude-ui useClaudeRovingFocus.ts, ported as a Svelte attachment): one item of a group is in
 * the Tab order; the arrow keys move between items (looping), Home/End and PageUp/PageDown go to the ends, Tab
 * leaves the group, and typed letters jump to the first item whose text starts with them (600 ms buffer, as the
 * Mac app's menus). Focus moves with preventScroll; the item scrolls into view only as far as needed.
 *
 *   <div role="menu" {@attach roving({ items: '[role=menuitem]' })}>…</div>
 */
import type { Attachment } from 'svelte/attachments';

export interface RovingOptions {
  /** CSS selector of the items, inside the container. Disabled items (`:disabled`, aria-disabled) are skipped. */
  items: string;
  orientation?: 'vertical' | 'horizontal' | 'both';
  loop?: boolean;
  typeahead?: boolean;
  /** Called when an item becomes active (by key or pointer). */
  onactive?: (el: HTMLElement) => void;
  /** Moving the pointer over an item focuses it (menus). */
  focusOnHover?: boolean;
}

export function items(container: HTMLElement, selector: string): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(selector)].filter(
    (el) => !(el as HTMLButtonElement).disabled && el.getAttribute('aria-disabled') !== 'true' && el.offsetParent !== null,
  );
}

export function focusItem(el: HTMLElement | undefined, container: HTMLElement, selector: string, onactive?: (el: HTMLElement) => void) {
  if (!el) return;
  for (const x of container.querySelectorAll<HTMLElement>(selector)) x.tabIndex = x === el ? 0 : -1;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: 'nearest' });
  onactive?.(el);
}

export function roving(o: RovingOptions): Attachment<HTMLElement> {
  return (container) => {
    const orient = o.orientation ?? 'vertical';
    const loop = o.loop ?? true;
    let typed = '';
    let typedAt = 0;
    // One item in the Tab order: the focused, the checked/selected, or the first.
    const list0 = items(container, o.items);
    const start = list0.find((x) => x.getAttribute('aria-checked') === 'true' || x.getAttribute('aria-selected') === 'true') ?? list0[0];
    for (const x of container.querySelectorAll<HTMLElement>(o.items)) x.tabIndex = x === start ? 0 : -1;

    const key = (e: KeyboardEvent) => {
      if (e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const list = items(container, o.items);
      if (!list.length) return;
      const cur = list.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      const v = orient !== 'horizontal', h = orient !== 'vertical';
      if ((e.key === 'ArrowDown' && v) || (e.key === 'ArrowRight' && h)) next = cur + 1;
      else if ((e.key === 'ArrowUp' && v) || (e.key === 'ArrowLeft' && h)) next = cur < 0 ? list.length - 1 : cur - 1;
      else if (e.key === 'Home' || e.key === 'PageUp') next = 0;
      else if (e.key === 'End' || e.key === 'PageDown') next = list.length - 1;
      else if (o.typeahead && e.key.length === 1 && e.key !== ' ') {
        const now = Date.now();
        typed = (now - typedAt < 600 ? typed : '') + e.key.toLowerCase();
        typedAt = now;
        const from = Math.max(cur, 0);
        const order = [...list.slice(from + (typed.length === 1 ? 1 : 0)), ...list.slice(0, from + (typed.length === 1 ? 1 : 0))];
        const hit = order.find((x) => (x.dataset.label ?? x.textContent ?? '').trim().toLowerCase().startsWith(typed));
        if (hit) { e.preventDefault(); focusItem(hit, container, o.items, o.onactive); }
        return;
      } else return;
      e.preventDefault();
      next = loop ? (next + list.length) % list.length : Math.max(0, Math.min(list.length - 1, next));
      focusItem(list[next], container, o.items, o.onactive);
    };
    const hover = (e: PointerEvent) => {
      if (!o.focusOnHover || e.pointerType === 'touch') return;
      const el = (e.target as HTMLElement).closest<HTMLElement>(o.items);
      if (el && container.contains(el) && items(container, o.items).includes(el) && document.activeElement !== el) focusItem(el, container, o.items, o.onactive);
    };
    container.addEventListener('keydown', key);
    container.addEventListener('pointermove', hover);
    return () => {
      container.removeEventListener('keydown', key);
      container.removeEventListener('pointermove', hover);
    };
  };
}
