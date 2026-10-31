<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A font file: loaded as a face of its own, and shown at a few sizes.
  let { url, name }: { url: string; name: string } = $props();
  let family = $state<string | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    const f = `cr-font-${Math.random().toString(36).slice(2)}`;
    const face = new FontFace(f, `url("${url}")`);
    family = null; error = null;
    face.load().then(() => { document.fonts.add(face); family = f; }).catch(() => (error = 'This font could not be read'));
    return () => { document.fonts.delete(face); };
  });
  const SIZES = [12, 16, 24, 36, 56];
</script>

<div class="font">
  {#if error}<p class="note">{error}</p>
  {:else if !family}<div class="loading"><span class="spinner"></span></div>
  {:else}
    <div class="name">{name}</div>
    <div class="set" style:font-family={family}>ABCDEFGHIJKLMNOPQRSTUVWXYZ<br />abcdefghijklmnopqrstuvwxyz<br />0123456789 !?&amp;@#%(){'{}'}[]</div>
    {#each SIZES as s (s)}<div class="line" style:font-family={family} style:font-size="{s}px"><span class="px">{s}</span>The quick brown fox jumps over the lazy dog</div>{/each}
  {/if}
</div>

<style>
  .font { padding: var(--sp-4) var(--gutter) var(--gutter); display: flex; flex-direction: column; gap: var(--sp-3); }
  .name { color: var(--muted); font-size: var(--fs-small); }
  .set { font-size: 22px; line-height: 1.4; color: var(--ink); word-break: break-all; }
  .line { color: var(--ink); line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .px { display: inline-block; width: 28px; margin-right: var(--sp-2); color: var(--faint); font: 11px var(--mono); vertical-align: middle; }
  .note { color: var(--muted); font-size: var(--fs-quiet); }
  .loading { display: flex; justify-content: center; padding: var(--sp-10) 0; }
</style>
