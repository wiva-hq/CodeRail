<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // One tool call of an agent's turn (ACP `tool_call`, its updates merged), as the Claude app shows it: its title in
  // the muted ink with a caret (a spinner while it runs, a warning when it failed), +/− for edits; it opens to what it
  // carries: the command it ran in a box of its own and its output under it, the edits as diffs (DiffView), the
  // terminal it used. `boxed`: a row of a ToolGroup's box.
  import { slide } from 'svelte/transition';
  import type { Item } from '../../lib/transcript';
  import { textOf } from '../../lib/transcript';
  import { textDiff, extOf } from '../../lib/diffs';
  import { inline } from '../../lib/markdown';
  import { ease, ms } from '../../lib/motion';
  import { tip } from '../../lib/tip';
  import Icon from '../Icon.svelte';
  import DiffView from '../DiffView.svelte';
  import PathLabel from '../PathLabel.svelte';
  let { t, open: startOpen = false, boxed = false }: { t: Extract<Item, { k: 'tool' }>; open?: boolean; boxed?: boolean } = $props();
  // svelte-ignore state_referenced_locally
  let open = $state(startOpen);
  const running = $derived(t.status === 'pending' || t.status === 'in_progress');
  const failed = $derived(t.status === 'failed');
  const diffs = $derived(t.content.filter((c) => c?.type === 'diff').map((c) => textDiff(c.oldText, c.newText ?? '', c.path ?? 'file')));
  const texts = $derived(t.content.filter((c) => c?.type === 'content').map((c) => textOf(c.content)).filter(Boolean));
  const terms = $derived(t.content.filter((c) => c?.type === 'terminal').map((c) => String(c.terminalId)));
  const command = $derived(t.kind === 'execute' ? (Array.isArray(t.rawInput?.command) ? t.rawInput.command.join(' ') : t.rawInput?.command ?? '') : '');
  const added = $derived(diffs.reduce((n, d) => n + d.added, 0));
  const removed = $derived(diffs.reduce((n, d) => n + d.removed, 0));
  const out = $derived(texts.join('\n') || (typeof t.rawOutput === 'string' ? t.rawOutput : t.rawOutput?.output ?? t.rawOutput?.stdout ?? ''));
  const hasBody = $derived(!!(diffs.length || out || command || terms.length || t.locations.length));
  const accordion = (node: Element) => slide(node, { duration: ms.base, easing: ease.base });
</script>

<div class="tool" class:open class:boxed>
  <button class="line" class:running onclick={() => (open = !open)} disabled={!hasBody} aria-expanded={hasBody ? open : undefined}>
    {#if running}<span class="ic"><span class="spinner"></span></span>{:else if failed}<span class="ic bad"><Icon name="warning" size={14} /></span>{/if}
    <span class="ti cut">{@html inline(t.title)}</span>
    {#if added}<span class="n add">+{added}</span>{/if}{#if removed}<span class="n del">−{removed}</span>{/if}
    {#if failed}<span class="n">failed</span>{/if}
    {#if hasBody}<span class="caret"></span>{/if}
  </button>
  {#if open && hasBody}
    <div class="body" transition:accordion>
      {#if command}<div class="cmd selectable"><span class="pr">$</span>{command}</div>{/if}
      {#each diffs as d, i (i)}
        <div class="diff">
          <div class="dh"><PathLabel path={d.path} split /><span class="sp"></span><span class="n add">+{d.added}</span><span class="n del">−{d.removed}</span></div>
          <DiffView lines={d.lines} lang={extOf(d.path)} />
        </div>
      {/each}
      {#if out}<pre class="out selectable">{out.length > 20000 ? out.slice(0, 20000) + '\n…' : out}</pre>{/if}
      {#each terms as id (id)}<div class="term" {@attach tip('The agent ran this in a terminal of its own')}><Icon name="terminal" size={14} />Terminal {id.slice(0, 8)}</div>{/each}
      {#if !diffs.length && t.locations.length}
        <div class="locs">{#each t.locations as l, i (i)}<span class="loc mono">{l.path}{l.line ? `:${l.line}` : ''}</span>{/each}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .line { display: inline-flex; align-items: center; gap: var(--sp-1h); min-height: 28px; max-width: 100%; text-align: left; font-size: var(--fs-quiet); line-height: 20px; color: var(--ink2); border-radius: var(--r-sm); }
  .boxed .line { display: flex; width: 100%; max-width: none; min-height: 44px; padding: 0 var(--sp-4); }
  .boxed .line:not(:disabled):hover { background: var(--hover); }
  .line:disabled { color: var(--ink2); }
  .line.running { color: var(--ink); }
  .line:not(:disabled):hover { color: var(--ink); }
  .ic { display: inline-flex; justify-content: center; color: var(--muted); flex: none; }
  .bad { color: var(--danger-ink); display: inline-flex; }
  .ti { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ti :global(code) { font-family: var(--mono); font-size: 12.5px; }
  .n { font-size: var(--fs-meta); color: var(--muted); font-variant-numeric: tabular-nums; flex: none; }
  .n.add { color: var(--diff-added-ink); }
  .n.del { color: var(--diff-removed-ink); }
  .caret { flex: none; width: 0; height: 0; margin-left: 2px; border-style: solid; border-width: 4px 0 4px 6px; border-color: transparent transparent transparent currentColor; opacity: 0.7; transition: transform var(--t-base) var(--ease-base); }
  .open .caret { transform: rotate(90deg); }
  .body { padding: var(--sp-1) 0 var(--sp-2); display: flex; flex-direction: column; gap: var(--sp-2); }
  .boxed .body { padding: 0 var(--sp-4) var(--sp-3); }
  .cmd { white-space: pre-wrap; word-break: break-all; font: 13px/20px var(--mono); color: var(--ink); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-lg); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); }
  .pr { color: var(--muted); margin-right: var(--sp-2); }
  .diff { border-radius: var(--r-md); background: var(--tint); overflow: hidden; box-shadow: inset 0 0 0 var(--hairline) var(--hair); }
  .dh { display: flex; align-items: center; gap: var(--sp-2); height: 30px; padding: 0 var(--sp-3); font-size: var(--fs-small); box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair); }
  .dh :global(.pl) { min-width: 0; flex: 0 1 auto; }
  .sp { flex: 1; }
  .out { margin: 0; max-height: 320px; overflow: auto; font: 12.5px/19px var(--mono); padding: 0 var(--sp-3); white-space: pre-wrap; word-break: break-word; color: var(--ink2); }
  .term { display: inline-flex; align-items: center; gap: var(--sp-1h); color: var(--muted); font-size: var(--fs-small); }
  .locs { display: flex; flex-wrap: wrap; gap: var(--sp-1h); }
  .loc { font-size: 12px; color: var(--ink2); background: var(--tint); border-radius: var(--r-xs); padding: 1px var(--sp-1h); }
</style>
