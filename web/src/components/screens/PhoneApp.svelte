<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The phone (a window 700 wide or less), drawn as the Claude app: one screen with round floating buttons at the top
  // (☰ at the left; a session's title beside it and its ⋯ at the right), and a drawer under ☰ (or a swipe from the
  // left edge): CodeRail and search, the computers, Needs you, Recents (the sessions of every computer, newest
  // first), and at the foot You and New session. With no computer chosen, the home screen: a greeting and a composer
  // that starts a session on the computer its pill names. Pickers are bottom sheets (ui/PhoneSheet); a tool (Files,
  // Changes, Terminal, Browser, Background) is a full-screen sheet over the session, from ⋯. The routes are the
  // desktop's: /m/:id, /m/:id/s/:sid.
  import { openSignInTab } from '../../lib/signin';
  import { setOpenLink } from '../../lib/links';
  import { fly } from 'svelte/transition';
  import WivaBadge from '../WivaBadge.svelte';
  import { ease, ms } from '../../lib/motion';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { router, paths } from '../../lib/router.svelte';
  import { panes, TITLE, GLYPH, type Kind } from '../../lib/panes.svelte';
  import { savedTheme, setTheme, type Theme } from '../../lib/theme';
  import { badge, ago } from '../../lib/format';
  import { kept, keep } from '../../lib/kept';
  import { tilde, osName } from '../../lib/machineText';
  import { approvalText } from '../../lib/approval';
  import Icon from '../Icon.svelte';
  import Mark from '../Mark.svelte';
  import HarnessMark from '../HarnessMark.svelte';
  import Menu, { type Item } from '../ui/Menu.svelte';
  import PhoneSheet from '../ui/PhoneSheet.svelte';
  import SegmentedControl from '../ui/SegmentedControl.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import CardLoad from '../CardLoad.svelte';
  import SessionList from '../machine/SessionList.svelte';
  import NewSession from '../machine/NewSession.svelte';
  import SessionChat from '../chat/SessionChat.svelte';
  import Approval from '../chat/Approval.svelte';
  import FilesCard from '../panes/FilesCard.svelte';
  import ChangesCard from '../panes/ChangesCard.svelte';
  import TerminalCard from '../panes/TerminalCard.svelte';
  import BrowserCard from '../panes/BrowserCard.svelte';
  import BackgroundCard from '../panes/BackgroundCard.svelte';
  import Harnesses from '../machine/Harnesses.svelte';
  import type { HarnessInfo, SessionRow } from '@coderail/protocol';
  let { machine = null, session = null }: { machine?: string | null; session?: string | null } = $props();
  type Page = 'home' | 'needs' | 'you';
  let page = $state<Page>('home');
  const conn = $derived(machine ? app.conn(machine) : null);
  /** Waiting approvals and agents' background tasks: the ⋯ badge and the Background tasks count. */
  const bg = $derived(conn ? conn.approvals.length + conn.tasks.length : 0);
  const m = $derived(machine ? app.machine(machine) : undefined);
  const row = $derived(conn && session ? conn.session(session) ?? conn.view(session).row : null);
  let sheet = $state<Kind | null>(null);
  let newOpen = $state(false);
  let drawer = $state(false);
  $effect(() => { void machine; void session; sheet = null; drawer = false; });
  const pconv = $derived(machine ? `phone:${machine}` : '');
  /** The sheet's tab (a terminal or browser keeps its own across openings). */
  let sheetTabId = $state<string | null>(null);
  const sheetTab = $derived.by(() => {
    if (!sheet || !pconv) return null;
    const all = panes.tabs(pconv);
    return all.find((t) => t.id === sheetTabId && t.kind === sheet) ?? all.find((t) => t.kind === sheet && !t.login) ?? all.find((t) => t.kind === sheet) ?? null;
  });
  function openSheet(k: Kind) {
    sheetTabId = null;
    if (!panes.tabs(pconv).some((t) => t.kind === k && !t.login)) panes.addTab(pconv, k);
    sheet = k;
  }
  // (A link clicked in the chat opens in its browser sheet.)
  setOpenLink((url) => {
    if (!session || !pconv || !conn?.canAct) return false; // (a viewer, or the computer offline)
    openSheet('browser');
    const t = panes.tabs(pconv).find((x) => x.kind === 'browser' && !x.login);
    if (t) panes.setTab(pconv, t.id, { open: url });
    return !!t;
  });
  /** A harness's sign-in in a terminal sheet of its own. */
  function signIn(h: HarnessInfo) {
    if (machine) openSignInTab(machine, h.id);
    const old = panes.tabs(pconv).find((x) => x.kind === 'terminal' && x.login && x.sub === h.id);
    if (old) { if (old.term) conn?.call('term.close', { id: old.term }).catch(() => {}); panes.closeTab(pconv, old.id); }
    panes.addTab(pconv, 'terminal', undefined, h.id);
    const fresh = panes.tabs(pconv).filter((x) => x.kind === 'terminal' && x.sub === h.id && !x.term && !x.login).at(-1);
    if (!fresh) return;
    panes.setTab(pconv, fresh.id, { login: true, title: `${h.name} sign-in` });
    sheetTabId = fresh.id;
    sheet = 'terminal';
  }
  const online = $derived(app.machines.filter((x) => x.online));
  const needs = $derived(online.flatMap((x) => app.conn(x.id).approvals.map((a) => ({ a, mid: x.id, name: x.name }))));
  const sorted = $derived([...app.machines].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)));
  let theme = $state<Theme>(savedTheme());
  const titleOf = (s: SessionRow) => s.title?.trim() || 'Untitled session';

  // ---- The drawer
  let q = $state('');
  let searching = $state(false);
  const recents = $derived(online
    .flatMap((x) => app.conn(x.id).sessions.map((s) => ({ s, mid: x.id, conn: app.conn(x.id) })))
    .filter((r) => !q.trim() || titleOf(r.s).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.s.updatedAt - a.s.updatedAt)
    .slice(0, 40));
  function go(to: string) { drawer = false; router.go(to); }
  function goPage(p: Page) { page = p; drawer = false; if (machine) router.go('/'); }
  /** New session: on the computer in view, else the home pill's. */
  function startNew() {
    drawer = false;
    if (machine && conn?.canAct) { newOpen = true; return; }
    if (!homeMachine) { app.toast('No computer is online', 'warning'); return; }
    newFor = homeMachine; firstPrompt = '';
  }
  // ---- swipe from the left edge opens the drawer; a swipe left closes it
  let drag = $state(0);
  let from: number | null = null;
  const W = () => Math.min(window.innerWidth * 0.78, 340);
  function down(e: PointerEvent) {
    if (e.pointerType === 'mouse' || sheet) return;
    if (drawer || e.clientX < 24) { from = e.clientX; }
  }
  function move(e: PointerEvent) { if (from !== null) drag = drawer ? Math.min(0, e.clientX - from) : Math.max(0, Math.min(W(), e.clientX - from)); }
  function up() {
    if (from === null) return;
    if (drawer ? drag < -60 : drag > 60) drawer = !drawer;
    from = null; drag = 0;
  }
  const slide = (node: Element) => fly(node, { x: window.innerWidth, duration: ms.sheet, easing: ease.base, opacity: 1 });

  // ---- ⋯
  let more = $state<HTMLElement | null>(null);
  const TOOLS = $derived<Kind[]>(conn?.canTerminal ? ['files', 'changes', 'terminal', 'browser', 'background'] : ['files', 'changes', 'browser', 'background']);
  const moreItems = $derived<Item[]>([
    ...TOOLS.map((k) => ({ id: k, label: k === 'background' ? `Background tasks${bg ? ` (${bg})` : ''}` : TITLE[k], icon: GLYPH[k] })),
    ...(session ? [{ id: 's', sep: true }, { id: 'sessions', label: `All sessions on ${m?.name ?? 'this computer'}`, icon: 'stack' }, ...(row?.cwd ? [{ id: 'copy', label: 'Copy folder path', icon: 'copy' }] : [])] : []),
  ]);
  function pickMore(id: string) {
    if (id === 'sessions' && machine) router.go(paths.machine(machine));
    else if (id === 'copy' && row?.cwd) navigator.clipboard.writeText(row.cwd).then(() => app.toast('Copied'), () => {});
    else openSheet(id as Kind);
  }
  const modeName = $derived.by(() => {
    if (!row) return '';
    const opt = ((row.configOptions ?? []) as any[]).find((o) => o.category === 'mode');
    if (opt) {
      const all = ((opt.options ?? []) as any[]).flatMap((x) => (Array.isArray(x.options) ? x.options : [x]));
      return all.find((x) => String(x.value) === String(opt.currentValue))?.name ?? '';
    }
    return ((row.modes?.availableModes ?? []) as any[]).find((x) => x.id === row.modes?.currentModeId)?.name ?? '';
  });

  // ---- Home: a greeting and a composer that starts a session
  const KEY = 'coderail.phone.machine';
  let picked = $state<string>(kept(KEY, ''));
  const homeMachine = $derived(online.find((x) => x.id === picked)?.id ?? online[0]?.id ?? null);
  let draft = $state('');
  let choosing = $state(false);
  let newFor = $state<string | null>(null);
  let firstPrompt = '';
  const hour = new Date().getHours();
  const greeting = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  function begin() {
    if (!homeMachine || !draft.trim()) return;
    firstPrompt = draft.trim();
    newFor = homeMachine;
  }
  async function started(mid: string, s: SessionRow) {
    router.go(paths.machine(mid, s.sessionId));
    const text = firstPrompt;
    firstPrompt = '';
    if (!text) return;
    draft = '';
    try { await app.conn(mid).call('agent.prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text }] }, 30_000); }
    catch (e) { app.toast(plainError(e), 'warning'); }
  }
  function grow(e: Event) { const t = e.currentTarget as HTMLTextAreaElement; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 200) + 'px'; }
</script>

{#snippet top(title: string, sub?: string, tools = false)}
  <div class="top">
    <button class="round" onclick={() => (drawer = true)} aria-label="Menu" aria-expanded={drawer}><Icon name="menu" size={22} stroke={1.7} /></button>
    <span class="tt">{#if title}<span class="t1 cut">{title}</span>{/if}{#if sub}<span class="t2 cut">{sub}</span>{/if}</span>
    {#if tools}
      <span class="capsule">
        {#if row?.state === 'running'}<span class="cap"><span class="spinner"></span></span>{/if}
        <button class="cap" onclick={(e) => (more = more ? null : (e.currentTarget as HTMLElement))} aria-label="More" aria-haspopup="menu">
          <Icon name="more" size={22} stroke={2} />{#if bg}<span class="badge nb">{bg}</span>{/if}
        </button>
      </span>
    {:else if !machine && page === 'home'}
      <button class="round" onclick={() => goPage('needs')} aria-label="Needs you"><Icon name="hand" size={21} stroke={1.6} />{#if needs.length}<span class="badge nb">{badge(needs.length)}</span>{/if}</button>
    {/if}
  </div>
{/snippet}

<div class="phone-app" class:open={drawer} style="--dw:{drawer ? 'var(--drawer)' : '0px'};--drag:{drag}px" onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={up}>
  <aside class="drawer" aria-label="Menu" inert={!drawer}>
    <div class="dh">
      <span class="brand">CodeRail</span>
      <button class="round" onclick={() => { searching = !searching; if (!searching) q = ''; }} aria-label="Search"><Icon name="search" size={21} stroke={1.7} /></button>
    </div>
    {#if searching}<input class="dsearch" bind:value={q} placeholder="Search sessions" spellcheck="false" />{/if}
    <div class="dlist scroll">
      {#if !searching}
        {#each sorted as x (x.id)}
          <button class="drow" class:sel={machine === x.id && !session} onclick={() => go(paths.machine(x.id))}>
            <span class="di"><Icon name="mac" size={22} stroke={1.5} /><span class="sdot" class:on={x.online}></span></span><span class="cut">{x.name}</span>
            {#if !x.online}<span class="dv">{x.lastSeen ? ago(x.lastSeen, app.now) : 'offline'}</span>{/if}
          </button>
        {/each}
        <button class="drow" class:sel={!machine && page === 'needs'} onclick={() => goPage('needs')}>
          <span class="di"><Icon name="hand" size={22} stroke={1.5} /></span><span>Needs you</span>{#if needs.length}<span class="badge">{badge(needs.length)}</span>{/if}
        </button>
        <button class="drow" class:sel={!machine && page === 'you'} onclick={() => goPage('you')}>
          <span class="di"><Icon name="gear" size={22} stroke={1.5} /></span><span>Settings</span>
        </button>
      {/if}
      {#if recents.length}<div class="dlabel">Recents</div>{/if}
      {#each recents as r (r.mid + r.s.sessionId)}
        {@const pend = r.conn.approvals.some((a) => a.sessionId === r.s.sessionId)}
        <button class="drow rec" class:sel={session === r.s.sessionId} onclick={() => go(paths.machine(r.mid, r.s.sessionId))}>
          <span class="di"><HarnessMark harness={r.s.harness} size={20} bare /></span><span class="cut">{titleOf(r.s)}</span>
          {#if pend}<span class="bdot" aria-label="Needs you"></span>{:else if r.s.state === 'running'}<span class="spinner small" aria-label="Working"></span>{/if}
        </button>
      {/each}
      {#if searching && !recents.length}<p class="dnone">No sessions match</p>{/if}
    </div>
    <div class="df">
      <button class="av" onclick={() => goPage('you')} aria-label="You">{app.user ? app.user.username[0]?.toUpperCase() : ''}</button>
      <button class="newbtn" onclick={startNew}><Icon name="plus" size={18} stroke={2} />New session</button>
    </div>
  </aside>

  <div class="main">
    {#if !machine}
      {#if page === 'home'}
        <div class="screen">
          {@render top('')}
          <div class="hello">
            <Mark size={44} />
            <h1>{greeting}{app.user ? `, ${app.user.username}` : ''}</h1>
            {#if !app.machinesLoaded}<CardLoad retry={() => app.loadMachines()} />
            {:else if !app.machines.length}
              <p class="hint">No computers yet. Install CodeRail Bridge on one from a computer's browser.</p>
            {:else if !online.length}<p class="hint">No computer is online.</p>{/if}
          </div>
          {#if homeMachine}
            {@const hm = app.machine(homeMachine)}
            <div class="hfoot">
              <div class="hcomp">
                <textarea rows="1" bind:value={draft} oninput={grow} placeholder="Start a session on {hm?.name ?? 'your computer'}" aria-label="First message"></textarea>
                <div class="hbar">
                  <button class="hpill" onclick={() => (choosing = true)}><Icon name="mac" size={17} stroke={1.6} /><span class="cut">{hm?.name}</span></button>
                  <span class="sp"></span>
                  <button class="hsend" disabled={!draft.trim()} onclick={begin} aria-label="Start"><Icon name="send" size={18} stroke={2.2} /></button>
                </div>
              </div>
            </div>
          {/if}
        </div>
      {:else if page === 'needs'}
        <div class="screen">
          {@render top('Needs you')}
          <div class="scroll page">
            {#if !needs.length}<EmptyState icon="inbox" text="Nothing waiting" tip="Approvals your agents ask for show here" />{/if}
            {#each needs as n (n.a.id)}
              {@const s = app.conn(n.mid).session(n.a.sessionId)}
              <div class="need">
                <a class="nh" href={paths.machine(n.mid, n.a.sessionId)}><HarnessMark harness={n.a.harness} size={18} bare /><span class="cut">{n.name} · {s?.title || approvalText(n.a).title}</span><Icon name="chevr" size={14} /></a>
                <Approval a={n.a} conn={app.conn(n.mid)} />
              </div>
            {/each}
          </div>
        </div>
      {:else}
        <div class="screen">
          {@render top('You')}
          <div class="scroll page">
            <div class="card me"><span class="avl">{app.user ? app.user.username[0]?.toUpperCase() : ''}</span><div class="mm2"><div class="t">{app.user ? app.user.username : ''}</div><div class="s">{app.user && app.user.isAdmin ? 'Admin' : 'Member'}</div></div></div>
            <div class="label">Appearance</div>
            <div class="card pad"><SegmentedControl full label="Appearance" value={theme} onchange={(v) => { theme = v as Theme; setTheme(theme); }} options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} /></div>
            <div class="label">More</div>
            <div class="card">
              <a class="kv" href="/settings/notifications"><span>Notifications</span><Icon name="chevr" size={16} /></a>
              <a class="kv" href="/settings/access"><span>Machine access</span><Icon name="chevr" size={16} /></a>
              <a class="kv" href="/settings"><span>Settings</span><Icon name="chevr" size={16} /></a>
            </div>
            <button class="card signout" onclick={() => app.signOut()}>Sign out</button>
            <div class="built"><WivaBadge /></div>
          </div>
        </div>
      {/if}
    {:else if conn}
      <div class="screen">
        {#if session}
          {@render top(row?.title || 'Session', row ? [tilde(row.cwd, conn.info?.home), modeName].filter(Boolean).join(' · ') : '', true)}
          {#if conn.ready && !conn.online}<div class="banner"><span class="ic"><Icon name="warning" size={15} /></span>Offline: read only</div>{/if}
          <div class="chat">{#key session}<SessionChat {conn} sessionId={session} />{/key}</div>
        {:else}
          {@render top(m?.name ?? 'Computer', m?.info ? `${m.info.hostname} · ${osName(m.info.os)}` : conn.online ? '' : 'Offline', true)}
          {#if conn.fatal}<EmptyState icon="lock" text={conn.fatal} />
          {:else}
            {#if conn.ready && !conn.online}<div class="banner"><span class="ic"><Icon name="warning" size={15} /></span>Offline: history only</div>{/if}
            {#key machine}<SessionList {conn} phone current={session} onopen={(sid) => router.go(paths.machine(machine!, sid))} onnew={() => (newOpen = true)} />{/key}
          {/if}
        {/if}
      </div>
    {/if}
    {#if drawer}<button class="shade" onclick={() => (drawer = false)} aria-label="Close menu"></button>{/if}
  </div>

  {#if conn && sheet && sheetTab}
    <div class="pushed sheet" transition:slide>
      <div class="top">
        <button class="round" onclick={() => (sheet = null)} aria-label="Back"><Icon name="chevl" size={22} stroke={1.8} /></button>
        <span class="tt center"><span class="t1 cut">{sheetTab?.login ? sheetTab.title : TITLE[sheet]}</span></span>
        <span class="round ghost" aria-hidden="true"></span>
      </div>
      <div class="host">
        {#if sheet === 'files'}<FilesCard {conn} cwd={row?.cwd ?? null} />
        {:else if sheet === 'changes'}<ChangesCard {conn} cwd={row?.cwd ?? null} stamp={row?.updatedAt ?? 0} />
        {:else if sheet === 'terminal'}<TerminalCard {conn} conv={pconv} tab={sheetTab} cwd={row?.cwd ?? null} />
        {:else if sheet === 'browser'}<BrowserCard {conn} conv={pconv} tab={sheetTab} {session} />
        {:else if sheet === 'background'}
          <div class="agents"><div class="alabel">Agents</div><Harnesses {conn} onlogin={signIn} /></div>
          <BackgroundCard {conn} phone onterminal={(id) => { const t = panes.tabs(pconv).find((x) => x.kind === 'terminal' && !x.login); if (t) panes.setTab(pconv, t.id, { term: id }); else { panes.show(pconv, 'terminal'); const n = panes.tabs(pconv).find((x) => x.kind === 'terminal'); if (n) panes.setTab(pconv, n.id, { term: id }); } openSheet('terminal'); }}
            onsession={(sid) => { sheet = null; router.go(paths.machine(machine!, sid)); }} />
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if more}<Menu items={moreItems} anchor={more} end width={290} label="More" onpick={pickMore} onclose={() => (more = null)} />{/if}
{#if conn && newOpen}<NewSession {conn} cwd={row?.cwd ?? ''} onclose={() => (newOpen = false)} onstarted={(s) => router.go(paths.machine(machine!, s.sessionId))} />{/if}
{#each newFor ? [newFor] : [] as mid (mid)}
  <NewSession conn={app.conn(mid)} onclose={() => (newFor = null)} onstarted={(s) => started(mid, s)} />
{/each}
{#if choosing}
  <PhoneSheet title="Computer" onclose={() => (choosing = false)}
    groups={[sorted.map((x) => ({ id: x.id, label: x.name, desc: x.online ? (x.info ? `${x.info.hostname} · ${osName(x.info.os)}` : 'Online') : 'Offline', icon: 'mac', on: x.id === homeMachine, disabled: !x.online }))]}
    onpick={(id) => { picked = id; keep(KEY, id); choosing = false; }} />
{/if}

<style>
  .phone-app { --drawer: min(78vw, 340px); position: relative; height: 100%; width: 100%; overflow: hidden; background: var(--dbg); touch-action: pan-y;
    --dbg: color-mix(in srgb, var(--ink) 4%, var(--content)); }
  /* The drawer under the screen, which slides right to show it (rounded, with a shadow, as the Claude app). */
  .drawer { position: absolute; inset: 0 auto 0 0; width: var(--drawer); display: flex; flex-direction: column; padding: var(--safe-t) 0 max(var(--safe-b), var(--sp-3)) var(--safe-l); }
  .main { position: absolute; inset: 0; background: var(--content); transform: translateX(calc(var(--dw) + var(--drag))); transition: transform 320ms var(--ease-base), border-radius 320ms var(--ease-base);
    will-change: transform; overflow: hidden; }
  .open .main { border-radius: 40px; box-shadow: -8px 0 40px rgba(0, 0, 0, 0.12); }
  .phone-app:active .main { transition-duration: 0ms; }
  .shade { position: absolute; inset: 0; z-index: calc(var(--z-chrome) + 2); background: transparent; }
  .dh { display: flex; align-items: center; justify-content: space-between; padding: var(--sp-3) var(--sp-4) var(--sp-3) var(--sp-5); }
  .brand { font: 500 30px/1.1 var(--serif); letter-spacing: -0.4px; color: var(--ink); }
  .dsearch { margin: 0 var(--sp-4) var(--sp-2); height: 40px; padding: 0 var(--sp-4); border-radius: 20px; border: 0; background: var(--panel); font-size: 16px; color: var(--ink); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); outline: none; }
  .dlist { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--sp-3) var(--sp-4); }
  .drow { display: flex; align-items: center; gap: var(--sp-4); width: 100%; min-height: 52px; padding: 0 var(--sp-2); border-radius: 14px; font-size: 17px; color: var(--ink); text-align: left; }
  .drow:active, .drow.sel { background: color-mix(in srgb, var(--ink) 6%, transparent); }
  .drow .cut { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .drow.rec { min-height: 50px; }
  .di { position: relative; display: inline-flex; flex: none; width: 24px; justify-content: center; color: var(--ink2); }
  .di .sdot { position: absolute; right: -4px; bottom: -2px; width: 9px; height: 9px; box-shadow: 0 0 0 2px var(--dbg); }
  .dv { color: var(--muted); font-size: 14px; flex: none; }
  .dlabel { color: var(--muted); font-size: 15px; padding: var(--sp-5) var(--sp-2) var(--sp-2); }
  .bdot { width: 10px; height: 10px; border-radius: 50%; background: var(--link, #3b82f6); flex: none; margin-right: var(--sp-1); }
  .spinner.small { width: 14px; height: 14px; flex: none; margin-right: var(--sp-1); }
  .dnone { color: var(--muted); padding: var(--sp-4) var(--sp-2); }
  .df { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); padding: var(--sp-2) var(--sp-4) 0; flex: none; }
  .av { width: 50px; height: 50px; border-radius: 50%; background: var(--panel); color: var(--ink); font-size: 18px; font-weight: var(--w-strong); box-shadow: inset 0 0 0 var(--hairline) var(--hair2), 0 2px 8px rgba(0, 0, 0, 0.06); flex: none; }
  .newbtn { display: inline-flex; align-items: center; gap: var(--sp-2); height: 50px; padding: 0 var(--sp-6); border-radius: 25px; background: var(--primary); color: var(--onprimary); font-size: 17px; font-weight: var(--w-control); }
  .newbtn:active, .av:active { transform: scale(0.96); }

  .screen { position: absolute; inset: 0; display: flex; flex-direction: column; padding-top: var(--safe-t); }
  /* The top: round floating buttons, the title beside ☰, a capsule at the right. */
  .top { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2) calc(var(--sp-4) + var(--safe-r)) var(--sp-2) calc(var(--sp-4) + var(--safe-l)); flex: none; position: relative; z-index: var(--z-chrome); }
  .screen > .top:has(.capsule) { background: color-mix(in srgb, var(--content) 86%, transparent); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px); box-shadow: 0 var(--hairline) 0 var(--hair); }
  .round { position: relative; width: 46px; height: 46px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; color: var(--ink);
    background: var(--panel); box-shadow: inset 0 0 0 var(--hairline) var(--hair2), 0 2px 10px rgba(0, 0, 0, 0.07); }
  .round.ghost { visibility: hidden; }
  .round:active, .cap:active { transform: scale(0.94); }
  .tt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .tt.center { align-items: center; }
  .t1 { font-size: 17px; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .t2 { font-size: 14px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
  .capsule { display: inline-flex; align-items: center; height: 46px; padding: 0 var(--sp-1); border-radius: 23px; flex: none; background: var(--panel); box-shadow: inset 0 0 0 var(--hairline) var(--hair2), 0 2px 10px rgba(0, 0, 0, 0.07); }
  .cap { position: relative; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; color: var(--ink); border-radius: 20px; }
  .cap .spinner { width: 20px; height: 20px; }
  .badge.nb { position: absolute; top: -3px; right: -3px; pointer-events: none; box-shadow: 0 0 0 2px var(--panel); background: var(--warn); }
  .capsule .badge.nb { top: -6px; right: -8px; }

  .hello { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-4); padding: 0 var(--sp-6); text-align: center; }
  .hello h1 { margin: 0; font: 400 30px/1.2 var(--serif); letter-spacing: -0.4px; color: var(--ink); }
  .hfoot { flex: none; padding: 0 calc(var(--sp-4) + var(--safe-r)) max(var(--safe-b), var(--sp-3)) calc(var(--sp-4) + var(--safe-l)); }
  .hcomp { border-radius: 30px; background: var(--panel); box-shadow: inset 0 0 0 var(--hairline) var(--hair2), 0 6px 24px rgba(0, 0, 0, 0.08); }
  .hcomp textarea { display: block; width: 100%; min-height: 52px; padding: 16px var(--sp-5) var(--sp-1); border: 0; outline: 0; background: none; resize: none; font: inherit; font-size: 17px; line-height: 24px; color: var(--ink); }
  .hcomp textarea::placeholder { color: var(--muted); }
  .hbar { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-3) var(--sp-3); }
  .hpill { display: inline-flex; align-items: center; gap: var(--sp-2); min-width: 0; height: 40px; padding: 0 var(--sp-4); border-radius: 20px; background: var(--tint); color: var(--ink); font-size: 15px; }
  .hsend { width: 40px; height: 40px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--primary); color: var(--onprimary); transition: opacity var(--t-quick); }
  .hsend:disabled { opacity: 0.2; }
  .sp { flex: 1; }
  .hint { color: var(--muted); font-size: 14px; margin: 0; line-height: 1.5; max-width: 32em; }

  .page { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-2) calc(var(--gutter) + var(--safe-r)) var(--sp-8) calc(var(--gutter) + var(--safe-l)); display: flex; flex-direction: column; }
  .need { padding: var(--sp-2) 0 var(--sp-3); box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair); }
  .nh { display: flex; align-items: center; gap: var(--sp-2); color: var(--muted); font-size: 14px; text-decoration: none; }
  .label { margin: var(--section-gap) var(--sp-1) var(--section-title); color: var(--muted); font-size: 13px; font-weight: var(--w-control); }
  .card { display: block; width: 100%; border: 0; border-radius: var(--r-card); background: var(--panel); box-shadow: inset 0 0 0 var(--hairline) var(--hair); text-align: left; }
  .card.pad { padding: var(--sp-2); }
  .me { display: flex; align-items: center; gap: var(--sp-3); padding: var(--gutter); }
  .avl { width: 48px; height: 48px; border-radius: 50%; background: var(--p4-bg); color: var(--p4-fg); display: inline-flex; align-items: center; justify-content: center; font-size: 20px; font-weight: var(--w-strong); }
  .mm2 .t { font-size: 18px; font-weight: var(--w-head); }
  .mm2 .s { color: var(--muted); font-size: 14px; }
  .kv { display: flex; justify-content: space-between; align-items: center; min-height: 48px; padding: 0 var(--gutter); color: var(--ink); font-size: 16px; text-decoration: none; }
  .kv + .kv { box-shadow: inset 0 var(--hairline) 0 var(--hair); }
  .kv :global(svg) { color: var(--faint); }
  .signout { margin-top: var(--sp-8); min-height: 50px; text-align: center; color: var(--danger-ink); font-size: 16px; font-weight: var(--w-control); }
  .built { display: flex; justify-content: center; margin: var(--sp-8) 0; }

  .pushed { position: absolute; inset: 0; z-index: calc(var(--z-chrome) + 3); display: flex; flex-direction: column; background: var(--content); padding-top: var(--safe-t); box-shadow: var(--shadow-push); will-change: transform; }
  .chat { flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .host { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .agents { padding: var(--sp-3) var(--gutter) 0; }
  .alabel { color: var(--muted); font-size: var(--fs-body); margin-bottom: var(--sp-1); }
  .screen :global(.slist) { padding-top: var(--sp-1); }
</style>
