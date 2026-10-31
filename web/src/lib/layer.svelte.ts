// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The one top layer (open-claude-ui docs/v1/06). Every sheet, dialog, menu and popover renders
 * into `#layer`, a container at the end of <body> (ui/Portal.svelte), in the order it opened, so the newest is on
 * top and nothing is clipped, transformed or covered by what opened it. The stack here knows which one is on top:
 * Esc closes that one only (a menu over a sheet closes the menu, not the sheet).
 */

import { untrack } from 'svelte';

export interface LayerEntry {
  id: number;
  /** Closes it (Esc, or a newer layer that replaces it). */
  close: () => void;
  /** 'popover' (menus, popovers) or 'modal' (sheets, dialogs, Settings). */
  kind: 'popover' | 'modal';
}

class Layer {
  stack = $state<LayerEntry[]>([]);
  private next = 1;
  private installed = false;

  /** Puts a layer on top; returns the function that takes it off again. */
  push(kind: LayerEntry['kind'], close: () => void): () => void {
    this.install();
    const id = this.next++;
    // (Read without tracking: a layer is pushed from an $effect, and that effect must not re-run — and re-push itself
    // over every other layer — each time the stack changes. Two open layers did that to each other until Svelte gave up.)
    untrack(() => { this.stack = [...this.stack, { id, close, kind }]; });
    return () => untrack(() => { this.stack = this.stack.filter((e) => e.id !== id); });
  }
  top(): LayerEntry | undefined { return this.stack.at(-1); }
  /** True while any menu or popover is open (tooltips wait). */
  get popoverOpen() { return this.stack.some((e) => e.kind === 'popover'); }

  private install() {
    if (this.installed || typeof window === 'undefined') return;
    this.installed = true;
    // Capture: before any other window listener, so one Esc closes one layer.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      const t = this.top();
      if (!t) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      t.close();
    }, true);
    // The window resizing closes menus and popovers (they are anchored to where things were).
    window.addEventListener('resize', () => { for (const e of this.stack) if (e.kind === 'popover') e.close(); });
  }
}

export const layer = new Layer();

/** The `#layer` container (made on first use). */
export function layerRoot(): HTMLElement {
  let r = document.getElementById('layer');
  if (!r) {
    r = document.createElement('div');
    r.id = 'layer';
    document.body.appendChild(r);
  }
  return r;
}
