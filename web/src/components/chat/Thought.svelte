<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The agent's thinking (ACP `agent_thought_chunk`): one quiet line that opens to the words.
  import { slide } from 'svelte/transition';
  import { ease, ms } from '../../lib/motion';
  import Icon from '../Icon.svelte';
  import Markdown from '../Markdown.svelte';
  let { text, live = false }: { text: string; live?: boolean } = $props();
  let open = $state(false);
  const first = $derived(text.trim().split('\n')[0].replace(/[*_`#]/g, '').slice(0, 140));
</script>

<div class="th">
  <button class="line" onclick={() => (open = !open)} aria-expanded={open}>
    <span class="ic"><Icon name="sparkle" size={15} /></span>
    <span class="t cut" class:shimmer={live}>{open ? 'Thinking' : first || 'Thinking'}</span>
    <span class="chev" class:open><Icon name="chevr" size={11} /></span>
  </button>
  {#if open}<div class="body" transition:slide={{ duration: ms.base, easing: ease.base }}><Markdown {text} color="var(--ink2)" /></div>{/if}
</div>

<style>
  .line { display: flex; align-items: center; gap: var(--row-x); min-height: 28px; width: 100%; text-align: left; font-size: var(--fs-quiet); color: var(--muted); }
  .line:hover { color: var(--ink2); }
  .ic { width: 20px; display: inline-flex; justify-content: center; flex: none; }
  .t { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-style: italic; }
  .chev { display: inline-flex; transition: transform var(--t-base) var(--ease-base); flex: none; }
  .chev.open { transform: rotate(90deg); }
  .body { padding: var(--sp-1) 0 var(--sp-2) calc(20px + var(--row-x)); }
  .body :global(.md) { font-size: var(--fs-quiet); line-height: 22px; }
  .shimmer { color: transparent; -webkit-background-clip: text; background-clip: text; background-image: linear-gradient(90deg, var(--muted) 0%, var(--muted) 35%, var(--ink2) 50%, var(--muted) 65%, var(--muted) 100%); background-size: 300% 100%; animation: wave 2.4s linear infinite; }
  @keyframes wave { from { background-position: 100% 0; } to { background-position: 0% 0; } }
</style>
