<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A session's conversation (Forest's ChatList and Message, for one agent): your prompts at the right in a soft
  // bubble (someone else's with their name), the agent's words as open text in the reply face, its tool calls and
  // thinking as quiet lines between them, its plan, approvals (the one waiting is docked over the composer instead),
  // a turn's end when it ended otherwise than done, errors and notices. Pinned to the end while you are there (it
  // follows the stream); scrolled up, a button jumps back.
  import { onMount, tick } from 'svelte';
  import type { SessionView, MachineConn } from '../../lib/machine.svelte';
  import { app } from '../../lib/app.svelte';
  import { edges } from '../../lib/edges';
  import { worked, hm } from '../../lib/format';
  import { rise, ms } from '../../lib/motion';
  import { tip } from '../../lib/tip';
  import Markdown from '../Markdown.svelte';
  import Icon from '../Icon.svelte';
  import Dots from '../Dots.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import ToolCall from './ToolCall.svelte';
  import ToolGroup from './ToolGroup.svelte';
  import Thought from './Thought.svelte';
  import Plan from './Plan.svelte';
  import Approval from './Approval.svelte';
  let { view, conn, running = false }: { view: SessionView; conn: MachineConn; running?: boolean } = $props();
  let el = $state<HTMLDivElement>();
  let col = $state<HTMLDivElement>();
  let stuck = $state(true);
  let away = $state(0);
  const me = $derived(app.user ? app.user.username : '');
  const items = $derived(view.items);
  /** When the turn in progress started (the last prompt). */
  const started = $derived.by(() => { for (let i = items.length - 1; i >= 0; i--) if (items[i].k === 'user') return items[i].at; return 0; });
  const lastK = $derived(items.at(-1)?.k);
  const STOP: Record<string, string> = { cancelled: 'Stopped', max_tokens: 'Stopped: the reply hit its length limit', max_turn_requests: 'Stopped: too many steps in one turn', refusal: 'The agent declined' };

  const dist = () => (el ? el.scrollHeight - el.scrollTop - el.clientHeight : 0);
  function toEnd() { if (el) el.scrollTop = el.scrollHeight; }
  // (Only a scroll the reader makes unpins it: content growing or the dock arriving moves the view too.)
  let userAt = 0;
  const user = () => { userAt = Date.now(); };
  function onscroll() { away = dist(); if (Date.now() - userAt < 250 || away <= 40) stuck = away <= 40; }
  onMount(() => {
    const ro = new ResizeObserver(() => { if (stuck) toEnd(); away = dist(); });
    if (col) ro.observe(col);
    if (el) ro.observe(el);
    return () => ro.disconnect();
  });
  $effect(() => { void view.id; stuck = true; tick().then(toEnd); });
  $effect(() => { void items.length; tick().then(() => { if (stuck) toEnd(); }); });
  export function pin() { stuck = true; tick().then(toEnd); }
  const src = (i: { mimeType: string; data: string }) => `data:${i.mimeType};base64,${i.data}`;
  /** The tool calls in a row starting at items[i]. */
  function toolRun(i: number) {
    const run: Extract<(typeof items)[number], { k: 'tool' }>[] = [];
    for (let j = i; j < items.length; j++) {
      const x = items[j];
      if (x.k !== 'tool') break;
      run.push(x);
    }
    return run;
  }
</script>

<div class="wrap">
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions (the reader's own scrolling, told apart from the stream's) -->
  <div class="list scroll" bind:this={el} {onscroll} onwheel={user} ontouchmove={user} onkeydown={user} onpointerdown={user} tabindex="-1" {@attach edges()} role="log" aria-label="Conversation">
    <div class="col" bind:this={col}>
      {#if !items.length}
        {#if view.error}
          <EmptyState compact icon="warning" text="Couldn’t load this session" tip={view.error} action={{ label: 'Retry', primary: false, run: () => view.load() }} />
        {:else if !view.loaded}
          <div class="skel" aria-label="Loading">{#each [[380, 220], [300, 0], [340, 180]] as [a, b], i (i)}<div class="sk"><span class="bars"><i style="width:96px"></i><i style="width:{a}px"></i>{#if b}<i style="width:{b}px"></i>{/if}</span></div>{/each}</div>
        {:else}
          <div class="fresh"><h1>{view.row?.title || 'New session'}</h1><p>Say what you want done.</p></div>
        {/if}
      {/if}
      {#each items as it, i (it.key)}
        {@const prev = items[i - 1]}
        {#if it.k === 'user'}
          <div class="msg user" class:first={i === 0}>
            {#if it.by && it.by !== me}<div class="by">{it.by}</div>{/if}
            {#if it.images.length}<div class="imgs">{#each it.images as im, j (j)}<img src={src(im)} alt="" />{/each}</div>{/if}
            {#if it.text}<div class="bubble" {@attach tip(hm(it.at), { placement: 'left' })}><Markdown text={it.text} hug /></div>{/if}
          </div>
        {:else if it.k === 'agent'}
          <div class="msg agent" class:cont={prev && prev.k !== 'user'}><Markdown text={it.text} reply /></div>
        {:else if it.k === 'thought'}
          <div class="step" class:after={prev?.k === 'user'}><Thought text={it.text} live={running && i === items.length - 1} /></div>
        {:else if it.k === 'tool'}
          <!-- (Tool calls in a row: the first draws them as one group; the others are drawn there.) -->
          {#if prev?.k !== 'tool'}
            {@const run = toolRun(i)}
            <div class="step" class:after={prev?.k === 'user'}>{#if run.length > 1}<ToolGroup tools={run} />{:else}<ToolCall t={it} />{/if}</div>
          {/if}
        {:else if it.k === 'plan'}
          <Plan p={it} />
        {:else if it.k === 'approval'}
          {#if it.answer || !conn.approvals.some((x) => x.id === it.approval.id) || !conn.canAct}
            <div class="step"><Approval a={it.approval} {conn} answer={it.answer} /></div>
          {:else}
            <div class="step waitline"><span class="warn"><Icon name="hand" size={15} /></span>Waiting for approval{conn.canAct ? ' below' : ''}</div>
          {/if}
        {:else if it.k === 'turn'}
          {#if STOP[it.stopReason]}<div class="end"><Icon name="error" size={15} />{STOP[it.stopReason]}</div>{/if}
        {:else if it.k === 'error'}
          <div class="end bad"><Icon name="warning" size={15} /><span class="selectable">{it.message}</span></div>
        {:else if it.k === 'notice'}
          <div class="notice">{it.text}</div>
        {/if}
      {/each}
      {#if running}
        <div class="status" class:after={lastK === 'user'}>
          <span class="mk"><Dots /></span>
          <span class="lbl">{lastK === 'approval' ? 'Waiting for approval' : 'Working'}</span>
          {#if started}<span class="el">{worked(app.now - started)}</span>{/if}
        </div>
      {/if}
    </div>
  </div>
  {#if !stuck && away > 120}
    <button class="jump" transition:rise={{ y: 6, duration: ms.base }} onclick={() => { stuck = true; toEnd(); }} aria-label="Jump to latest" {@attach tip('Jump to latest')}><Icon name="chevd" size={16} stroke={2} /></button>
  {/if}
</div>

<style>
  .wrap { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .wrap:global([data-more-top])::before { content: ''; position: absolute; top: 0; left: 0; right: 0; height: var(--hairline); background: var(--hair); z-index: 2; pointer-events: none; }
  .list { flex: 1; min-height: 0; outline: none; overflow-anchor: none; }
  .col { max-width: var(--chat-column); margin: 0 auto; padding: var(--sp-2) var(--sp-5) var(--message-gap); }
  @container chat (min-width: 600px) { .col { padding-left: var(--sp-8); padding-right: var(--sp-8); } }
  .msg { padding-top: var(--message-gap); }
  .msg.agent.cont { padding-top: var(--follow-gap); }
  .user { display: flex; flex-direction: column; align-items: flex-end; padding-left: 16%; }
  .by { color: var(--muted); font-size: var(--fs-small); padding: 0 var(--sp-2) var(--sp-1); }
  .bubble { padding: 11px var(--sp-4); border-radius: var(--r-bubble); background: var(--bubble); max-width: 100%; }
  .imgs { display: flex; flex-wrap: wrap; gap: var(--sp-2); justify-content: flex-end; margin-bottom: var(--sp-2); }
  .imgs img { max-width: 200px; max-height: 160px; border-radius: var(--r-md); box-shadow: 0 0 0 var(--hairline) var(--hair); }
  .step { padding-top: var(--sp-1); }
  .step.after { padding-top: var(--message-gap); }
  .waitline { display: flex; align-items: center; gap: var(--row-x); min-height: 28px; color: var(--ink2); font-size: var(--fs-quiet); }
  .warn { color: var(--warn); display: inline-flex; width: 20px; justify-content: center; }
  .end { display: flex; align-items: center; gap: var(--sp-2); min-height: var(--control); margin-top: var(--sp-2); color: var(--ink2); font-size: var(--fs-body); }
  .end.bad { color: var(--danger-ink); align-items: flex-start; }
  .end.bad :global(svg) { margin-top: 3px; flex: none; }
  .notice { text-align: center; color: var(--muted); font-size: var(--fs-quiet); padding: var(--message-gap) var(--sp-6) 0; }
  .status { display: flex; align-items: center; gap: var(--sp-2); min-height: 28px; padding-top: var(--sp-3); color: var(--ink2); }
  .status.after { padding-top: var(--message-gap); }
  .mk { width: 20px; display: inline-flex; justify-content: center; }
  .el { color: var(--muted); font-variant-numeric: tabular-nums; }
  .skel { display: flex; flex-direction: column; gap: var(--sp-6); padding-top: var(--sp-5); }
  .sk .bars { display: flex; flex-direction: column; gap: var(--sp-2); }
  .sk i { display: block; height: 10px; max-width: 100%; border-radius: var(--r-xs); background: var(--tint); animation: pulse 1.6s ease-in-out infinite; }
  .fresh { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); padding-top: 120px; text-align: center; }
  .fresh h1 { margin: 0; max-width: 520px; font: var(--w-text) 30px / 1.2 var(--serif); letter-spacing: -0.3px; }
  .fresh p { margin: 0; color: var(--muted); }
  .jump { position: absolute; left: 50%; bottom: var(--sp-3); margin-left: -17px; width: 34px; height: 34px; border-radius: 999px; z-index: var(--z-chrome);
    display: inline-flex; align-items: center; justify-content: center; color: var(--ink); background: var(--pop); box-shadow: var(--shadow-pop); }
  :global(:root[data-phone]) .col { padding: var(--sp-1) var(--gutter) var(--sp-6); }
</style>
