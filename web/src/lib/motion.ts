// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Motion: Svelte transitions on the approved curves (theme.css `--ease-*`), with exits (open-claude-ui
 * ClaudeMotionPresets.ts `motionPopover` / `motionModalDialog` / `motionMessageFadeUp`, ported as plain CSS
 * transitions). Each takes `{ direction }` from Svelte, so one `transition:x|global` opens and closes:
 *   pop    menus, popovers: 200 ms on the pop curve from scale .96 and 4px; out 120 ms
 *   rise   sheets, asks, new rows: 300 ms on the base curve from 10px below; out 150 ms
 *   sheetUp  the phone's sheets from the bottom edge: 300 ms base; out 220 ms
 *   fade   scrims: 200 ms base; out 150 ms
 *   toast  toasts: 200 ms base from 12px and .96; out 150 ms upward
 * Portaled content (ui/Portal.svelte) uses `|global`, so its exit plays when the portal unmounts.
 */
import type { TransitionConfig } from 'svelte/transition';

/** A CSS cubic-bezier as an easing function (Newton–Raphson on x, then y). */
export function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const x = (t: number) => ((ax * t + bx) * t + cx) * t;
  const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  const y = (t: number) => ((ay * t + by) * t + cy) * t;
  return (p: number) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 8; i++) {
      const e = x(t) - p;
      if (Math.abs(e) < 1e-5) break;
      const d = dx(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    return y(Math.min(1, Math.max(0, t)));
  };
}

export const ease = {
  snap: bezier(0.32, 0.72, 0, 1),
  base: bezier(0.165, 0.84, 0.44, 1),
  pop: bezier(0.34, 1.3, 0.64, 1),
  exit: bezier(0.4, 0, 1, 1),
};
export const ms = { fast: 60, quick: 120, base: 200, sheet: 300, exit: 120 };

/** Reduce Motion: the system's, or Settings › General's. */
export const reduced = () => (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) || (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced');
type Dir = { direction?: 'in' | 'out' | 'both' };
const isOut = (o?: Dir) => o?.direction === 'out';

/** Menus and popovers. `y` is the side it comes from (-4 when it opens below its trigger, 4 above). */
export function pop(_node: Element, p: { y?: number } = {}, o?: Dir): TransitionConfig {
  const y = p.y ?? -4;
  if (reduced()) return { duration: 0 };
  if (isOut(o)) return { duration: ms.exit, easing: ease.exit, css: (t) => `opacity:${t};transform:scale(${0.98 + 0.02 * t})` };
  return { duration: ms.base, easing: ease.pop, css: (t, u) => `opacity:${Math.min(1, t * 1.6)};transform:translateY(${u * y}px) scale(${0.96 + 0.04 * t})` };
}

/** Sheets, asks, rows that arrive. */
export function rise(_node: Element, p: { y?: number; duration?: number } = {}, o?: Dir): TransitionConfig {
  const y = p.y ?? 10;
  if (reduced()) return { duration: 0 };
  if (isOut(o)) return { duration: 150, easing: ease.exit, css: (t, u) => `opacity:${t};transform:translateY(${u * y * 0.6}px)` };
  return { duration: p.duration ?? ms.sheet, easing: ease.base, css: (t, u) => `opacity:${t};transform:translateY(${u * y}px)` };
}

/** The phone's sheets, from the bottom edge. */
export function sheetUp(_node: Element, _p: unknown = {}, o?: Dir): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return { duration: isOut(o) ? 220 : ms.sheet, easing: isOut(o) ? ease.exit : ease.base, css: (_t, u) => `transform:translateY(${u * 100}%)` };
}

/** Scrims. */
export function fade(_node: Element, _p: unknown = {}, o?: Dir): TransitionConfig {
  if (reduced()) return { duration: 0 };
  return { duration: isOut(o) ? 150 : ms.base, easing: isOut(o) ? ease.exit : ease.base, css: (t) => `opacity:${t}` };
}

/** Toasts. */
export function toast(_node: Element, _p: unknown = {}, o?: Dir): TransitionConfig {
  if (reduced()) return { duration: 0 };
  if (isOut(o)) return { duration: 150, easing: ease.exit, css: (t, u) => `opacity:${t};transform:translateY(${-4 * u}px)` };
  return { duration: ms.base, easing: ease.base, css: (t, u) => `opacity:${t};transform:translateY(${12 * u}px) scale(${0.96 + 0.04 * t})` };
}
