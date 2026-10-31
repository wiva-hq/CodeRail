<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A path cut at its start when it does not fit, so the file's own name stays ("…billing/invoice.ts"), with its
  // characters in order (".env" stays ".env"): an right-to-left box around a left-to-right isolate. The whole path is
  // the tooltip. `split` sets the folder part quieter than the name.
  import { tip } from '../lib/tip';
  let { path, split = false }: { path: string; split?: boolean } = $props();
  let cut = $derived(path.lastIndexOf('/'));
</script>

<span class="pl cut-start" {@attach tip(path)}><span class="in" dir="ltr">{#if split && cut >= 0}<span class="dir">{path.slice(0, cut + 1)}</span>{path.slice(cut + 1)}{:else}{path}{/if}</span></span>

<style>
  .pl { font-family: var(--mono); display: block; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; }
  .in { unicode-bidi: isolate; }
  .dir { color: var(--muted); }
</style>
