<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts" module>
  /** One line of a file's diff as the daemon draws it (`changes.diff`, `versions.diff`). */
  export interface DiffLine { kind: 'add' | 'del' | 'ctx' | 'gap' | string; text: string; old?: number; new?: number }
  /** A run of changed lines: what was there (`dels`), what is there now (`adds`), and where in the file now. */
  export interface Hunk { id: number; dels: DiffLine[]; adds: DiffLine[]; /** The line now where it starts (1-based). */ at: number }

  /** The hunks of a diff, in order. */
  export function hunksOf(lines: DiffLine[]): Hunk[] {
    const out: Hunk[] = [];
    let cur: Hunk | null = null;
    let lastNew = 0;
    for (const l of lines) {
      if (l.kind === 'add' || l.kind === 'del') {
        if (!cur) { cur = { id: out.length, dels: [], adds: [], at: lastNew + 1 }; out.push(cur); }
        (l.kind === 'add' ? cur.adds : cur.dels).push(l);
        if (l.kind === 'add' && cur.adds.length === 1 && l.new) cur.at = l.new;
      } else {
        cur = null;
        if (l.new) lastNew = l.new;
      }
    }
    return out;
  }

</script>

<script lang="ts">
  // A file's changed lines (open-claude-ui StreamingDiffViewer): the old and
  // new line numbers in tabular figures, a + / − column, tinted rows, the words that changed marked inside a changed
  // line, the language's colours (Shiki), matches of a search marked. Unified (one column) or Split (before | after).
  // Folded runs of unchanged lines open with "Show N lines" when the file now is at hand (`fill`). A run of changes
  // can be taken back on its own (`ondiscard`: "Discard this change", on hover).
  import { onMount } from 'svelte';
  import { diffWordsWithSpace } from 'diff';
  import { tokenLines, onHighlighterReady } from '../lib/markdown';
  import Icon from './Icon.svelte';
  import { tip } from '../lib/tip';

  let { lines, lang = '', mode = 'unified', wrap = false, query = '', fill, ondiscard, onhits, pick }: {
    lines: DiffLine[];
    lang?: string;
    mode?: 'unified' | 'split';
    wrap?: boolean;
    query?: string;
    /** The file's lines now (to open a fold); null when they can't be read. */
    fill?: () => Promise<string[] | null>;
    ondiscard?: (h: Hunk) => void;
    onhits?: (n: number) => void;
    /** Changed lines to pick, GitHub Desktop's way: a line's number takes it in or out, a drag over the numbers
     *  sets a run of them, the + / − column the whole change. */
    pick?: { has: (l: DiffLine) => boolean; set: (ls: DiffLine[], on: boolean) => void };
  } = $props();

  // ---- picking lines
  let drag = $state<{ on: boolean } | null>(null);
  const changed = (l: DiffLine | undefined) => !!l && (l.kind === 'add' || l.kind === 'del');
  function pickDown(e: PointerEvent, i: number) {
    if (!pick || !changed(lines[i]) || e.button !== 0) return;
    e.preventDefault();
    const on = !pick.has(lines[i]);
    drag = { on };
    pick.set([lines[i]], on);
    const up = () => { drag = null; window.removeEventListener('pointerup', up); };
    window.addEventListener('pointerup', up);
  }
  function pickOver(i: number) {
    if (drag && pick && changed(lines[i])) pick.set([lines[i]], drag.on);
  }
  function pickHunk(h: number) {
    if (!pick || h < 0) return;
    const ls = lines.filter((_, i) => hunkOf[i] === h);
    pick.set(ls, !ls.every((l) => pick.has(l)));
  }
  // (A drag over the numbers on a touch screen: the line under the finger, since touches don't enter others.)
  function pickMove(e: PointerEvent) {
    if (!drag || e.pointerType === 'mouse') return;
    const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-pick]') as HTMLElement | null;
    if (el) pickOver(Number(el.dataset.pick));
  }

  let ready = $state(0);
  onMount(() => onHighlighterReady(() => ready++));
  /** Folds opened: the gap's index → its lines. */
  let opened = $state<Record<number, DiffLine[]>>({});
  let hover = $state(-1);

  /** Each line's hunk (−1 outside one). */
  let hunkOf = $derived.by(() => {
    const out: number[] = [];
    let id = -1, inRun = false;
    for (const l of lines) {
      const ch = l.kind === 'add' || l.kind === 'del';
      if (ch && !inRun) id++;
      inRun = ch;
      out.push(ch ? id : -1);
    }
    return out;
  });
  let hunks = $derived(hunksOf(lines));

  /** The words that changed in a changed line: a del paired with the add at its place in the same run. */
  let marks = $derived.by(() => {
    const m = new Map<number, [number, number][]>();
    let i = 0;
    while (i < lines.length) {
      if (lines[i].kind !== 'del' && lines[i].kind !== 'add') { i++; continue; }
      const dels: number[] = [], adds: number[] = [];
      while (i < lines.length && (lines[i].kind === 'del' || lines[i].kind === 'add')) { (lines[i].kind === 'del' ? dels : adds).push(i); i++; }
      for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
        const a = lines[dels[k]].text, b = lines[adds[k]].text;
        if (a.length + b.length > 2000) continue;
        const parts = diffWordsWithSpace(a, b);
        const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + p.value.length, 0);
        // (Lines that share little are simply different lines: no marks.)
        if (same < Math.max(a.length, b.length) * 0.4) continue;
        const ra: [number, number][] = [], rb: [number, number][] = [];
        let pa = 0, pb = 0;
        for (const p of parts) {
          if (p.removed) { if (p.value.trim()) ra.push([pa, pa + p.value.length]); pa += p.value.length; }
          else if (p.added) { if (p.value.trim()) rb.push([pb, pb + p.value.length]); pb += p.value.length; }
          else { pa += p.value.length; pb += p.value.length; }
        }
        if (ra.length) m.set(dels[k], ra);
        if (rb.length) m.set(adds[k], rb);
      }
    }
    return m;
  });

  /** The language's colours for each line (each side tokenized as a whole). */
  let colors = $derived.by(() => {
    void ready;
    const m = new Map<number, { content: string; color?: string; fontStyle?: number }[]>();
    if (!lang || lines.length > 4000) return m;
    for (const side of ['old', 'new'] as const) {
      const idx = lines.map((l, i) => [l, i] as const).filter(([l]) => l.kind !== 'gap' && (side === 'old' ? l.kind !== 'add' : l.kind !== 'del')).map(([, i]) => i);
      const t = tokenLines(idx.map((i) => lines[i].text).join('\n'), lang);
      if (!t) return m;
      idx.forEach((i, k) => { if (!m.has(i) || side === 'new') m.set(i, t[k] ?? []); });
    }
    return m;
  });

  /** Where the search matches, per line. */
  let hits = $derived.by(() => {
    const m = new Map<number, [number, number][]>();
    const q = query.trim().toLowerCase();
    if (!q) return m;
    lines.forEach((l, i) => {
      const t = l.text.toLowerCase();
      let at = t.indexOf(q);
      const r: [number, number][] = [];
      while (at >= 0) { r.push([at, at + q.length]); at = t.indexOf(q, at + q.length); }
      if (r.length) m.set(i, r);
    });
    return m;
  });
  $effect(() => { onhits?.([...hits.values()].reduce((n, r) => n + r.length, 0)); });

  type Seg = { s: string; color?: string; italic?: boolean; w?: boolean; hit?: boolean };
  /** A line cut where its colours, marks or matches change. */
  function segs(i: number, text: string): Seg[] {
    const toks = colors.get(i);
    const w = marks.get(i) ?? [], h = hits.get(i) ?? [];
    const cuts = new Set<number>([0, text.length]);
    let pos = 0;
    const spans: { a: number; b: number; color?: string; italic?: boolean }[] = [];
    if (toks) for (const t of toks) { spans.push({ a: pos, b: pos + t.content.length, color: t.color, italic: !!((t.fontStyle ?? 0) & 1) }); pos += t.content.length; cuts.add(pos); }
    for (const [a, b] of [...w, ...h]) { cuts.add(a); cuts.add(b); }
    const pts = [...cuts].filter((x) => x >= 0 && x <= text.length).sort((a, b) => a - b);
    const out: Seg[] = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      if (a === b) continue;
      const sp = spans.find((x) => x.a <= a && b <= x.b);
      out.push({ s: text.slice(a, b), color: sp?.color, italic: sp?.italic, w: w.some(([x, y]) => x <= a && b <= y), hit: h.some(([x, y]) => x <= a && b <= y) });
    }
    return out.length ? out : [{ s: text }];
  }

  /** How many lines a fold holds (between the new-side numbers around it), when that can be known. */
  function foldSize(gi: number) {
    let prev: DiffLine | undefined, next: DiffLine | undefined;
    for (let k = gi - 1; k >= 0; k--) if (lines[k].new) { prev = lines[k]; break; }
    for (let k = gi + 1; k < lines.length; k++) if (lines[k].new) { next = lines[k]; break; }
    if (!prev?.new || !next?.new) return null;
    return { from: prev.new + 1, to: next.new - 1, shift: (prev.old ?? prev.new) - prev.new };
  }
  async function openFold(gi: number) {
    const f = foldSize(gi);
    if (!f || !fill) return;
    const now = await fill();
    if (!now) return;
    const extra: DiffLine[] = [];
    for (let n = f.from; n <= f.to; n++) extra.push({ kind: 'ctx', text: now[n - 1] ?? '', new: n, old: n + f.shift });
    opened = { ...opened, [gi]: extra };
  }

  /** Split rows: before | after; a run of changes pairs its old and new lines in order. */
  type Side = { l: DiffLine; i: number } | null;
  let rows = $derived.by(() => {
    const out: ({ t: 'pair'; a: Side; b: Side; h: number } | { t: 'gap'; i: number })[] = [];
    let k = 0;
    while (k < lines.length) {
      const l = lines[k];
      if (l.kind === 'gap') { out.push({ t: 'gap', i: k }); k++; continue; }
      if (l.kind === 'ctx') { out.push({ t: 'pair', a: { l, i: k }, b: { l, i: k }, h: -1 }); k++; continue; }
      const dels: Side[] = [], adds: Side[] = [];
      const h = hunkOf[k];
      while (k < lines.length && (lines[k].kind === 'del' || lines[k].kind === 'add')) { (lines[k].kind === 'del' ? dels : adds).push({ l: lines[k], i: k }); k++; }
      for (let j = 0; j < Math.max(dels.length, adds.length); j++) out.push({ t: 'pair', a: dels[j] ?? null, b: adds[j] ?? null, h });
    }
    return out;
  });
  const sign = (k: string) => (k === 'add' ? '+' : k === 'del' ? '−' : '');
</script>

{#snippet text(i: number, t: string)}{#each segs(i, t) as g, j (j)}<span class:w={g.w} class:hit={g.hit} style:color={g.color} style:font-style={g.italic ? 'italic' : undefined}>{g.s}</span>{/each}{/snippet}

{#snippet num(i: number, l: DiffLine, v: number | undefined)}
  {#if pick && changed(l)}
    <span class="n pk" data-pick={i} role="checkbox" aria-checked={pick.has(l)} aria-label="Line {v ?? ''}" tabindex="-1"
      onpointerdown={(e) => pickDown(e, i)} onpointerenter={() => pickOver(i)}>{v ?? ''}</span>
  {:else}<span class="n">{v ?? ''}</span>{/if}
{/snippet}

{#snippet sgn(i: number, l: DiffLine, h: number)}
  {#if pick && changed(l)}
    <span class="s pk" role="button" tabindex="-1" aria-label="Pick this change" onclick={() => pickHunk(h)} onkeydown={(e) => { if (e.key === 'Enter') pickHunk(h); }}>{sign(l.kind)}</span>
  {:else}<span class="s">{sign(l.kind)}</span>{/if}
{/snippet}

{#snippet fold(i: number)}
  {@const f = foldSize(i)}
  <div class="fold">
    {#if fill && f && f.to >= f.from}
      <button class="more" onclick={() => openFold(i)}><Icon name="updown" size={14} />Show {f.to - f.from + 1} unchanged line{f.to === f.from ? '' : 's'}</button>
    {:else}<span>Unchanged lines</span>{/if}
  </div>
{/snippet}

<div class="diff selectable" class:wrap class:split={mode === 'split'} class:picking={!!pick} class:dragging={!!drag} role="table" aria-label="Changed lines" onpointermove={pickMove}>
  {#if mode === 'unified'}
    <div class="grid">
      {#each lines as l, i (i)}
        {#if l.kind === 'gap'}
          {#if opened[i]}
            {#each opened[i] as x, j (j)}<div class="l ctx"><span class="n">{x.old ?? ''}</span><span class="n">{x.new ?? ''}</span><span class="s"></span><span class="t">{x.text}</span></div>{/each}
          {:else}{@render fold(i)}{/if}
        {:else}
          {@const h = hunkOf[i]}
          <div class="l {l.kind}" class:lit={h >= 0 && h === hover} class:on={pick && changed(l) && pick.has(l)} class:off={pick && changed(l) && !pick.has(l)} role="row" tabindex="-1" onmouseenter={() => (hover = h)}>
            {@render num(i, l, l.kind === 'add' ? undefined : l.old)}{@render num(i, l, l.kind === 'del' ? undefined : l.new)}{@render sgn(i, l, h)}<span class="t">{@render text(i, l.text)}</span>
            {#if ondiscard && h >= 0 && (i === 0 || hunkOf[i - 1] !== h)}
              <button class="undo" class:on={hover === h} {@attach tip('Discard change')} aria-label="Discard change" onclick={() => ondiscard(hunks[h])}><Icon name="restore" size={13} />Discard</button>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {:else}
    <div class="grid">
      {#each rows as r, k (k)}
        {#if r.t === 'gap'}
          {#if opened[r.i]}
            {#each opened[r.i] as x, j (j)}<div class="p"><div class="l ctx"><span class="n">{x.old ?? ''}</span><span class="t">{x.text}</span></div><div class="l ctx"><span class="n">{x.new ?? ''}</span><span class="t">{x.text}</span></div></div>{/each}
          {:else}{@render fold(r.i)}{/if}
        {:else}
          <div class="p" role="row" tabindex="-1" onmouseenter={() => (hover = r.h)}>
            {#if r.a}<div class="l {r.a.l.kind}" class:on={pick && changed(r.a.l) && pick.has(r.a.l)} class:off={pick && changed(r.a.l) && !pick.has(r.a.l)}>{@render num(r.a.i, r.a.l, r.a.l.old)}<span class="t">{@render text(r.a.i, r.a.l.text)}</span></div>{:else}<div class="l none"></div>{/if}
            {#if r.b}<div class="l {r.b.l.kind}" class:on={pick && changed(r.b.l) && pick.has(r.b.l)} class:off={pick && changed(r.b.l) && !pick.has(r.b.l)}>{@render num(r.b.i, r.b.l, r.b.l.new)}<span class="t">{@render text(r.b.i, r.b.l.text)}</span></div>{:else}<div class="l none"></div>{/if}
            {#if ondiscard && r.h >= 0 && (k === 0 || rows[k - 1].t !== 'pair' || (rows[k - 1] as { h: number }).h !== r.h)}
              <button class="undo" class:on={hover === r.h} {@attach tip('Discard change')} aria-label="Discard change" onclick={() => ondiscard(hunks[r.h])}><Icon name="restore" size={13} />Discard</button>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  {/if}
</div>

<style>
  .diff { font-family: var(--mono); font-size: 12.5px; line-height: 20px; overflow-x: auto; overscroll-behavior-x: contain; padding: var(--sp-1) 0; color: var(--ink); }
  .grid { min-width: 100%; width: max-content; }
  .wrap .grid, .split .grid { width: 100%; }
  .l { position: relative; display: grid; grid-template-columns: 40px 40px 18px 1fr; white-space: pre; min-height: 20px; }
  .wrap .l .t, .split .l .t { white-space: pre-wrap; word-break: break-all; }
  .n { text-align: right; padding-right: var(--sp-2); color: var(--faint); font-variant-numeric: tabular-nums; user-select: none; -webkit-user-select: none; }
  .s { text-align: center; user-select: none; -webkit-user-select: none; color: var(--faint); }
  .t { padding-right: var(--sp-4); }
  .l.add { background: var(--diff-added-bg); } .l.add .s { color: var(--diff-added-ink); }
  .l.del { background: var(--diff-removed-bg); } .l.del .s { color: var(--diff-removed-ink); }
  .l.add .w { background: color-mix(in srgb, var(--diff-added-ink) 22%, transparent); border-radius: 2px; }
  .l.del .w { background: color-mix(in srgb, var(--diff-removed-ink) 20%, transparent); border-radius: 2px; }
  .hit { background: var(--warn-soft); box-shadow: 0 0 0 1px var(--warn); border-radius: 2px; }
  .l.lit { box-shadow: inset 2px 0 0 var(--accent); }
  .split .p { position: relative; display: grid; grid-template-columns: 1fr 1fr; }
  .split .l { grid-template-columns: 40px 1fr; }
  .split .p > .l:first-child { box-shadow: inset calc(-1 * var(--hairline)) 0 0 var(--hair); }
  .l.none { background: var(--tint); }
  .fold { display: flex; align-items: center; height: var(--sp-7); padding-left: var(--sp-16); background: var(--tint); color: var(--muted); font-family: var(--sans); font-size: var(--fs-small); }
  .more { display: inline-flex; align-items: center; gap: var(--sp-1h); height: 24px; padding: 0 var(--sp-2); margin-left: calc(-1 * var(--sp-2)); border-radius: var(--r-sm); color: var(--ink2); transition: background var(--t-fast) ease-out; }
  .more:hover { background: var(--hover); color: var(--ink); }
  .undo { position: absolute; left: var(--sp-0h); top: calc(-1 * var(--sp-0h)); display: inline-flex; align-items: center; gap: var(--sp-1); height: 24px; padding: 0 var(--sp-2); border-radius: var(--r-sm);
    background: var(--pop); box-shadow: var(--shadow-pop); color: var(--ink2); font-family: var(--sans); font-size: var(--fs-meta); font-weight: var(--w-control);
    opacity: 0; pointer-events: none; transition: opacity var(--t-fast) ease-out; z-index: var(--z-raised); }
  .undo.on, .undo:focus-visible { opacity: 1; pointer-events: auto; }
  .undo:hover { color: var(--ink); }
  .diff:not(:hover) .undo:not(:focus-visible) { opacity: 0; pointer-events: none; }
  /* (Picking lines: a picked line's numbers in the accent, a line left out greyed, its tint gone.) */
  .pk { cursor: pointer; touch-action: none; }
  .picking .l.on .n.pk { background: var(--accent-soft); color: var(--accent); font-weight: var(--w-control); }
  .picking .l.on .n.pk:first-child { box-shadow: inset 2px 0 0 var(--accent); }
  .picking .l.off { background: transparent; }
  .picking .l.off .t, .picking .l.off .s { opacity: 0.55; }
  .picking .l.off .n.pk { background: var(--tint); }
  .picking .n.pk:hover { box-shadow: inset 0 0 0 1px var(--accent); }
  .picking .s.pk:hover { color: var(--accent); }
  .dragging { user-select: none; -webkit-user-select: none; }
</style>
