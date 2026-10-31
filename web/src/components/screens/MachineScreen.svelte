<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A machine (/m/:id, /m/:id/s/:sid), on a wide window: Forest's project screen. At the left the sidebar: back to
  // the machines, this machine (its state; the others in its menu), its sessions (SessionList). The rest is the pane
  // tree (PaneHost, kept per machine): the conversation with its own title row (the session, its folder, the tools'
  // icons) and the tool cards beside it: Files, Changes, Terminal, Browser, Background. An offline machine is
  // history only, with a banner; what your role can't do is off.
  import { openSignInTab } from '../../lib/signin';
  import { untrack } from 'svelte';
  import { setOpenLink } from '../../lib/links';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { router, paths } from '../../lib/router.svelte';
  import { panes, type Kind } from '../../lib/panes.svelte';
  import { kept, keep } from '../../lib/kept';
  import { tilde } from '../../lib/machineText';
  import { badge, ago } from '../../lib/format';
  import { tip } from '../../lib/tip';
  import Icon from '../Icon.svelte';
  import Mark from '../Mark.svelte';
  import HarnessMark from '../HarnessMark.svelte';
  import Button from '../ui/Button.svelte';
  import Menu, { type Item } from '../ui/Menu.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import PaneHost from '../PaneHost.svelte';
  import PaneCard from '../PaneCard.svelte';
  import SessionList from '../machine/SessionList.svelte';
  import Harnesses from '../machine/Harnesses.svelte';
  import Sheet from '../ui/Sheet.svelte';
  import type { HarnessInfo } from '@coderail/protocol';
  import NewSession from '../machine/NewSession.svelte';
  import SessionChat from '../chat/SessionChat.svelte';
  import FilesCard from '../panes/FilesCard.svelte';
  import ChangesCard from '../panes/ChangesCard.svelte';
  import TerminalCard from '../panes/TerminalCard.svelte';
  import BrowserCard from '../panes/BrowserCard.svelte';
  import BackgroundCard from '../panes/BackgroundCard.svelte';
  let { id, session }: { id: string; session: string | null } = $props();
  const conn = $derived(app.conn(id));
  const m = $derived(app.machine(id));
  const name = $derived(m?.name ?? conn.info?.hostname ?? 'Computer');
  const row = $derived(session ? conn.session(session) ?? conn.view(session).row : null);
  // (The title, renamed in place: click it, type, Return or clicking away saves, Esc leaves it.)
  let naming = $state<string | null>(null);
  function startNaming() { if (row && conn.canOperate) naming = row.title ?? ''; }
  async function saveName() {
    const r = row, v = naming;
    naming = null;
    if (!r || v === null || v.trim() === (r.title ?? '')) return;
    try {
      const res = await conn.call<{ title: string | null }>('agent.rename', { sessionId: r.sessionId, title: v });
      conn.patchSession(r.sessionId, (x) => { x.title = res.title; });
    } catch (e) { app.toast(plainError(e), 'warning'); }
  }
  const focusAll = (el: HTMLInputElement) => { el.focus(); el.select(); };
  const conv = $derived(id);
  let folded = $state(kept('coderail.sideFolded', false));
  $effect(() => keep('coderail.sideFolded', folded));
  // (The sidebar's width: drag its edge, 200 to 480; a double-click puts it back. Kept per browser.)
  const SIDE = 272;
  let sideW = $state(kept('coderail.sideWidth', SIDE));
  let sizing = $state(false);
  $effect(() => keep('coderail.sideWidth', sideW === SIDE ? null : sideW));
  function resize(e: PointerEvent) {
    e.preventDefault();
    const el = e.currentTarget as HTMLElement, x0 = e.clientX, w0 = sideW;
    el.setPointerCapture(e.pointerId);
    sizing = true;
    const move = (m: PointerEvent) => { sideW = Math.round(Math.min(480, Math.max(200, w0 + m.clientX - x0))); };
    const up = () => { sizing = false; el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }
  let newOpen = $state(false);
  let machineMenu = $state<HTMLElement | null>(null);
  let moreMenu = $state<HTMLElement | null>(null);
  let chatW = $state(800);
  const narrow = $derived(chatW <= 520);
  // (The open chat's agent opened its browser: its Browser card comes up.)
  $effect(() => conn.listen('machine', (e: any) => { if (e?.type === 'browser' && e.sessionId === session) panes.show(conv, 'browser'); }));
  // (A link clicked in the chat opens in its Browser card.)
  setOpenLink((url) => {
    if (!session || !conn.canAct) return false; // (a viewer, or the computer offline: the card couldn't open it)
    panes.show(conv, 'browser');
    const t = panes.tabs(conv).find((x) => x.kind === 'browser');
    if (t) panes.setTab(conv, t.id, { open: url });
    return !!t;
  });
  const bgCount = $derived(conn.approvals.length + conn.tasks.length + conn.terminals.filter((t) => t.exited == null).length);
  /** A turn ending (the session row changing) reads Changes again. */
  const stamp = $derived(row?.updatedAt ?? 0);
  // (Back to the page after a while: the machine's state again.)
  $effect(() => {
    const again = () => { if (document.visibilityState === 'visible') { if (!conn.connected) conn.reconnect(); } };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  });
  $effect(() => { if (!app.machinesLoaded) untrack(() => app.loadMachines()); });

  function openSession(sid: string) { router.go(paths.machine(id, sid)); }
  function toggle(kind: Kind) { panes.toggle(conv, kind); }
  /** A running terminal in a Terminal tab: its own tab if one shows it, else a new tab attached to it. */
  /** A harness's own sign-in on the machine, in a Terminal tab of its own ("Codex sign-in"). */
  let agentsOpen = $state(false);
  function signIn(h: HarnessInfo) {
    agentsOpen = false;
    openSignInTab(id, h.id);
    const title = `${h.name} sign-in`;
    const old = panes.tabs(conv).find((x) => x.kind === 'terminal' && x.login && x.sub === h.id);
    if (old) { if (old.term) conn.call('term.close', { id: old.term }).catch(() => {}); panes.closeTab(conv, old.id); }
    const g = panes.get(conv).groups.find((x) => x.tabs.some((y) => y.kind === 'terminal'));
    panes.addTab(conv, 'terminal', g?.id, h.id);
    const fresh = panes.tabs(conv).filter((x) => x.kind === 'terminal' && x.sub === h.id && !x.term && !x.login).at(-1);
    if (fresh) panes.setTab(conv, fresh.id, { login: true, title });
  }
  function showTerminal(termId: string) {
    const t = panes.tabs(conv).find((x) => x.kind === 'terminal' && x.term === termId);
    if (t) { panes.activate(conv, t.id); return; }
    const g = panes.get(conv).groups.find((x) => x.tabs.some((y) => y.kind === 'terminal'));
    panes.addTab(conv, 'terminal', g?.id);
    const fresh = panes.tabs(conv).filter((x) => x.kind === 'terminal' && !x.term).at(-1);
    if (fresh) panes.setTab(conv, fresh.id, { term: termId });
  }
  const tools = $derived<[Kind, string, string][]>([
    ['files', 'folder', 'Files'], ['changes', 'diff', 'Changes'],
    ...(conn.canTerminal ? [['terminal', 'prompt', 'Terminal  ⌃`'] as [Kind, string, string]] : []),
    ['browser', 'globe', 'Browser'],
  ]);
  function key(e: KeyboardEvent) {
    if (e.ctrlKey && !e.metaKey && e.key === '`' && conn.canTerminal) { e.preventDefault(); toggle('terminal'); }
  }
  const machineItems = $derived<Item[]>([
    { id: 'h', header: true, label: 'Machines' },
    ...app.machines.map((x) => ({ id: 'm:' + x.id, label: x.name, desc: x.online ? 'Online' : 'Offline', on: x.id === id })),
    { id: 's', sep: true },
    { id: 'all', label: 'All machines', icon: 'projects' },
    { id: 'agents', label: 'Agents and sign-in…', icon: 'key' },
    ...(conn.isOwner ? [{ id: 'access', label: 'Access…', icon: 'lock' }] : []),
  ]);
  function pickMachine(x: string) {
    if (x.startsWith('m:')) router.go(paths.machine(x.slice(2)));
    else if (x === 'all') router.go('/');
    else if (x === 'access') router.go(`/settings/access#${id}`);
    else if (x === 'agents') agentsOpen = true;
  }
  const moreItems = $derived<Item[]>([
    ...tools.filter(() => narrow).map(([k, icon, label]) => ({ id: 't:' + k, label: label.split('  ')[0], icon, on: panes.isOpen(conv, k) })),
    { id: 't:background', label: 'Background tasks', icon: 'activity', on: panes.isOpen(conv, 'background'), kbd: bgCount ? String(bgCount) : undefined },
    { id: 's1', sep: true },
    { id: 'reset', label: 'Reset layout', icon: 'refresh' },
  ]);
  function pickMore(x: string) {
    if (x.startsWith('t:')) toggle(x.slice(2) as Kind);
    else if (x === 'reset') panes.reset(conv);
  }

</script>

<svelte:window onkeydown={key} />

<div class="win">
  {#if !folded}
    <nav class="side" style:width="{sideW}px">
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="sizer" class:on={sizing} title="Drag to resize" onpointerdown={resize} ondblclick={() => (sideW = SIDE)}></div>
      <div class="tb">
        <a class="back" href="/" {@attach tip('All machines')}><Mark size={22} /></a>
        <button class="mname" class:on={!!machineMenu} onclick={(e) => (machineMenu = machineMenu ? null : (e.currentTarget as HTMLElement))}>
          <span class="sdot" class:on={conn.online}></span><span class="cut">{name}</span><Icon name="chevd" size={14} />
        </button>
        <Button icon="sidebar" variant="icon" size="sm" iconSize={18} tip="Hide sidebar" onclick={() => (folded = true)} />
      </div>
      <SessionList {conn} current={session} onopen={openSession} onnew={() => (newOpen = true)} />
      <div class="foot">
        <span class="who cut">{app.user ? app.user.username : ''} · <span class="role">{conn.role}</span></span>
        <Button icon="gear" variant="icon" size="sm" iconSize={18} tip="Settings" onclick={() => router.go('/settings')} />
      </div>
    </nav>
  {/if}
  <main>
    {#if conn.fatal}
      <EmptyState icon="lock" text={conn.fatal} action={{ label: 'All machines', primary: false, run: () => router.go('/') }} />
    {:else}
      {#if conn.ready && !conn.online}
        <div class="banner"><span class="ic"><Icon name="warning" size={15} /></span><span>{name} is offline{m?.lastSeen ? ` (seen ${ago(m.lastSeen, app.now)})` : ''}. Its history is here to read; the rest waits until it’s back.</span></div>
      {:else if !conn.connected && conn.ready}
        <div class="banner"><span class="spinner"></span><span>Reconnecting…</span><Button size="sm" variant="quiet" onclick={() => conn.reconnect()}>Retry</Button></div>
      {/if}
      <div class="screen">
        <PaneHost {conv}>
          {#snippet chat()}
            <div class="chat" bind:clientWidth={chatW}>
              <!-- (No chat open: no bar, only a way back to a folded sidebar. The machine's own actions are in its menu.) -->
              {#if session || folded}
              <div class="bar">
                {#if folded}<Button icon="sidebar" variant="icon" size="sm" iconSize={18} tip="Show sidebar" onclick={() => (folded = false)} />{/if}
                {#if row}
                  <HarnessMark harness={row.harness} size={22} />
                  <span class="ttl">{#if naming !== null}<span class="namew" data-v={naming || 'Untitled session'}><input class="tt name" size="1" bind:value={naming} placeholder="Untitled session" aria-label="Session title" {@attach focusAll}
                    onblur={saveName} onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void saveName(); } else if (e.key === 'Escape') { e.stopPropagation(); naming = null; } }} /></span>
                    {:else}<button class="tt cut nameb" disabled={!conn.canOperate} onclick={startNaming} {@attach tip(conn.canOperate ? 'Rename' : '')}>{row.title || 'Untitled session'}</button>{/if}<span class="cwd" {@attach tip(row.cwd)}><span class="in" dir="ltr">{tilde(row.cwd, conn.info?.home)}</span></span></span>
                  {#if row.state === 'running'}<span class="state"><span class="sdot run"></span>Working</span>{/if}
                {/if}
                <span class="sp"></span>
                {#if session && !narrow}
                  <span class="tools">
                    {#each tools as [kind, icon, label] (kind)}<Button {icon} variant="icon" on={panes.isOpen(conv, kind)} tip={label} onclick={() => toggle(kind)} />{/each}
                  </span>
                {/if}
                {#if session}
                  <span class="counted">
                    <Button icon="more" variant="icon" tip="More" on={!!moreMenu} onclick={(e) => (moreMenu = moreMenu ? null : (e.currentTarget as HTMLElement))} />
                    {#if bgCount}<span class="badge" aria-hidden="true" {@attach tip(`${bgCount} background ${bgCount === 1 ? 'task' : 'tasks'}`)}>{badge(bgCount)}</span>{/if}
                  </span>
                {/if}
              </div>
              {/if}
              {#if session}
                {#key session}<SessionChat {conn} sessionId={session} />{/key}
              {:else}
                <!-- (No chat open: nothing here. New session is in the sidebar, the agents in ⋯.) -->
                <div class="home"></div>
              {/if}
            </div>
          {/snippet}
          {#snippet card(g)}
            <PaneCard {conv} {g} {conn}>
              {#snippet body(tab, active)}
                {#if tab.kind === 'files'}<FilesCard {conn} cwd={row?.cwd ?? null} />
                {:else if tab.kind === 'changes'}<ChangesCard {conn} cwd={row?.cwd ?? null} {stamp} />
                {:else if tab.kind === 'terminal'}<TerminalCard {conn} {conv} {tab} cwd={row?.cwd ?? null} {active} />
                {:else if tab.kind === 'browser'}<BrowserCard {conn} {conv} {tab} {session} />
                {:else if tab.kind === 'background'}<BackgroundCard {conn} onterminal={showTerminal} onsession={openSession} />{/if}
              {/snippet}
            </PaneCard>
          {/snippet}
        </PaneHost>
      </div>
    {/if}
  </main>
</div>

{#if agentsOpen}
  <Sheet title="Agents on {name}" width={480} onclose={() => (agentsOpen = false)}>
    <Harnesses {conn} onlogin={signIn} />
  </Sheet>
{/if}
{#if newOpen}<NewSession {conn} cwd={row?.cwd ?? ''} onclose={() => (newOpen = false)} onstarted={(s) => openSession(s.sessionId)} />{/if}
{#if machineMenu}<Menu anchor={machineMenu} width={260} items={machineItems} onpick={pickMachine} onclose={() => (machineMenu = null)} label="Machines" />{/if}
{#if moreMenu}<Menu anchor={moreMenu} end width={240} items={moreItems} onpick={pickMore} onclose={() => (moreMenu = null)} label="More" />{/if}

<style>
  .win { display: flex; height: 100%; background: var(--content); }
  .side { position: relative; width: 272px; flex: none; display: flex; flex-direction: column; height: 100%; background: var(--ground); box-shadow: inset calc(-1 * var(--hairline)) 0 0 var(--hair); }
  .sizer { position: absolute; top: 0; bottom: 0; right: -3px; width: 6px; cursor: col-resize; z-index: 5; touch-action: none; }
  .sizer::after { content: ''; position: absolute; top: 0; bottom: 0; left: 2px; width: 2px; background: var(--accent); opacity: 0; transition: opacity var(--t-fast) ease-out; }
  .sizer:hover::after, .sizer.on::after { opacity: 0.6; }
  .tb { height: var(--titlebar); flex: none; display: flex; align-items: center; gap: var(--sp-1); padding: 0 var(--sp-2) 0 var(--nav-inset); }
  .back { display: inline-flex; padding: var(--sp-1); border-radius: var(--r-md); }
  .back:hover { background: var(--hover); }
  .mname { flex: 0 1 auto; margin-right: auto; min-width: 0; display: inline-flex; align-items: center; gap: var(--sp-2); height: 32px; padding: 0 var(--sp-2); border-radius: var(--r-md); font-weight: var(--w-head); }
  .mname:hover, .mname.on { background: var(--hover); }
  .mname span.cut { min-width: 0; white-space: nowrap; overflow: hidden; }
  .mname :global(svg) { color: var(--muted); flex: none; }
  .foot { display: flex; align-items: center; gap: var(--sp-1); height: 48px; padding: 0 var(--sp-2) 0 calc(var(--nav-inset) + var(--sp-2)); box-shadow: inset 0 var(--hairline) 0 var(--hair); flex: none; }
  .who { flex: 1; min-width: 0; color: var(--ink2); font-size: var(--fs-quiet); white-space: nowrap; overflow: hidden; }
  .role { color: var(--muted); text-transform: capitalize; }
  main { flex: 1; min-width: 0; height: 100%; display: flex; flex-direction: column; }
  .screen { flex: 1; min-height: 0; display: flex; padding-top: var(--sp-2); }
  .chat { flex: 1; min-width: 0; display: flex; flex-direction: column; container: chat / inline-size; }
  /* (The full title row, the sidebar's height from the window's top: its contents centred in the band above the
     line, level with the sidebar's, rather than set below the cards' 8px gap.) */
  .bar { height: var(--titlebar); margin-top: calc(-1 * var(--sp-2)); flex: none; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-2) 0 var(--sp-5); }
  .ttl { display: flex; align-items: baseline; gap: var(--sp-2); min-width: 0; }
  .tt { font-size: var(--fs-title); font-weight: 500; white-space: nowrap; overflow: hidden; min-width: 0; flex: 0 1 auto; }
  .nameb { color: var(--ink); text-align: left; padding: 2px 6px; margin: -2px -6px; border-radius: var(--r-sm); }
  .nameb:not(:disabled):hover { background: var(--hover); }
  .nameb:disabled { cursor: default; }
  /* (The field is as wide as its text: a hidden copy of the text in the same grid cell sets the width.) */
  .namew { display: inline-grid; min-width: 0; max-width: min(560px, 55vw); margin: -3px -8px; }
  .namew::after { content: attr(data-v) ' '; grid-area: 1 / 1; visibility: hidden; white-space: pre; overflow: hidden; font-size: var(--fs-title); font-weight: 500; padding: 3px 8px; }
  .name { grid-area: 1 / 1; width: 100%; min-width: 0; padding: 3px 8px; border: 0; outline: 0; border-radius: 8px; background: var(--content); color: var(--ink);
    font-family: inherit; box-shadow: 0 0 0 1.5px var(--link, #3b82f6), 0 0 0 4px color-mix(in srgb, var(--link, #3b82f6) 22%, transparent); }
  .cwd { color: var(--muted); font-size: var(--fs-small); font-family: var(--mono); white-space: nowrap; overflow: hidden; min-width: 40px; flex: 0 1 auto; direction: rtl; text-align: left; text-overflow: ellipsis; }
  .cwd .in { unicode-bidi: isolate; }
  .state { display: inline-flex; align-items: center; gap: var(--sp-1h); color: var(--ink2); font-size: var(--fs-small); flex: none; }
  .sp { flex: 1; }
  .tools { display: inline-flex; align-items: center; gap: var(--sp-0h); }
  .counted { position: relative; display: inline-flex; }
  .counted .badge { position: absolute; top: -2px; right: -4px; pointer-events: none; box-shadow: 0 0 0 2px var(--content); }
  .home { flex: 1; min-height: 0; }
</style>
