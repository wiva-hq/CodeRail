<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Two or more tool calls in a row, as the Claude app shows them: one line saying what they did ("Ran 2 commands",
  // "Read 3 files, ran a command") with a caret, opening to a bordered box with a row per call (ToolCall, boxed).
  // While one runs, the line says what it's doing now.
  import { slide } from 'svelte/transition';
  import type { Item } from '../../lib/transcript';
  import { inline } from '../../lib/markdown';
  import { ease, ms } from '../../lib/motion';
  import ToolCall from './ToolCall.svelte';
  let { tools }: { tools: Extract<Item, { k: 'tool' }>[] } = $props();
  let open = $state(false);

  const VERBS: Record<string, [string, string, string]> = {
    execute: ['Ran', 'command', 'commands'],
    read: ['Read', 'file', 'files'],
    edit: ['Edited', 'file', 'files'],
    delete: ['Deleted', 'file', 'files'],
    move: ['Moved', 'file', 'files'],
    search: ['Searched', 'time', 'times'],
    fetch: ['Fetched', 'page', 'pages'],
    think: ['Thought', 'time', 'times'],
  };
  const summary = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const t of tools) {
      const k = VERBS[t.kind] ? t.kind : 'other';
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const parts = [...counts].map(([k, n]) => {
      if (k === 'other') return `used ${n === 1 ? 'a tool' : `${n} tools`}`;
      const [verb, one, many] = VERBS[k];
      return `${verb.toLowerCase()} ${n === 1 ? (one === 'time' ? 'once' : `a ${one}`) : `${n} ${many}`}`;
    });
    const s = parts.join(', ');
    return s.charAt(0).toUpperCase() + s.slice(1);
  });
  const live = $derived([...tools].reverse().find((t) => t.status === 'pending' || t.status === 'in_progress'));
  const failed = $derived(tools.filter((t) => t.status === 'failed').length);
  const accordion = (node: Element) => slide(node, { duration: ms.base, easing: ease.base });
</script>

<div class="group">
  <button class="head" onclick={() => (open = !open)} aria-expanded={open}>
    {#if live}<span class="spinner"></span><span class="cut">{@html inline(live.title)}</span>
    {:else}<span>{summary}</span>{#if failed}<span class="bad">· {failed} failed</span>{/if}{/if}
    <span class="caret" class:down={open}></span>
  </button>
  {#if open}
    <div class="box" transition:accordion>
      {#each tools as t (t.key)}<ToolCall {t} boxed />{/each}
    </div>
  {/if}
</div>

<style>
  .head { display: inline-flex; align-items: center; gap: var(--sp-1h); max-width: 100%; min-height: 28px; text-align: left; font-size: var(--fs-quiet); line-height: 20px; color: var(--ink2); }
  .head:hover { color: var(--ink); }
  .head .cut { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .head :global(code) { font-family: var(--mono); font-size: 12.5px; }
  .bad { color: var(--danger-ink); }
  .caret { flex: none; width: 0; height: 0; margin-left: 2px; border-style: solid; border-width: 4px 0 4px 6px; border-color: transparent transparent transparent currentColor; opacity: 0.7; transition: transform var(--t-base) var(--ease-base); }
  .caret.down { transform: rotate(90deg); }
  .box { margin-top: var(--sp-1h); border-radius: var(--r-xl); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); overflow: hidden; }
  .box > :global(.tool + .tool) { box-shadow: inset 0 var(--hairline) 0 var(--hair); }
</style>
