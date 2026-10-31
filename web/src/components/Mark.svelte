<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // CodeRail's mark: two rails sweeping into a C and closing on a green dot (design/brand). The rails take the
  // colour it is set in, the dot the accent; below 32 px the heavier small cut.
  import mark from '../assets/mark.svg?raw';
  import markSmall from '../assets/mark-small.svg?raw';
  let { size = 28 }: { size?: number } = $props();
</script>

<span class="mark" style:width="{size}px" style:height="{size}px">{@html size < 32 ? markSmall : mark}</span>

<style>
  .mark { display: inline-flex; flex: none; color: var(--primary); }
  .mark :global(svg) { width: 100%; height: 100%; }
  .mark :global(.dot) { fill: var(--accent); }
</style>
