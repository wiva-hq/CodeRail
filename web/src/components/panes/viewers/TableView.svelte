<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Rows as a sheet draws them (a CSV, a TSV, a spreadsheet's sheet): the first row as a header that stays on top,
  // row numbers down the side, the first SHOWN rows of a long table and how many there are.
  let { rows, total = rows.length }: { rows: string[][]; total?: number } = $props();
  const SHOWN = 2000;
  const width = $derived(Math.min(200, rows.reduce((n, r) => Math.max(n, r.length), 0)));
  const head = $derived(rows[0] ?? []);
  const body = $derived(rows.slice(1, SHOWN + 1));
</script>

<div class="wrap">
  {#if total > SHOWN + 1}<div class="more">The first {SHOWN.toLocaleString('en-US')} of {(total - 1).toLocaleString('en-US')} rows</div>{/if}
  <table>
    <thead><tr><th class="n"></th>{#each { length: width } as _, c (c)}<th>{head[c] ?? ''}</th>{/each}</tr></thead>
    <tbody>
      {#each body as r, i (i)}
        <tr><td class="n">{i + 1}</td>{#each { length: width } as _, c (c)}<td>{r[c] ?? ''}</td>{/each}</tr>
      {/each}
    </tbody>
  </table>
</div>

<style>
  .wrap { padding: 0 0 var(--gutter); }
  .more { padding: var(--sp-1h) var(--gutter); color: var(--muted); font-size: var(--fs-small); }
  table { border-collapse: separate; border-spacing: 0; font-size: var(--fs-small); min-width: 100%; }
  th, td { padding: 5px 10px; text-align: left; white-space: nowrap; max-width: 360px; overflow: hidden; text-overflow: ellipsis; box-shadow: inset calc(-1 * var(--hairline)) calc(-1 * var(--hairline)) 0 var(--hair); }
  th { position: sticky; top: 0; z-index: 1; background: var(--panel); color: var(--ink); font-weight: var(--w-control); }
  td { color: var(--ink2); }
  .n { position: sticky; left: 0; background: var(--panel); color: var(--faint); text-align: right; font-family: var(--mono); font-size: 11.5px; min-width: 36px; }
  th.n { z-index: 2; }
  tbody tr:hover td { background: var(--hover); }
  tbody tr:hover td.n { background: var(--panel); }
</style>
