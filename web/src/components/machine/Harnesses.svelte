<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The machine's agents (`agent.harnesses`): each with its version and the account it is signed in with (the `auth`
  // machine event's `status.label`). For owners with terminal access: Sign in while it's signed out (the harness's own
  // login runs in a Terminal tab on the machine, "Claude Code sign-in", `harness.login`), and once signed in a ⋯
  // menu with Sign out (`harness.logout`). CodeRail never sees the credentials.
  import { onMount } from 'svelte';
  import type { HarnessInfo } from '@coderail/protocol';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { tip } from '../../lib/tip';
  import HarnessMark from '../HarnessMark.svelte';
  import Button from '../ui/Button.svelte';
  import Menu from '../ui/Menu.svelte';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  let { conn, onlogin, compact = false }: { conn: MachineConn; onlogin: (h: HarnessInfo) => void; compact?: boolean } = $props();
  let list = $state<HarnessInfo[] | null>(null);
  async function load() {
    if (!conn.online) { list = conn.info?.harnesses ?? []; return; }
    list = await conn.call<HarnessInfo[]>('agent.harnesses').catch(() => conn.info?.harnesses ?? []);
  }
  onMount(load);
  $effect(() => { if (conn.online && conn.ready) void load(); });
  const shown = $derived(list ?? conn.info?.harnesses ?? []);
  // (What the machine last said: a sign-in's or an adapter's `auth` event, else the status agent.harnesses read.)
  const account = (h: HarnessInfo) => {
    const a = conn.auth[h.id] ?? (h.auth ? { signedIn: h.auth.signedIn, label: h.auth.signedIn ? h.auth.account || 'Signed in' : null } : null);
    return a?.label ?? (a?.signedIn === false || a?.state === 'signed_out' ? 'Signed out' : null);
  };
  let menu = $state<{ h: HarnessInfo; el: HTMLElement } | null>(null);
  function signOut(h: HarnessInfo) {
    app.confirmIt({ title: `Sign ${h.name} out?`, body: `${h.name} on this computer signs out of its account. Sessions can't run until you sign in again.`, yes: 'Sign out', danger: true,
      run: async () => { try { await conn.call('harness.logout', { harness: h.id }); } catch (e) { app.toast(plainError(e), 'warning'); } } });
  }
  const why = $derived(!conn.online ? 'The computer is offline' : !conn.isOwner ? 'Owners sign agents in' : !conn.canTerminal ? 'Needs terminal access' : '');
</script>

<div class="hl" class:compact>
  {#each shown as h (h.id)}
    {@const acct = account(h)}
    <div class="h" class:off={!h.installed}>
      <HarnessMark harness={h.id} size={28} name={h.name} />
      <span class="m"><b>{h.name}</b><span class="v">{!h.installed ? 'Not installed' : [h.version, acct].filter(Boolean).join(' · ') || 'Installed'}</span></span>
      {#if h.installed}
        {#if acct && acct !== 'Signed out'}
          <span {@attach tip(why)}><Button variant="icon" size="sm" icon="more" tip={why ? '' : 'More'} disabled={!!why} on={menu?.h.id === h.id} onclick={(e) => (menu = { h, el: e.currentTarget as HTMLElement })} /></span>
        {:else}
          <span {@attach tip(why)}><Button size="sm" disabled={!!why} onclick={() => onlogin(h)}>Sign in</Button></span>
        {/if}
      {/if}
    </div>
  {/each}
</div>
{#each menu ? [menu] : [] as m (m)}
  <Menu anchor={m.el} end width={200} label={m.h.name} items={[{ id: 'out', label: 'Sign out', icon: 'signout', danger: true }]}
    onpick={() => signOut(m.h)} onclose={() => (menu = null)} />
{/each}

<style>
  .hl { display: flex; flex-direction: column; gap: var(--sp-2); }
  .h { display: flex; align-items: center; gap: var(--sp-3); min-height: 44px; }
  .h.off { opacity: 0.55; }
  .m { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 18px; font-size: var(--fs-quiet); }
  .v { color: var(--muted); font-size: var(--fs-small); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
