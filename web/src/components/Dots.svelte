<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // An agent thinking or at work (the Claude app's status mark): four dots in a square, lit one after another round
  // it; still under reduced motion.
</script>

<span class="dots" aria-hidden="true"><i></i><i></i><i></i><i></i></span>

<style>
  .dots { width: 14px; height: 14px; display: inline-grid; grid-template-columns: 1fr 1fr; place-items: center; flex: none; color: var(--accent); }
  i { width: 34%; aspect-ratio: 1; border-radius: 50%; background: currentColor; opacity: 0.3; animation: lit 1.2s linear infinite; }
  /* (Round the square: top left, top right, bottom right, bottom left.) */
  i:nth-child(2) { animation-delay: 0.3s; }
  i:nth-child(4) { animation-delay: 0.6s; }
  i:nth-child(3) { animation-delay: 0.9s; }
  @keyframes lit { 0%, 20% { opacity: 1; } 45%, 100% { opacity: 0.3; } }
  @media (prefers-reduced-motion: reduce) { i { animation: none; opacity: 0.9; } }
  :global(:root[data-motion='reduced']) i { animation: none; opacity: 0.9; }
</style>
