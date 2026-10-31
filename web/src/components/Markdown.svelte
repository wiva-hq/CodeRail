<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A message's Markdown (lib/markdown.ts): one delegated click copies a code block (its Copy shows a check and
  // "Copied" for 1.4 s), and opens a web link in the chat's Browser card (⌘ or Ctrl-click: a new tab, as usual).
  import { onMount } from 'svelte';
  import { render, onHighlighterReady } from '../lib/markdown';
  import { ICONS } from '../lib/art.gen';
  import { copyText } from '../lib/app.svelte';
  import { openLink } from '../lib/links';
  let { text, reply = false, hug = false, color }: { text: string; reply?: boolean; hug?: boolean; color?: string } = $props();
  let ready = $state(0);
  onMount(() => onHighlighterReady(() => ready++));
  let html = $derived(ready >= 0 ? render(text) : '');
  const CHECK = `<svg class="i" width="14" height="14" viewBox="0 0 24 24" stroke-width="1.8" aria-hidden="true">${ICONS.check ?? ''}</svg>`;

  const open = openLink();
  function click(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest('a[href]') as HTMLAnchorElement | null;
    if (a && open && /^https?:/.test(a.href) && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && e.button === 0) {
      if (open(a.href)) e.preventDefault();
      return;
    }
    const b = (e.target as HTMLElement).closest('[data-copy]') as HTMLButtonElement | null;
    if (!b) return;
    const code = b.closest('.codeblock')?.querySelector('pre')?.textContent ?? '';
    copyText(code.replace(/\n$/, '')).then((ok) => {
      if (!ok) return;
      const was = b.innerHTML;
      if (b.classList.contains('done')) return;
      b.classList.add('done');
      b.innerHTML = `${CHECK}<span class="cb-l">Copied</span>`;
      setTimeout(() => { b.classList.remove('done'); b.innerHTML = was; }, 1400);
    });
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="md" class:reply class:hug style={color ? `color:${color}` : ''} onclick={click}>{@html html}</div>
