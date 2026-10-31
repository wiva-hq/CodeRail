<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A group of OptionRows (role radiogroup): ↑ ↓ move between rows and choose the one reached; one Tab stop.
  import type { Snippet } from 'svelte';
  import { roving } from '../../lib/roving';
  let { label, gap = 8, children }: { label?: string; gap?: number; children: Snippet } = $props();
  function chooseOnFocus(e: FocusEvent) {
    const el = e.target as HTMLElement;
    if (el.matches('[role=radio]:focus-visible') && el.getAttribute('aria-checked') !== 'true') el.click();
  }
</script>

<div class="group" role="radiogroup" aria-label={label} style:gap="{gap}px" onfocusin={chooseOnFocus}
  {@attach roving({ items: '[role=radio]', orientation: 'vertical' })}>
  {@render children()}
</div>

<style>
  .group { display: flex; flex-direction: column; }
</style>
