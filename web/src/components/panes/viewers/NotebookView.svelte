<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A Jupyter notebook (.ipynb): its cells in order. Markdown as Markdown, code in its language's colours with its
  // run number, and what each run printed: text, pictures, an error's traceback. An output's HTML is shown as its
  // plain text (it could run script), or as a picture when it has one.
  import { highlight } from '../../../lib/markdown';
  import Markdown from '../../Markdown.svelte';
  let { text, ready = 0 }: { text: string; ready?: number } = $props();
  type Cell = { cell_type: string; source: string | string[]; execution_count?: number | null; outputs?: any[] };
  const nb = $derived.by(() => {
    try {
      const j = JSON.parse(text);
      const lang = j?.metadata?.kernelspec?.language ?? j?.metadata?.language_info?.name ?? 'python';
      return { cells: (Array.isArray(j?.cells) ? j.cells : []) as Cell[], lang: String(lang) };
    } catch {
      return null;
    }
  });
  const src = (s: string | string[] | undefined) => (Array.isArray(s) ? s.join('') : s ?? '');
  // (Terminal colours in a traceback: dropped.)
  const plain = (s: string | string[] | undefined) => src(s).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  function picture(data: Record<string, any>): string | null {
    for (const t of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) if (data?.[t]) return `data:${t};base64,${src(data[t]).replace(/\s/g, '')}`;
    if (data?.['image/svg+xml']) return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(src(data['image/svg+xml']))}`;
    return null;
  }
</script>

{#if !nb}<p class="note">This notebook isn’t valid JSON.</p>
{:else if !nb.cells.length}<p class="note">An empty notebook.</p>
{:else}
  <div class="nb">
    {#each nb.cells as c, i (i)}
      {#if c.cell_type === 'markdown'}
        <div class="md"><Markdown text={src(c.source)} /></div>
      {:else if c.cell_type === 'code'}
        <div class="cell">
          <span class="in">[{c.execution_count ?? ' '}]</span>
          <div class="code">{#key ready}{@html highlight(src(c.source), nb.lang)}{/key}</div>
        </div>
        {#each c.outputs ?? [] as o, k (k)}
          {@const pic = o.data ? picture(o.data) : null}
          <div class="out">
            {#if o.output_type === 'stream'}<pre class:err={o.name === 'stderr'}>{plain(o.text)}</pre>
            {:else if o.output_type === 'error'}<pre class="err">{o.ename}: {o.evalue}{'\n'}{plain(o.traceback?.join('\n'))}</pre>
            {:else if pic}<img src={pic} alt="Output {k + 1}" />
            {:else if o.data?.['text/markdown']}<Markdown text={src(o.data['text/markdown'])} />
            {:else if o.data?.['text/plain']}<pre>{plain(o.data['text/plain'])}</pre>{/if}
          </div>
        {/each}
      {:else}
        <pre class="raw">{src(c.source)}</pre>
      {/if}
    {/each}
  </div>
{/if}

<style>
  .nb { padding: var(--sp-3) var(--gutter) var(--gutter); display: flex; flex-direction: column; gap: var(--sp-2); }
  .cell { display: flex; gap: var(--sp-2); align-items: flex-start; }
  .in { flex: none; width: 36px; text-align: right; padding-top: 8px; color: var(--faint); font: 11.5px var(--mono); }
  .code { flex: 1; min-width: 0; border-radius: var(--r-md); background: var(--tint); box-shadow: inset 0 0 0 var(--hairline) var(--hair); overflow-x: auto; }
  .code :global(pre) { margin: 0; padding: var(--sp-2) var(--sp-3); font: 12.5px/19px var(--mono); background: transparent !important; }
  .out { margin-left: calc(36px + var(--sp-2)); overflow-x: auto; }
  .out pre, .raw { margin: 0; padding: var(--sp-1) 0; font: 12px/18px var(--mono); color: var(--ink2); white-space: pre-wrap; word-break: break-word; }
  .out pre.err { color: var(--diff-removed-ink, #c0392b); }
  .out img { max-width: 100%; background: #fff; border-radius: var(--r-sm); }
  .note { padding: var(--sp-3) var(--gutter); color: var(--muted); font-size: var(--fs-quiet); }
</style>
