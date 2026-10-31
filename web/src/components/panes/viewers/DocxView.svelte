<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A Word document (.docx), turned into a page here (mammoth, loaded only when one is opened) and shown in a frame
  // that runs nothing and reaches nothing of the app's.
  import { fetchBytes } from './fetchBytes';
  let { url, size }: { url: string; size: number } = $props();
  let html = $state<string | null>(null);
  let error = $state<string | null>(null);
  $effect(() => {
    const u = url;
    html = null; error = null;
    (async () => {
      const [buf, mammoth] = await Promise.all([fetchBytes(u, size), import('mammoth/mammoth.browser.js')]);
      const r = await mammoth.convertToHtml({ arrayBuffer: buf });
      if (u === url) html = r.value;
    })().catch((e) => { if (u === url) error = e?.message ?? String(e); });
  });
  // (Drawn in the app's light or dark, as data-scheme says it is now.)
  const dark = document.documentElement.dataset.scheme === 'dark';
  const doc = $derived(html == null ? '' : `<!doctype html><meta charset="utf-8"><style>
    body{margin:0;padding:24px 28px 40px;font:15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:${dark ? '#e4e4e7' : '#18181b'};background:${dark ? '#111113' : '#fff'};word-wrap:break-word}
    img{max-width:100%;height:auto} table{border-collapse:collapse} td,th{border:1px solid ${dark ? '#3f3f46' : '#d4d4d8'};padding:4px 8px;vertical-align:top}
    h1,h2,h3{line-height:1.25} a{color:inherit}
  </style>${html}`);
</script>

{#if error}<p class="note">{error}</p>
{:else if html == null}<div class="loading"><span class="spinner"></span></div>
{:else}<iframe class="frame" title="Document" sandbox="" srcdoc={doc}></iframe>{/if}

<style>
  .frame { display: block; width: 100%; height: 100%; border: 0; background: var(--panel); }
  .note { padding: var(--sp-3) var(--gutter); color: var(--muted); font-size: var(--fs-quiet); }
  .loading { display: flex; justify-content: center; padding: var(--sp-10) 0; }
</style>
