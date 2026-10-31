<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Browser: the chat's own Camofox browser on the computer, its screen streamed here. One per chat session (its own
  // profile: cookies, sign-ins), and everyone who opens the chat sees and drives the same one. With none open, the
  // start: the address field and the last few addresses opened on this computer (kept in this browser).
  import { untrack } from 'svelte';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { panes, type Tab } from '../../lib/panes.svelte';
  import { edges } from '../../lib/edges';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import CamofoxBrowser from './CamofoxBrowser.svelte';
  import { kept, keep } from '../../lib/kept';
  import { ago } from '../../lib/format';
  import { app } from '../../lib/app.svelte';
  let { conn, conv, tab, session }: { conn: MachineConn; conv: string; tab: Tab; session: string | null } = $props();
  /** The last addresses opened on this computer, newest first. */
  const RECENT = 8;
  // svelte-ignore state_referenced_locally
  const recentKey = `coderail.browser.${conn.id}`;
  let recent = $state<{ url: string; at: number }[]>(kept(recentKey, []));
  function remember(url: string) {
    recent = [{ url, at: Date.now() }, ...recent.filter((r) => r.url !== url)].slice(0, RECENT);
    keep(recentKey, recent);
  }
  function forget(url: string) {
    recent = recent.filter((r) => r.url !== url);
    keep(recentKey, recent.length ? recent : null);
  }
  const shortUrl = (u: string) => u.replace(/^https?:\/\//, '').replace(/\/$/, '');
  let error = $state<string | null>(null);
  let start = $state('');
  /** The chat's browser is shown (it may already be open: the card looks first), and an address just asked for. */
  let live = $state(true);
  let asked = $state<string | null>(null);
  /** Counts the addresses asked for, so the same one again still opens. */
  let asks = $state(0);
  // (Another chat: look for its browser.)
  $effect(() => { void session; live = true; asked = null; });
  // (A link clicked in the chat: open it here.)
  $effect(() => {
    const u = tab.open;
    if (u) untrack(() => { panes.setTab(conv, tab.id, { open: undefined }); go(u); });
  });
  // (The chat's agent opened its browser while this card showed the start: show it.)
  $effect(() => conn.listen('machine', (e: any) => { if (e?.type === 'browser' && e.sessionId === session && !live) { asked = null; live = true; } }));

  /** Text typed as an address → a web address (http or https), or null. */
  function parse(text: string): URL | null {
    const t = text.trim();
    if (!t) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) { try { const u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:' ? u : null; } catch { return null; } }
    // (An address typed without a scheme: https, as a browser assumes, but http for what's on the machine or its
    // network: localhost, private addresses, .local and .lan names, a bare name, or a port other than 443.)
    const host = t.replace(/^\[|\].*$/g, '').split(/[/?#]/)[0].replace(/:(\d+)$/, '');
    const port = t.split(/[/?#]/)[0].match(/:(\d+)$/)?.[1];
    const local = /^(localhost|.*\.localhost|127\.\d+\.\d+\.\d+|::1|0\.0\.0\.0|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|.*\.(local|lan|internal|home|test))$/i.test(host) || !host.includes('.') || (!!port && port !== '443');
    try { return new URL(`${local ? 'http' : 'https'}://${t}`); } catch { return null; }
  }
  function go(text: string) {
    const u = parse(text);
    if (!u) { error = 'Type an http or https address'; return; }
    error = null;
    remember(u.href);
    panes.setTab(conv, tab.id, { url: u.href, title: u.host });
    asked = u.href; asks++; live = true;
  }
</script>

<div class="browser">
  {#if !conn.online}
    <EmptyState compact icon="globe" text="The computer is offline" />
  {:else if !conn.canOperate}
    <EmptyState compact icon="globe" text="The browser needs Operator access" />
  {:else if !session}
    <EmptyState compact icon="globe" text="Open a chat to use its browser" />
  {:else if live}
    {#key `${session}:${asks}`}
      <CamofoxBrowser {conn} {session} url={asked} {parse}
        onnav={(u, t) => panes.setTab(conv, tab.id, { url: u, title: t || parse(u)?.host || 'Browser' })}
        onback={() => { live = false; asked = null; panes.setTab(conv, tab.id, { url: undefined, title: undefined }); }} />
    {/key}
  {:else}
    <div class="start scroll" {@attach edges()}>
      <form class="open" onsubmit={(e) => { e.preventDefault(); go(start); }}>
        <span class="addr framed"><Icon name="globe" size={14} /><input bind:value={start} placeholder="Address" spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Address" /></span>
        <Button type="submit" size="sm" disabled={!start.trim()}>Open</Button>
      </form>
      {#if error}<div class="err"><Icon name="warning" size={14} />{error}</div>{/if}
      {#if recent.length}
        <div class="ph"><span>Recent</span></div>
        {#each recent as r (r.url)}
          <div class="prow">
            <button class="pgo" onclick={() => go(r.url)}><Icon name="globe" size={14} /><span class="pc cut mono">{shortUrl(r.url)}</span><span class="pa">{ago(r.at, app.now)}</span></button>
            <Button icon="close" variant="icon" size="xs" tip="Remove" onclick={() => forget(r.url)} />
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</div>

<style>
  .browser { display: flex; flex-direction: column; height: 100%; }
  .addr { flex: 1; min-width: 0; display: flex; align-items: center; height: 30px; padding: 0 var(--sp-2); margin: 0 var(--sp-1); font-size: var(--fs-quiet); }
  .addr input { flex: 1; min-width: 0; height: 100%; outline: none; font-family: var(--mono); font-size: 12.5px; }
  .open { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-3); }
  .open .addr { margin: 0; gap: var(--sp-2); color: var(--muted); }
  .start { flex: 1; padding: var(--sp-3) var(--gutter) var(--gutter); display: flex; flex-direction: column; }
  .ph { display: flex; align-items: center; color: var(--muted); font-size: var(--fs-quiet); margin-bottom: var(--sp-2); }
  .prow { display: flex; align-items: center; gap: var(--sp-1); height: 36px; padding: 0 var(--sp-1) 0 var(--row-x); margin: 0 calc(-1 * var(--row-x)); border-radius: var(--r-md); }
  .prow:hover { background: var(--hover); }
  .pgo { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2); height: 100%; text-align: left; color: var(--ink); }
  .pgo :global(svg) { color: var(--muted); flex: none; }
  .prow > :global(.iconbtn) { opacity: 0; }
  .prow:hover > :global(.iconbtn), .prow > :global(.iconbtn:focus-visible) { opacity: 1; }
  .pc { flex: 1; min-width: 0; color: var(--ink2); font-size: var(--fs-quiet); white-space: nowrap; overflow: hidden; }
  .pa { color: var(--faint); font-size: 12px; flex: none; }
  .err { display: flex; align-items: center; gap: var(--sp-1h); color: var(--danger-ink); font-size: var(--fs-quiet); margin-bottom: var(--sp-2); }
</style>
