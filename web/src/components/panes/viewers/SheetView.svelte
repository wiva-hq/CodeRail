<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A spreadsheet (.xlsx, .xls, .ods): read here (SheetJS, loaded only when one is opened), its sheets as tabs, each
  // as a table of the values as the sheet formats them.
  import { fetchBytes } from './fetchBytes';
  import TableView from './TableView.svelte';
  import SegmentedControl from '../../ui/SegmentedControl.svelte';
  let { url, size }: { url: string; size: number } = $props();
  let book = $state<{ names: string[]; read: (name: string) => string[][] } | null>(null);
  let sheet = $state('');
  let error = $state<string | null>(null);
  $effect(() => {
    const u = url;
    book = null; error = null;
    (async () => {
      const [buf, X] = await Promise.all([fetchBytes(u, size), import('xlsx')]);
      const wb = X.read(new Uint8Array(buf), { type: 'array', cellDates: true, dense: true });
      if (u !== url) return;
      book = {
        names: wb.SheetNames,
        read: (n) => X.utils.sheet_to_json<string[]>(wb.Sheets[n], { header: 1, raw: false, defval: '', blankrows: false }).slice(0, 5001).map((r) => r.map((c) => String(c ?? ''))),
      };
      sheet = wb.SheetNames[0] ?? '';
    })().catch((e) => { if (u === url) error = e?.message ?? String(e); });
  });
  const rows = $derived(book && sheet ? book.read(sheet) : []);
</script>

{#if error}<p class="note">{error}</p>
{:else if !book}<div class="loading"><span class="spinner"></span></div>
{:else}
  {#if book.names.length > 1}
    <div class="tabs"><SegmentedControl size="sm" label="Sheet" value={sheet} onchange={(v) => (sheet = v)} options={book.names.slice(0, 12).map((n) => ({ id: n, label: n }))} /></div>
  {/if}
  {#if rows.length}<TableView {rows} />{:else}<p class="note">This sheet is empty.</p>{/if}
{/if}

<style>
  .tabs { padding: var(--sp-2) var(--gutter); overflow-x: auto; }
  .note { padding: var(--sp-3) var(--gutter); color: var(--muted); font-size: var(--fs-quiet); }
  .loading { display: flex; justify-content: center; padding: var(--sp-10) 0; }
</style>
