<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // What a zip holds (also a .jar, .epub, .pptx): its entries' names and sizes, read here without unpacking them.
  import { fetchBytes } from './fetchBytes';
  import { fileSize } from '../../../lib/format';
  let { url, size }: { url: string; size: number } = $props();
  let entries = $state<{ name: string; size: number }[] | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    const u = url;
    entries = null; error = null;
    (async () => {
      const [buf, { unzipSync }] = await Promise.all([fetchBytes(u, size), import('fflate')]);
      const out: { name: string; size: number }[] = [];
      unzipSync(new Uint8Array(buf), { filter: (f) => { out.push({ name: f.name, size: f.originalSize }); return false; } });
      if (u === url) entries = out.sort((a, b) => a.name.localeCompare(b.name));
    })().catch((e) => { if (u === url) error = /invalid zip|end of central/i.test(e?.message ?? '') ? 'This isn’t a zip it can read' : e?.message ?? String(e); });
  });
  const files = $derived((entries ?? []).filter((e) => !e.name.endsWith('/')));
</script>

{#if error}<p class="note">{error}</p>
{:else if !entries}<div class="loading"><span class="spinner"></span></div>
{:else}
  <div class="sum">{files.length.toLocaleString('en-US')} file{files.length === 1 ? '' : 's'} · {fileSize(files.reduce((n, e) => n + e.size, 0))} unpacked</div>
  <ul class="list">
    {#each entries.slice(0, 3000) as e (e.name)}
      <li class:dir={e.name.endsWith('/')}><span class="n">{e.name}</span>{#if !e.name.endsWith('/')}<span class="s">{fileSize(e.size)}</span>{/if}</li>
    {/each}
  </ul>
{/if}

<style>
  .sum { padding: var(--sp-2) var(--gutter); color: var(--muted); font-size: var(--fs-small); }
  .list { list-style: none; margin: 0; padding: 0 var(--gutter) var(--gutter); }
  li { display: flex; gap: var(--sp-3); align-items: baseline; padding: 3px 0; font: 12.5px/18px var(--mono); color: var(--ink2); }
  li.dir { color: var(--muted); }
  .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s { flex: none; color: var(--faint); }
  .note { padding: var(--sp-3) var(--gutter); color: var(--muted); font-size: var(--fs-quiet); }
  .loading { display: flex; justify-content: center; padding: var(--sp-10) 0; }
</style>
