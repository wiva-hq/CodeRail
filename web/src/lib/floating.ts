// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Anchoring with @floating-ui/dom: a floating element (menu, popover, tooltip) kept beside its trigger in window
 * space, flipped to the other side when there is no room, shifted to stay 8px inside the window, its height capped
 * to the room left (it scrolls inside), following the trigger while it moves (autoUpdate).
 */
import { autoUpdate, computePosition, flip, offset, shift, size, type Placement, type VirtualElement } from '@floating-ui/dom';

/** What a floating element hangs from: an element, or a point (a right-click) or a rect in window coordinates. */
export type Anchor = Element | { x: number; y: number; width?: number; height?: number };

export function reference(a: Anchor): Element | VirtualElement {
  if (a instanceof Element) return a;
  const { x, y, width = 0, height = 0 } = a;
  return { getBoundingClientRect: () => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height, toJSON() { return this; } }) } as VirtualElement;
}

export interface FloatOptions {
  anchor: Anchor;
  placement?: Placement;
  /** Gap to the anchor (6 by default). */
  gap?: number;
  /** Highest it may grow before it scrolls (300 for menus). */
  maxHeight?: number;
  /** At least the anchor's width. */
  matchWidth?: boolean;
}

const ORIGIN: Record<string, string> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };
/** The transform-origin for a placement: the corner nearest the anchor. */
export function originOf(p: Placement): string {
  const [side, align] = p.split('-');
  const cross = side === 'top' || side === 'bottom'
    ? (align === 'start' ? 'left' : align === 'end' ? 'right' : 'center')
    : (align === 'start' ? 'top' : align === 'end' ? 'bottom' : 'center');
  return side === 'top' || side === 'bottom' ? `${cross} ${ORIGIN[side]}` : `${ORIGIN[side]} ${cross}`;
}

/** Positions `node` against the anchor until the returned function is called. */
export function float(node: HTMLElement, o: FloatOptions): () => void {
  const ref = reference(o.anchor);
  node.style.position = 'fixed';
  node.style.left = '0px';
  node.style.top = '0px';
  const update = () => {
    // (A trigger that hides, like a row's ⋯ once its menu closes, measures 0×0 at the corner: the floating element
    // keeps where it is rather than flying there while it fades out.)
    if (ref instanceof Element) {
      const r = ref.getBoundingClientRect();
      if (!ref.isConnected || (!r.width && !r.height)) return;
    }
    void computePosition(ref, node, {
      strategy: 'fixed',
      placement: o.placement ?? 'bottom-start',
      middleware: [
        offset(o.gap ?? 6),
        flip({ padding: 8, fallbackAxisSideDirection: 'none' }),
        shift({ padding: 8 }),
        size({
          padding: 8,
          apply({ availableHeight, rects }) {
            const cap = o.maxHeight ?? Infinity;
            node.style.maxHeight = `${Math.max(88, Math.min(cap, availableHeight))}px`;
            if (o.matchWidth) node.style.minWidth = `${rects.reference.width}px`;
          },
        }),
      ],
    }).then(({ x, y, placement }) => {
      node.style.left = `${Math.round(x)}px`;
      node.style.top = `${Math.round(y)}px`;
      node.style.transformOrigin = originOf(placement);
      node.dataset.placement = placement;
    });
  };
  // (A point anchor never moves: no observers.)
  if (ref instanceof Element) return autoUpdate(ref, node, update);
  update();
  return () => {};
}
