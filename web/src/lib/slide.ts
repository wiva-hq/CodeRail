// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A row that opens to what is under it (a changed file's lines, a variable's form): its height over 200 ms on the
// base curve, closing over 120 ms (svelte/transition's slide on the approved curves).
import { slide } from 'svelte/transition';
import { ease, ms } from './motion';

export function slideOpen(node: Element, _p: unknown = {}, o?: { direction?: 'in' | 'out' | 'both' }) {
  const out = o?.direction === 'out';
  return slide(node, { duration: out ? ms.exit : ms.base, easing: out ? ease.exit : ease.base });
}
