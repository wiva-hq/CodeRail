<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Under the composer, as in the Claude app: the mode on the left (its menu: each mode with what it does, a number
  // key and a check), and on the right the model with its effort (the main models numbered, then Effort › and More
  // models ›), then a ring for how full the context window is. Modes come from ACP modes or a "mode" config option,
  // models from a "model" option or ACP models, effort from an effort option; any other select options stay as
  // their own menus. Read only for viewers and while the machine is offline. On the phone (`phone`), as the Claude
  // app: a round + (Add context: Camera and Photos, then the mode and any other options, each a page of its own), the
  // model pill (Select model: the main models, Effort ›, More models ›) and the ring (Usage), each a bottom sheet.
  import type { SessionRow } from '@coderail/protocol';
  import type { MachineConn, SessionView } from '../../lib/machine.svelte';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import Select from '../ui/Select.svelte';
  import Menu, { type Item } from '../ui/Menu.svelte';
  import Popover from '../ui/Popover.svelte';
  import PhoneSheet, { type Row } from '../ui/PhoneSheet.svelte';
  import Icon from '../Icon.svelte';
  import { untrack } from 'svelte';
  let { conn, row, view, phone = false, onattach }: {
    conn: MachineConn; row: SessionRow; view: SessionView; phone?: boolean;
    /** The phone's Camera and Photos: the composer's picture picker (true: the camera). */
    onattach?: (camera: boolean) => void;
  } = $props();

  type Choice = { id: string; name: string; desc?: string };
  // (Fast mode isn't offered here: an "On ⌄" choice from an older adapter is left out too.)
  const isFast = (o: any) => o.id === 'fast' || /^fast mode$/i.test(o.name ?? '');
  const options = $derived(((row.configOptions ?? []) as any[]).filter((o) => (o.type ?? 'select') === 'select' && !isFast(o)));
  const flat = (o: any): Choice[] =>
    ((o?.options ?? []) as any[]).flatMap((x) => (Array.isArray(x.options) ? x.options : [x])).map((y) => ({ id: String(y.value), name: y.name ?? String(y.value), desc: y.description }));

  const modeOpt = $derived(options.find((o) => o.category === 'mode'));
  const modelOpt = $derived(options.find((o) => o.category === 'model' || o.id === 'model'));
  const effortOpt = $derived(options.find((o) => o.category === 'thought_level' || /effort|reasoning|thinking/i.test(o.id)));
  const others = $derived(options.filter((o) => o !== modeOpt && o !== modelOpt && o !== effortOpt));

  const modes = $derived<Choice[]>(modeOpt ? flat(modeOpt) : ((row.modes?.availableModes ?? []) as any[]).map((m) => ({ id: m.id, name: m.name, desc: m.description })));
  const mode = $derived(modeOpt ? String(modeOpt.currentValue ?? '') : row.modes?.currentModeId ?? '');
  const listed = $derived<Choice[]>(modelOpt ? flat(modelOpt) : ((row.models?.availableModels ?? []) as any[]).map((m) => ({ id: m.modelId, name: m.name, desc: m.description })));
  const chosen = $derived(modelOpt ? String(modelOpt.currentValue ?? '') : row.models?.currentModelId ?? '');
  // (An older adapter lists "Default (recommended)", whose description names the model it runs: that model stands
  // in for it, checked while the default is in use, so the list is the models themselves.)
  const stand = $derived.by(() => {
    const d = listed.find((m) => m.id === 'default');
    return d ? listed.find((m) => m.id !== 'default' && (m.name === d.desc || m.desc === d.desc)) ?? null : null;
  });
  const models = $derived(stand ? listed.filter((m) => m.id !== 'default') : listed);
  const model = $derived(stand && chosen === 'default' ? stand.id : chosen);
  const efforts = $derived<Choice[]>(effortOpt ? flat(effortOpt) : []);
  const effort = $derived(effortOpt ? String(effortOpt.currentValue ?? '') : '');
  const nameOf = (list: Choice[], id: string) => list.find((c) => c.id === id)?.name ?? id;

  const can = $derived(conn.canAct);
  async function run(method: string, params: Record<string, unknown>, local: () => void) {
    try { await conn.call(method, { sessionId: row.sessionId, ...params }); local(); } catch (e) { app.toast(plainError(e), 'warning'); }
  }
  function setOption(o: any, v: string | boolean) {
    void run('agent.set_config', { configId: o.id, value: v }, () =>
      conn.patchSession(row.sessionId, (s) => { s.configOptions = (s.configOptions ?? []).map((x: any) => (x.id === o.id ? { ...x, currentValue: v } : x)); }));
  }
  function setMode(id: string) {
    if (modeOpt) return setOption(modeOpt, id);
    void run('agent.set_mode', { modeId: id }, () => conn.patchSession(row.sessionId, (s) => { s.modes = { ...s.modes, currentModeId: id }; }));
  }
  function setModel(id: string) {
    if (modelOpt) return setOption(modelOpt, id);
    void run('agent.set_model', { modelId: id }, () => conn.patchSession(row.sessionId, (s) => { s.models = { ...s.models, currentModelId: id }; }));
  }

  // ---- The menus
  let open = $state<{ which: 'mode' | 'model' | 'usage'; el: HTMLElement } | null>(null);
  const toggle = (which: 'mode' | 'model' | 'usage', e: MouseEvent) => (open = open?.which === which ? null : { which, el: e.currentTarget as HTMLElement });
  const modeItems = $derived<Item[]>([
    { id: 'h', label: 'Mode', header: true },
    ...modes.map((m, i) => ({ id: m.id, label: m.name, desc: m.desc, kbd: i < 9 ? String(i + 1) : undefined, on: m.id === mode })),
  ]);
  /** The first few models up front (the current one among them), the rest under More models ›. */
  const MAIN = 4;
  const main = $derived.by(() => {
    const top = models.slice(0, MAIN);
    const cur = models.find((m) => m.id === model);
    return cur && !top.includes(cur) ? [...top.slice(0, MAIN - 1), cur] : top;
  });
  const modelItems = $derived<Item[]>([
    ...main.map((m, i) => ({ id: 'm:' + m.id, label: m.name, kbd: String(i + 1), on: m.id === model })),
    ...(efforts.length
      ? [{ id: 's1', sep: true }, { id: 'effort', label: 'Effort', value: nameOf(efforts, effort), sub: efforts.map((e) => ({ id: 'e:' + e.id, label: e.name, desc: e.desc, on: e.id === effort })) }]
      : []),
    ...(models.length > main.length
      ? [{ id: 's2', sep: true }, { id: 'more', label: 'More models', sub: models.filter((m) => !main.includes(m)).map((m) => ({ id: 'm:' + m.id, label: m.name, on: m.id === model })) }]
      : []),
  ]);
  function pickModel(id: string) {
    if (id.startsWith('m:')) setModel(id.slice(2));
    else if (id.startsWith('e:') && effortOpt) setOption(effortOpt, id.slice(2));
  }

  // ---- Plan limits (Claude's, on the computer's own login, as the Claude app shows them) and the context window
  const claude = $derived(row.harness === 'claude-code');
  $effect(() => { if (claude && conn.canAct) void untrack(() => conn.loadLimits()); });
  const windows = $derived((conn.limits?.windows ?? []).filter((w) => w.id === 'five_hour' || w.id === 'seven_day'));
  const SAME_DAY = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const WEEK = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  /** "Resets at 11:40 PM" today, else "Resets Wed 12:00 PM". */
  function resets(ms: number) {
    const d = new Date(ms), t = new Date(app.now);
    return d.toDateString() === t.toDateString() ? `Resets at ${SAME_DAY.format(d)}` : `Resets ${WEEK.format(d)}`;
  }
  const context = $derived(view.usage?.used && view.usage?.size ? Math.min(100, (100 * view.usage.used) / view.usage.size) : null);
  /** The ring: Claude's 5-hour limit (the context window until it is known, and for Codex). */
  const pct = $derived(claude && windows.length ? windows[0].used : context);
  const R = 7, C = 2 * Math.PI * R;
  const ringLabel = $derived(claude && windows.length ? `Plan usage: ${Math.round(pct ?? 0)}% of the ${windows[0].label}` : `Context window: ${Math.round(pct ?? 0)}% used`);

  // ---- The phone's sheets
  let sheet = $state<string | null>(null);
  /** A mode's glyph and tint, by what its id or name says (the Claude app's bolt, code, plan). */
  function modeLook(c: Choice): [string, string] {
    const k = `${c.id} ${c.name}`.toLowerCase();
    if (/plan/.test(k)) return ['read', '#3b82f6'];
    if (/accept|auto.?edit/.test(k)) return ['code', '#7c5cff'];
    if (/bypass|auto|yolo|full|dangerous|never/.test(k)) return ['bolt', '#d97757'];
    return ['hand', 'var(--ink2)'];
  }
  const choiceRows = (list: Choice[], cur: string, look?: (c: Choice) => [string, string]): Row[] =>
    list.map((c) => ({ id: c.id, label: c.name, desc: c.desc, on: c.id === cur, icon: look?.(c)[0], tint: look?.(c)[1] }));
  /** Models by name alone (their descriptions are only the agent's marketing lines). */
  const modelRows = (list: Choice[]): Row[] => choiceRows(list, model).map((r) => ({ ...r, desc: undefined }));
  const addGroups = $derived<Row[][]>([
    ...(modes.length ? [[{ id: 'mode', label: 'Mode', icon: modeLook({ id: mode, name: nameOf(modes, mode) })[0], value: nameOf(modes, mode), next: true }]] : []),
    ...others.map((o) => [{ id: 'opt:' + o.id, label: o.name, icon: 'sliders', value: nameOf(flat(o), String(o.currentValue ?? '')), next: true }]),
  ]);
  const opened = $derived(sheet?.startsWith('opt:') ? others.find((o) => 'opt:' + o.id === sheet) : undefined);
  const close = () => (sheet = null);
</script>

{#if phone}
  <div class="pchips" class:off={!can}>
    <button class="pround" onclick={() => (sheet = 'add')} aria-label="Add context"><Icon name="plus" size={20} stroke={1.7} /></button>
    {#if models.length || efforts.length}
      <button class="pill" onclick={() => (sheet = 'model')} aria-label="Model">
        {#if models.length}<span class="cut">{nameOf(models, model)}</span>{/if}{#if efforts.length}<span class="soft">{nameOf(efforts, effort)}</span>{/if}
      </button>
    {/if}
    <span class="sp"></span>
    {#if pct != null}
      <button class="ring" onclick={() => (sheet = 'usage')} aria-label={ringLabel}>
        <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r={R} class="track" /><circle cx="10" cy="10" r={R} class="fill" stroke-dasharray="{(C * pct) / 100} {C}" /></svg>
      </button>
    {/if}
  </div>

  {#if sheet === 'add'}
    <PhoneSheet title="Add context" onclose={close} groups={addGroups} onpick={(id) => (sheet = id)}>
      <div class="tiles">
        <button class="tile" onclick={() => { close(); onattach?.(true); }}><Icon name="camera" size={24} stroke={1.6} /><span>Camera</span></button>
        <button class="tile" onclick={() => { close(); onattach?.(false); }}><Icon name="photo" size={24} stroke={1.6} /><span>Photos</span></button>
      </div>
    </PhoneSheet>
  {:else if sheet === 'mode'}
    <PhoneSheet title="Select mode" onclose={close} onback={() => (sheet = 'add')} groups={[choiceRows(modes, mode, modeLook)]} onpick={(id) => { if (can) setMode(id); close(); }} />
  {:else if opened}
    {@const o = opened}
    <PhoneSheet title={o.name} onclose={close} onback={() => (sheet = 'add')} groups={[choiceRows(flat(o), String(o.currentValue ?? ''))]} onpick={(id) => { if (can) setOption(o, id); close(); }} />
  {:else if sheet === 'model'}
    <PhoneSheet title="Select model" onclose={close}
      groups={[
        ...(main.length ? [modelRows(main)] : []),
        ...(efforts.length ? [[{ id: 'effort', label: 'Effort', value: nameOf(efforts, effort), next: true }]] : []),
        ...(models.length > main.length ? [[{ id: 'more', label: 'More models', next: true }]] : []),
      ]}
      onpick={(id) => { if (id === 'effort' || id === 'more') sheet = id; else { if (can) setModel(id); close(); } }} />
  {:else if sheet === 'effort' && effortOpt}
    <PhoneSheet title="Effort" onclose={close} onback={() => (sheet = 'model')} groups={[choiceRows(efforts, effort)]} onpick={(id) => { if (can) setOption(effortOpt, id); close(); }} />
  {:else if sheet === 'more'}
    <PhoneSheet title="More models" onclose={close} onback={() => (sheet = 'model')} groups={[modelRows(models.filter((m) => !main.includes(m)))]} onpick={(id) => { if (can) setModel(id); close(); }} />
  {:else if sheet === 'usage' && pct != null}
    <PhoneSheet title="Usage" full onclose={close}>
      {#if claude && windows.length}
        <div class="plabel">Plan usage limits{conn.limits?.plan ? ` · ${conn.limits.plan}` : ''}</div>
        <div class="pcard">
          {#each windows as w (w.id)}
            <div class="ur"><span>{w.label}</span><span class="soft">{Math.round(w.used)}%</span></div>
            <div class="bar big"><span style:width="{w.used}%"></span></div>
            {#if w.resetsAt}<div class="soft small">{resets(w.resetsAt)}</div>{/if}
          {/each}
        </div>
      {/if}
      {#if context != null}
        <div class="plabel">Context</div>
        <div class="pcard">
          <div class="ur"><span>Context window</span><span class="soft">{Math.round(context)}% used</span></div>
          <div class="bar big"><span style:width="{context}%"></span></div>
          <div class="soft small">{view.usage?.used?.toLocaleString()} of {view.usage?.size?.toLocaleString()} tokens</div>
        </div>
      {/if}
    </PhoneSheet>
  {/if}
{:else}
<div class="chips" class:off={!can}>
  {#if modes.length}
    <button class="ctl" class:on={open?.which === 'mode'} onclick={(e) => toggle('mode', e)} aria-haspopup="menu">{nameOf(modes, mode)}</button>
  {/if}
  {#each others as o (o.id)}
    <Select plain label={o.name} value={String(o.currentValue ?? '')} items={flat(o).map((c) => ({ id: c.id, label: c.name, desc: c.desc }))} tip={o.description ?? o.name} width={260} onpick={(v) => can && setOption(o, v)} />
  {/each}
  <span class="sp"></span>
  {#if models.length || efforts.length}
    <button class="ctl" class:on={open?.which === 'model'} onclick={(e) => toggle('model', e)} aria-haspopup="menu">
      {#if models.length}<span>{nameOf(models, model)}</span>{/if}{#if efforts.length}<span class="soft">{nameOf(efforts, effort)}</span>{/if}
    </button>
  {/if}
  {#if pct != null}
    <button class="ring" class:on={open?.which === 'usage'} onclick={(e) => toggle('usage', e)} aria-label={ringLabel}>
      <svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r={R} class="track" /><circle cx="10" cy="10" r={R} class="fill" stroke-dasharray="{(C * pct) / 100} {C}" /></svg>
    </button>
  {/if}
</div>

{#if open?.which === 'mode'}
  <Menu items={modeItems} anchor={open.el} up width={380} label="Mode" onpick={(id) => can && setMode(id)} onclose={() => (open = null)} />
{:else if open?.which === 'model'}
  <Menu items={modelItems} anchor={open.el} up end width={280} label="Model" onpick={(id) => can && pickModel(id)} onclose={() => (open = null)} />
{:else if open?.which === 'usage' && pct != null}
  <Popover anchor={open.el} placement="top-end" gap={10} width={392} label="Usage" onclose={() => (open = null)}>
    <div class="usage">
      {#if claude && windows.length}
        <div class="uh"><span>Plan usage limits{conn.limits?.plan ? ` · ${conn.limits.plan}` : ''}</span></div>
        {#each windows as w (w.id)}
          <div class="lim">
            <div class="ur"><span>{w.label}</span><span class="soft">{w.resetsAt ? resets(w.resetsAt) : ''}<b>{Math.round(w.used)}%</b></span></div>
            <div class="bar"><span style:width="{w.used}%"></span></div>
          </div>
        {/each}
      {:else}
        <div class="uh"><span>Context window</span></div>
        <div class="lim">
          <div class="ur"><span>This session</span><span class="soft">{view.usage?.used?.toLocaleString()} of {view.usage?.size?.toLocaleString()} tokens<b>{Math.round(pct)}%</b></span></div>
          <div class="bar"><span style:width="{pct}%"></span></div>
        </div>
      {/if}
    </div>
  </Popover>
{/if}
{/if}

<style>
  .chips { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-1); min-height: var(--control); margin: var(--sp-1h) 0 var(--sp-3); padding: 0 var(--sp-1); }
  .chips.off { pointer-events: none; opacity: 0.6; }
  .chips :global(.select.plain) { margin-right: 0; color: var(--ink2); }
  .chips :global(.select.plain .v) { color: var(--ink2); font-size: var(--fs-quiet); }
  .ctl { display: inline-flex; align-items: center; gap: var(--sp-1h); height: 30px; padding: 0 var(--sp-2h, 10px); border-radius: var(--r-md); color: var(--ink); font-size: var(--fs-quiet); white-space: nowrap;
    transition: background var(--t-fast) ease-out; }
  .ctl:hover, .ctl.on { background: var(--sel); }
  .soft { color: var(--muted); }
  .sp { flex: 1; }
  .ring { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: var(--r-md); transition: background var(--t-fast) ease-out; }
  .ring:hover, .ring.on { background: var(--sel); }
  .ring svg { transform: rotate(-90deg); }
  .ring circle { fill: none; stroke-width: 2.4; }
  .ring .track { stroke: var(--hair2); }
  .ring .fill { stroke: var(--link, #3b82f6); stroke-linecap: round; }
  .usage { display: flex; flex-direction: column; gap: 14px; padding: 18px 17px 16px; }
  .uh, .ur { display: flex; justify-content: space-between; align-items: baseline; gap: var(--sp-3); }
  .uh { color: var(--muted); font-size: 15px; }
  .lim { display: flex; flex-direction: column; gap: 6px; }
  .ur > span:first-child { color: var(--ink); font-size: 15px; }
  .ur .soft { font-size: 14px; white-space: nowrap; }
  .ur b { font-weight: inherit; margin-left: 10px; }
  .bar { height: 6px; border-radius: 3px; background: var(--hair); overflow: hidden; }
  .bar span { display: block; height: 100%; border-radius: 3px; background: var(--link, #3b82f6); }
  /* The phone */
  .pchips { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2); }
  .pchips.off { pointer-events: none; opacity: 0.6; }
  .pround { width: 40px; height: 40px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--tint); color: var(--ink); }
  .pill { display: inline-flex; align-items: center; gap: var(--sp-1h); min-width: 0; height: 40px; padding: 0 var(--sp-4); border-radius: 20px; background: var(--tint); color: var(--ink); font-size: 15px; white-space: nowrap; }
  .pround:active, .pill:active { transform: scale(0.96); }
  .tiles { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-3); }
  .tile { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-2); height: 104px; border-radius: 22px; background: var(--tint); color: var(--ink); font-size: 17px; }
  .tile:active { transform: scale(0.97); }
  .plabel { color: var(--muted); font-size: 15px; margin: var(--sp-1) var(--sp-5) calc(-1 * var(--sp-2)); }
  .pcard { display: flex; flex-direction: column; gap: var(--sp-3); background: var(--panel); border-radius: 22px; padding: var(--sp-5); }
  .pcard .ur > span:first-child { font-size: 17px; }
  .pcard .ur .soft { font-size: 15px; }
  .bar.big { height: 8px; border-radius: 4px; background: color-mix(in srgb, var(--link, #3b82f6) 22%, transparent); }
  .small { font-size: 14px; }
</style>
