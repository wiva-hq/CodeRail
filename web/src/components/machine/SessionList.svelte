<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A machine's sessions (the sidebar, and the phone's sessions screen): Needs you (approvals waiting here), then
  // CodeRail's sessions grouped by folder (a dot for working, the count of approvals waiting), then "On this machine":
  // the harnesses' own session lists (`agent.local`), opened with `agent.open`. A search filters them all.
  import type { LocalSession, SessionRow } from '@coderail/protocol';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { kept, keep } from '../../lib/kept';
  import { tilde, baseName } from '../../lib/machineText';
  import { ago, badge } from '../../lib/format';
  import { tip } from '../../lib/tip';
  import Icon from '../Icon.svelte';
  import HarnessMark from '../HarnessMark.svelte';
  import Button from '../ui/Button.svelte';
  import { router, paths } from '../../lib/router.svelte';
  import Menu, { type Item } from '../ui/Menu.svelte';
  let { conn, current = null, phone = false, onopen, onnew }: {
    conn: MachineConn; current?: string | null; phone?: boolean; onopen: (sessionId: string) => void; onnew: () => void;
  } = $props();
  let q = $state('');
  const needle = $derived(q.trim().toLowerCase());
  const home = $derived(conn.info?.home ?? null);
  const titleOf = (s: { title: string | null; sessionId: string }) => s.title?.trim() || "Untitled session";

  // ---- CodeRail's sessions, by folder (the newest folder first)
  const groups = $derived.by(() => {
    const m = new Map<string, SessionRow[]>();
    const rows = conn.sessions.filter((s) => !needle || `${titleOf(s)} ${s.cwd}`.toLowerCase().includes(needle));
    for (const s of [...rows].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const l = m.get(s.cwd) ?? [];
      l.push(s);
      m.set(s.cwd, l);
    }
    return [...m.entries()].map(([cwd, items]) => ({ cwd, items }));
  });
  // svelte-ignore state_referenced_locally
  const FOLD = `coderail.folds.${conn.id}`;
  let folds = $state<Record<string, boolean>>(kept(FOLD, {}));
  function fold(k: string) { folds = { ...folds, [k]: !folds[k] }; keep(FOLD, folds); }

  // ---- what needs you
  const needs = $derived(conn.approvals.map((a) => ({ a, s: conn.session(a.sessionId) })));

  // ---- the machine's own sessions
  // svelte-ignore state_referenced_locally
  let localOpen = $state(kept<boolean>(`coderail.local.${conn.id}`, false));
  let local = $state<LocalSession[] | null>(null);
  let localErr = $state<string | null>(null);
  let opening = $state<string | null>(null);
  async function loadLocal() {
    local = null; localErr = null;
    const hs = (conn.info?.harnesses ?? []).filter((h) => h.installed && conn.harnessAllowed(h.id));
    try {
      const all = await Promise.all(hs.map((h) => conn.call<LocalSession[]>('agent.local', { harness: h.id }).catch(() => [] as LocalSession[])));
      const known = new Set(conn.sessions.map((s) => s.sessionId));
      local = all.flat().filter((s) => !known.has(s.sessionId)).sort((a, b) => Date.parse(b.updatedAt ?? '0') - Date.parse(a.updatedAt ?? '0'));
    } catch (e) { localErr = plainError(e); local = []; }
  }
  $effect(() => { if (localOpen && conn.online && local === null) void loadLocal(); });
  function toggleLocal() { localOpen = !localOpen; keep(`coderail.local.${conn.id}`, localOpen); }
  const localShown = $derived((local ?? []).filter((s) => !needle || `${s.title ?? ''} ${s.cwd}`.toLowerCase().includes(needle)).slice(0, needle ? 100 : 40));
  async function openLocal(s: LocalSession) {
    if (!conn.canAct) return;
    opening = s.sessionId;
    try {
      const row = await conn.call<SessionRow>('agent.open', { harness: s.harness, sessionId: s.sessionId, cwd: s.cwd }, 120_000);
      if (!conn.sessions.some((x) => x.sessionId === row.sessionId)) conn.sessions = [row, ...conn.sessions];
      local = (local ?? []).filter((x) => x.sessionId !== s.sessionId);
      onopen(row.sessionId);
    } catch (e) { app.toast(plainError(e), 'warning'); }
    opening = null;
  }
  // ---- A session row's ⋯ (on hover, or a right-click): what you can do to that session, as the Claude app has it.
  let rowMenu = $state<{ s: SessionRow; anchor?: HTMLElement; x?: number; y?: number } | null>(null);
  const rowItems = (s: SessionRow): Item[] => [
    { id: 'rename', label: 'Rename', icon: 'rename', disabled: !conn.canOperate },
    ...(s.harness === 'claude-code' ? [{ id: 'retitle', label: 'Generate a title', icon: 'sparkle', disabled: !conn.canAct || s.state === 'running' }] : []),
    { id: 's1', sep: true },
    ...(s.state === 'running' ? [{ id: 'stop', label: 'Stop the agent', icon: 'stop', disabled: !conn.canAct }] : []),
    { id: 'copy', label: 'Copy session id', icon: 'copy' },
    { id: 's2', sep: true },
    { id: 'forget', label: 'Remove from list…', icon: 'trash', danger: true, disabled: !conn.canOperate || s.state === 'running' },
  ];
  function pickRow(id: string, s: SessionRow) {
    if (id === 'rename') rename(s);
    else if (id === 'retitle') retitle(s);
    else if (id === 'stop') void app.act(() => conn.call('agent.close', { sessionId: s.sessionId }), 'Stopped');
    else if (id === 'copy') navigator.clipboard?.writeText(s.sessionId).then(() => app.toast('Copied', 'check'));
    else if (id === 'forget') forget(s);
  }
  function rename(s: SessionRow) {
    app.ask({ title: 'Rename session', label: 'Title', value: s.title ?? '', placeholder: 'Untitled session', yes: 'Rename', run: async (v) => {
      try {
        const r = await conn.call<{ title: string | null }>('agent.rename', { sessionId: s.sessionId, title: v });
        conn.patchSession(s.sessionId, (x) => { x.title = r.title; });
      } catch (e) { return plainError(e); }
      return null;
    } });
  }
  function retitle(s: SessionRow) {
    app.toast('Asking Claude Code for a title…', 'info');
    conn.call<{ title: string }>('agent.retitle', { sessionId: s.sessionId })
      .then((r) => { conn.patchSession(s.sessionId, (x) => { x.title = r.title; }); app.toast(`Named “${r.title}”`, 'success'); })
      .catch((e) => app.toast(plainError(e), 'warning'));
  }

  /** Remove from list: CodeRail's copy goes; the harness keeps its own. */
  function forget(s: SessionRow) {
    app.confirmIt({
      title: 'Remove this session from CodeRail?', body: 'Its history here goes. The harness keeps its own copy, under “On this machine”.', yes: 'Remove', danger: true,
      run: async () => {
        await conn.call('agent.forget', { sessionId: s.sessionId });
        conn.sessions = conn.sessions.filter((x) => x.sessionId !== s.sessionId);
        if (current === s.sessionId) router.go(paths.machine(conn.id), true);
      },
    });
  }
</script>

<div class="slist" class:phone>
  <div class="top">
    <label class="find framed"><Icon name="search" size={16} /><input bind:value={q} placeholder="Search sessions" spellcheck="false"
      onkeydown={(e) => { if (e.key === 'Escape') q = ''; }} /></label>
  </div>
  <div class="list scroll">
    <button class="row new" disabled={!conn.canAct} onclick={onnew} {@attach tip(!conn.online ? 'The computer is offline' : !conn.canOperate ? 'Viewers can’t start sessions' : '')}>
      <span class="ico plus"><Icon name="plus" size={12} stroke={2} /></span><span class="t">New session</span>
    </button>

    {#if needs.length && !needle}
      <div class="ghead"><span class="gl static"><Icon name="hand" size={14} />Needs you</span><span class="badge">{badge(needs.length)}</span></div>
      {#each needs as { a, s } (a.id)}
        <button class="row need" class:sel={current === a.sessionId} onclick={() => onopen(a.sessionId)}>
          <span class="warn"><Icon name="hand" size={15} /></span>
          <span class="m"><span class="t cut">{(a.toolCall?.title ?? 'Approval').replace(/`/g, '')}</span><span class="d cut">{s ? titleOf(s) : a.harness}</span></span>
        </button>
      {/each}
    {/if}

    {#each groups as g (g.cwd)}
      {@const folded = !!folds[g.cwd] && !needle}
      <div class="ghead">
        <button class="gl" onclick={() => fold(g.cwd)} {@attach tip(tilde(g.cwd, home), { placement: 'right' })}>
          <span class="gt cut">{baseName(g.cwd)}</span><span class="gchev" class:folded><Icon name="chevd" size={12} stroke={2} /></span>
        </button>
      </div>
      {#if !folded}
        {#each g.items as s (s.sessionId)}
          {@const pend = conn.approvals.filter((a) => a.sessionId === s.sessionId).length}
          <div class="sw">
          <a class="row sess" class:sel={current === s.sessionId} href="/m/{encodeURIComponent(conn.id)}/s/{encodeURIComponent(s.sessionId)}"
            onclick={(e) => { if (!e.metaKey && !e.ctrlKey) { e.preventDefault(); onopen(s.sessionId); } }}
            oncontextmenu={(e) => { e.preventDefault(); rowMenu = { s, x: e.clientX, y: e.clientY }; }}>
            <HarnessMark harness={s.harness} size={18} bare />
            <span class="t cut">{titleOf(s)}</span>
            <span class="end">
              {#if pend}<span class="warn" {@attach tip(`${pend} waiting for approval`)}><Icon name="hand" size={14} /></span>
              {:else if s.state === 'running'}<span class="sdot run" {@attach tip('Working')}></span>
              {:else if s.state === 'closed'}<span class="when">closed</span>
              {:else}<span class="when">{ago(s.updatedAt, app.now).replace(' ago', '')}</span>{/if}
            </span>
          </a>
          <button class="rm" class:on={rowMenu?.s === s} aria-label="More for {titleOf(s)}" onclick={(e) => (rowMenu = { s, anchor: e.currentTarget as HTMLElement })} {@attach tip('More')}><Icon name="more" size={15} /></button>
          </div>
        {/each}
      {/if}
    {/each}
    {#if !groups.length && !needs.length}
      <div class="empty">{needle ? `No session matches “${q.trim()}”` : conn.ready ? 'No CodeRail sessions yet' : ''}</div>
    {/if}

    <div class="ghead local">
      <button class="gl" onclick={toggleLocal} aria-expanded={localOpen}>
        <span class="gt">On this machine</span><span class="gchev" class:folded={!localOpen}><Icon name="chevd" size={12} stroke={2} /></span>
      </button>
      {#if localOpen && conn.online}<Button variant="icon" size="xs" icon="refresh" iconSize={14} tip="Refresh" onclick={loadLocal} />{/if}
    </div>
    {#if localOpen}
      {#if !conn.online}<div class="empty">Offline</div>
      {:else if local === null}<div class="empty"><span class="spinner"></span></div>
      {:else if localErr}<div class="empty">{localErr}</div>
      {:else if !localShown.length}<div class="empty">No other sessions</div>
      {:else}
        {#each localShown as s (s.harness + s.sessionId)}
          <button class="row loc" disabled={!conn.canAct || opening === s.sessionId} onclick={() => openLocal(s)}
            {@attach tip(`${tilde(s.cwd, home)}\nOpen in CodeRail`, { placement: 'right' })}>
            <HarnessMark harness={s.harness} size={18} bare />
            <span class="m"><span class="t cut">{s.title?.trim() || s.sessionId.slice(0, 8)}</span><span class="d cut">{baseName(s.cwd)}{s.updatedAt ? ` · ${ago(Date.parse(s.updatedAt), app.now)}` : ''}</span></span>
            {#if opening === s.sessionId}<span class="spinner"></span>{/if}
          </button>
        {/each}
      {/if}
    {/if}
  </div>
</div>

<!-- (In an each over one item, so the closing menu keeps its value: an if's {@const} reads the state again as it closes, finds it empty and throws, and the menu stays on the page.) -->
{#each rowMenu ? [rowMenu] : [] as m (m)}
  <Menu anchor={m.anchor} x={m.x} y={m.y} end={!!m.anchor} width={220} label={titleOf(m.s)} items={rowItems(m.s)} onpick={(id) => pickRow(id, m.s)} onclose={() => (rowMenu = null)} />
{/each}

<style>
  .slist { display: flex; flex-direction: column; min-height: 0; flex: 1; }
  .top { padding: 0 var(--nav-inset) var(--sp-2); flex: none; }
  .top .find { height: 30px; padding: 0 var(--sp-2); gap: var(--row-x); border-radius: var(--r-md); background: var(--panel); }
  .list { flex: 1; padding: var(--sp-1) var(--nav-inset) var(--sp-4); display: flex; flex-direction: column; gap: var(--row-gap); }
  .row { flex: none; height: 30px; padding: 0 var(--sp-2); gap: var(--row-x); color: var(--ink); text-decoration: none; }
  .row:disabled { color: var(--faint); background: transparent; }
  .row .t { min-width: 0; flex: 1; white-space: nowrap; overflow: hidden; }
  .new .plus { width: 18px; height: 18px; border-radius: 9px; background: var(--sel); color: var(--ink); align-items: center; justify-content: center; }
  .ghead { display: flex; align-items: center; height: 28px; margin-top: var(--sp-4); flex: none; padding-right: var(--sp-1); }
  .gl { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-1); height: 28px; padding: 0 var(--sp-2); border-radius: var(--r-md); color: var(--muted); font-size: var(--fs-quiet); text-align: left; }
  .gl.static { gap: var(--sp-1h); }
  .gt { min-width: 0; white-space: nowrap; overflow: hidden; }
  .gl:hover { color: var(--ink); }
  .gchev { display: inline-flex; flex: none; opacity: 0; transition: opacity var(--t-fast) ease-out, transform var(--t-quick) var(--ease-snap); }
  .gchev.folded { transform: rotate(-90deg); opacity: 1; }
  .ghead:hover .gchev { opacity: 1; }
  .badge { background: var(--warn); }
  .sess, .loc, .need { height: 32px; }
  .sw { position: relative; display: flex; flex-direction: column; }
  .rm { position: absolute; right: var(--sp-1); top: 50%; transform: translateY(-50%); width: 24px; height: 24px; border-radius: var(--r-sm); display: none; align-items: center; justify-content: center; color: var(--muted); background: var(--hover); }
  .rm:hover { color: var(--ink); background: var(--sel); }
  .sw:hover .rm, .rm:focus-visible, .rm.on { display: inline-flex; }
  .sw:hover .sess .end { visibility: hidden; }
  .need, .loc { height: 40px; }
  .m { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 17px; }
  .m .t { font-size: var(--fs-quiet); }
  .m .d { color: var(--muted); font-size: var(--fs-small); white-space: nowrap; overflow: hidden; }
  .end { min-width: 20px; display: inline-flex; justify-content: flex-end; align-items: center; flex: none; }
  .when { color: var(--faint); font-size: var(--fs-small); font-variant-numeric: tabular-nums; }
  .warn { color: var(--warn); display: inline-flex; flex: none; }
  .empty { display: flex; align-items: center; min-height: 28px; padding: 0 var(--sp-2); color: var(--faint); font-size: var(--fs-quiet); flex: none; }
  .loc :global(.hm), .sess :global(.hm) { color: var(--ink2); }
  .phone .row { height: 44px; font-size: 16px; }
  .phone .need, .phone .loc { height: 52px; }
  .phone .top .find { height: 38px; }
</style>
