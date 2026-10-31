<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A terminal on the machine (Forest's TerminalCard): its tab keeps the terminal's id, so a tab moved to another card,
  // or the page opened again, attaches to the same shell (`term.attach`); a new tab opens one in the session's folder
  // (`term.open`). Over it a strip: the folder, who opened it. Ended or failed: a note with New shell / Retry.
  import { untrack } from 'svelte';
  import type { TerminalInfo } from '@coderail/protocol';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { panes, type Tab } from '../../lib/panes.svelte';
  import { plainError } from '../../lib/api';
  import { tilde } from '../../lib/machineText';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  import PathLabel from '../PathLabel.svelte';
  import TermView from '../TermView.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import { sendSignInTab, dropSignInTab } from '../../lib/signin';
  let { conn, conv, tab, cwd = null, active = true }: { conn: MachineConn; conv: string; tab: Tab; cwd?: string | null; active?: boolean } = $props();
  let error = $state<string | null>(null);
  let ended = $state<number | null | undefined>(undefined);
  /** A new shell (Retry, New shell): TermView again, never attached to the last one. */
  let run = $state(0);
  // (Which terminal this view shows; set once a new one opens.)
  let attachTo = $state<string | undefined>(untrack(() => tab.term));
  const info = $derived(conn.terminals.find((t) => t.id === tab.term));
  const where = $derived(info?.cwd ?? cwd ?? '');

  async function opener(cols: number, rows: number) {
    error = null; ended = undefined;
    // (A sign-in tab runs the harness's own login on the machine: `harness.login`, answered like `term.open`.)
    const r = tab.login && tab.sub
      ? await conn.call<TerminalInfo & { scrollback?: string }>('harness.login', { harness: tab.sub, cols, rows })
      : await conn.call<TerminalInfo & { scrollback?: string }>('term.open', { cwd: cwd ?? undefined, cols, rows });
    panes.setTab(conv, tab.id, { term: r.id });
    if (!conn.terminals.some((t) => t.id === r.id)) conn.terminals = [...conn.terminals, r];
    return r;
  }
  function again() { attachTo = undefined; error = null; ended = undefined; run++; }
  // The bridge drops and reconnects within a second or two now and then: a shell asked for in that gap tries again
  // on its own (a few times, a moment apart) before it shows the error and Retry.
  let tries = 0;
  function failed(m: string) {
    if (attachTo) return again();
    if (/offline/i.test(m) && tries < 4) { tries++; setTimeout(again, 1500); return; }
    tries = 0;
    error = plainError(m);
  }

  // A sign-in tab: the link the harness printed (the tab opened on the Sign in click goes there), a box for the code
  // Claude Code asks you to paste back, or the code Codex asks you to enter on its page; then whom it signed in.
  const login = $derived(tab.login ? info?.login ?? null : null);
  const harnessName = $derived(tab.sub === 'codex' ? 'Codex' : 'Claude Code');
  const signedInAs = $derived(tab.sub && conn.auth[tab.sub]?.signedIn !== false ? conn.auth[tab.sub]?.label ?? null : null);
  let sent = $state<string | null>(null);
  $effect(() => { if (login?.url) sendSignInTab(conn.id, login.harness, login.url); });
  /** The sign-in link, only when it is an https page. */
  const signInUrl = $derived.by(() => { try { const u = new URL(login?.url ?? ''); return u.protocol === 'https:' ? u.href : null; } catch { return null; } });
  // A sign-in terminal that ended before printing a link: the tab opened for it would wait forever.
  $effect(() => { if (tab.login && tab.sub && ended !== undefined && !login?.url) dropSignInTab(conn.id, tab.sub); });
  let code = $state('');
  let sending = $state(false);
  async function sendCode(e: SubmitEvent) {
    e.preventDefault();
    const c = code.trim();
    if (!c || !tab.term) return;
    sending = true;
    try {
      await conn.call('term.write', { id: tab.term, data: c + '\r' });
      sent = c; code = '';
    } catch (err) { error = plainError(err); }
    sending = false;
  }
</script>

<div class="term">
  <div class="strip">
    <span class="path"><PathLabel path={tilde(where, conn.info?.home)} /></span>
    <span class="sp"></span>
    {#if tab.login && tab.sub && conn.auth[tab.sub]?.label}<span class="by">Signed in as {conn.auth[tab.sub].label}</span>
    {:else if info?.by}<span class="by">{info.by}</span>{/if}
  </div>
  {#if !conn.ready}
    <div class="host"></div>
  {:else if !conn.canTerminal || (tab.login && !conn.canLogin)}
    <EmptyState compact icon="terminal" text={tab.login ? 'Signing in a harness needs Owner and terminal access' : 'You don’t have terminal access on this computer'} />
  {:else if !conn.online}
    <EmptyState compact icon="terminal" text="The computer is offline" />
  {:else}
    {#if tab.login && (login || signedInAs)}
      <div class="signin">
        {#if signedInAs && (ended === 0 || ended === null)}
          <div class="done"><Icon name="check" size={16} /><span>{harnessName} is signed in as <b>{signedInAs}</b></span></div>
        {:else if login?.url}
          <div class="step"><span class="n">1</span><span class="t">Open the sign-in page and sign in to your account</span>
            <Button size="sm" variant="primary" icon="ext" disabled={!signInUrl} onclick={() => signInUrl && window.open(signInUrl, '_blank', 'noopener')}>Open sign-in page</Button></div>
          {#if login.harness === 'codex'}
            {#if login.code}<div class="step"><span class="n">2</span><span class="t">Enter this code on that page</span><code class="code selectable">{login.code}</code></div>{/if}
          {:else}
            <form class="step" onsubmit={sendCode}><span class="n">2</span>
              <input class="field" placeholder={sent ? 'Code sent. Paste another to retry' : 'Paste the code the page shows you'} bind:value={code} autocomplete="off" spellcheck="false" disabled={sending || ended !== undefined} />
              <Button size="sm" type="submit" busy={sending} disabled={!code.trim() || ended !== undefined}>Sign in</Button></form>
          {/if}
        {:else}
          <div class="step"><span class="spinner"></span><span class="t">Starting {harnessName}’s sign-in…</span></div>
        {/if}
      </div>
    {/if}
    <div class="host">
      {#key run}
        <TermView {conn} term={attachTo} opener={attachTo ? undefined : opener} {active}
          onexit={(c) => (ended = c)} onerror={failed} onopen={() => (tries = 0)} />
      {/key}
    </div>
    {#if error}
      <div class="note bad"><Icon name="warning" size={14} /><span class="why cut">{error}</span><Button size="sm" onclick={again}>Retry</Button></div>
    {:else if ended !== undefined}
      <div class="note"><span>{ended === 0 || ended === null ? 'Ended' : `Ended with ${ended}`}</span><Button size="sm" onclick={again}>{tab.login ? 'Run sign-in again' : 'New shell'}</Button></div>
    {/if}
  {/if}
</div>

<style>
  .term { position: relative; height: 100%; display: flex; flex-direction: column; background: var(--terminal-bg); }
  .strip { display: flex; align-items: center; gap: var(--sp-2); height: var(--row); padding: 0 var(--gutter); flex: none; font-size: var(--fs-small); color: var(--muted); box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair); }
  .path { min-width: 60px; flex: 0 1 auto; overflow: hidden; }
  .sp { flex: 1; }
  .by { flex: none; }
  .host { flex: 1; min-height: 0; }
  .signin { flex: none; display: flex; flex-direction: column; gap: var(--sp-2); padding: var(--sp-3) var(--gutter); background: var(--panel); box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair); font-size: var(--fs-quiet); color: var(--ink); }
  .step { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
  .step .t { flex: 1; min-width: 0; color: var(--ink2); }
  .step .n { flex: none; width: 20px; height: 20px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; background: var(--sel); color: var(--ink2); font-size: 12px; font-weight: 600; }
  .step .field { flex: 1; min-width: 0; height: 30px; font-family: var(--mono); font-size: 13px; }
  .step .code { font: 600 15px/1 var(--mono); letter-spacing: .06em; padding: 6px 10px; border-radius: var(--r-md); background: var(--sel); }
  .done { display: flex; align-items: center; gap: var(--sp-2); color: var(--accent); }
  .done span { color: var(--ink); }
  .note { position: absolute; left: 50%; bottom: var(--gutter); transform: translateX(-50%); display: flex; align-items: center; gap: var(--row-x); max-width: calc(100% - 2 * var(--gutter));
    padding: var(--sp-1h) var(--sp-1h) var(--sp-1h) var(--sp-3); border-radius: var(--r-lg); background: var(--pop); box-shadow: var(--shadow-pop); color: var(--ink2); font-size: var(--fs-quiet); animation: rise var(--t-base) var(--ease-base); }
  .note.bad { color: var(--danger-ink); }
  .note .why { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
