<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // "Built by Wiva": a quiet pill with Wiva's mark (design/brand/wiva-mark.svg) in Wiva's cobalt, which turns a
  // quarter on hover. On the sign-in screen, the machines page and Settings.
  import mark from '../assets/wiva-mark.svg?raw';
</script>

<a class="wiva" href="https://wiva.io" target="_blank" rel="noopener">
  <span class="by">Built by</span>
  <span class="m">{@html mark}</span>
  <span class="name">Wiva</span>
</a>

<style>
  .wiva { --wiva: #2743d6; display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px 0 9px; border-radius: 999px; box-shadow: inset 0 0 0 var(--hairline) var(--hair2); color: var(--muted); font-size: 12px; line-height: 1; text-decoration: none; white-space: nowrap; transition: color 120ms, background 120ms; }
  :global(:root[data-scheme='dark']) .wiva { --wiva: #a6bfff; }
  .wiva:hover { color: var(--ink); background: var(--tint); }
  .m { display: inline-flex; width: 14px; height: 14px; color: var(--wiva); transition: transform 600ms cubic-bezier(.2, .8, .2, 1); }
  .m :global(svg) { width: 100%; height: 100%; }
  .wiva:hover .m { transform: rotate(90deg); }
  .name { color: var(--ink2); font-weight: 600; }
  @media (prefers-reduced-motion: reduce) { .m { transition: none; } .wiva:hover .m { transform: none; } }
</style>
