<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Linking a computer (/link?code=): what the bridge said about itself (GET /api/pair/:code), a name to keep (yours
  // to change), Approve. The approver becomes its owner; then its page opens.
  import { onMount } from 'svelte';
  import { api, plainError, type Pairing } from '../../lib/api';
  import { app } from '../../lib/app.svelte';
  import { router, paths } from '../../lib/router.svelte';
  import { osName } from '../../lib/machineText';
  import TopBar from '../TopBar.svelte';
  import Icon from '../Icon.svelte';
  import HarnessMark from '../HarnessMark.svelte';
  import Button from '../ui/Button.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  let { code }: { code: string } = $props();
  let p = $state<Pairing | null>(null);
  let error = $state<string | null>(null);
  let name = $state('');
  let busy = $state(false);
  let typed = $state('');
  async function load(c: string) {
    error = null; p = null;
    try { p = await api.pairing(c); name = p.name; } catch (e) { error = plainError(e); }
  }
  onMount(() => { if (code) void load(code); });
  async function approve() {
    if (!p || !name.trim()) return;
    busy = true;
    try {
      const r = await api.approvePairing(p.code, name.trim());
      await app.loadMachines();
      app.toast(`${name.trim()} linked`, 'success');
      router.go(paths.machine(r.machineId), true);
    } catch (e) { error = plainError(e); }
    busy = false;
  }
  const expired = $derived(!!p && p.expiresAt < app.now);
</script>

<div class="page">
  <TopBar title="Install CodeRail Bridge" />
  <div class="scroll body">
    <div class="column narrow">
      <h1 class="page-title">Install CodeRail Bridge</h1>
      {#if !code}
        <p class="say">Enter the code <code>coderail link</code> printed on the computer.</p>
        <form class="enter" onsubmit={(e) => { e.preventDefault(); if (typed.trim()) router.go(`/link?code=${encodeURIComponent(typed.trim())}`); }}>
          <input class="field" bind:value={typed} placeholder="Code" autocapitalize="characters" spellcheck="false" />
          <Button type="submit" variant="primary" disabled={!typed.trim()}>Continue</Button>
        </form>
      {:else if error && !p}
        <EmptyState icon="warning" text={error} fill={false}><Button onclick={() => load(code)}>Retry</Button></EmptyState>
      {:else if !p}
        <div class="wait"><span class="spinner"></span></div>
      {:else}
        <div class="card box">
          <div class="code mono">{p.code}</div>
          <p class="say">Make sure it matches the code on the computer.</p>
          <dl>
            {#if p.info?.hostname}<dt>Host</dt><dd>{p.info.hostname}</dd>{/if}
            {#if p.info?.os}<dt>System</dt><dd>{osName(p.info.os)}{p.info.arch ? ` · ${p.info.arch}` : ''}</dd>{/if}
            {#if p.info?.user}<dt>User</dt><dd>{p.info.user}</dd>{/if}
            {#if p.info?.bridgeVersion}<dt>Bridge</dt><dd>{p.info.bridgeVersion}</dd>{/if}
            {#if p.info?.harnesses?.length}
              <dt>Agents</dt>
              <dd class="hs">{#each p.info.harnesses.filter((h) => h.installed) as h (h.id)}<span class="h"><HarnessMark harness={h.id} size={20} name={h.name} />{h.name}</span>{:else}None installed{/each}</dd>
            {/if}
            <dt>Expires</dt><dd>{expired ? 'Expired' : `in ${Math.max(1, Math.round((p.expiresAt - app.now) / 60000))} min`}</dd>
          </dl>
          <label class="lbl-field">Name<input class="field" bind:value={name} placeholder="Studio Mac" /></label>
          {#if error}<div class="err"><Icon name="warning" size={15} />{error}</div>{/if}
          <div class="acts">
            <Button onclick={() => router.go('/')}>Cancel</Button>
            <Button variant="primary" {busy} disabled={!name.trim() || expired} onclick={approve}>Approve</Button>
          </div>
          <p class="q">You’ll own this computer.</p>
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .body { flex: 1; min-height: 0; }
  .narrow { max-width: 520px; }
  .say { color: var(--ink2); line-height: 1.5; margin: 0 0 var(--sp-3); }
  .say code { font-family: var(--mono); font-size: 13px; }
  .enter { display: flex; gap: var(--sp-2); }
  .wait { display: flex; justify-content: center; padding: var(--sp-10); }
  .box { padding: var(--sp-5); display: flex; flex-direction: column; gap: var(--sp-3); }
  .code { font-size: 28px; letter-spacing: 0.12em; font-weight: var(--w-head); text-align: center; padding: var(--sp-2) 0; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: var(--sp-2) var(--sp-4); margin: 0; font-size: var(--fs-quiet); }
  dt { color: var(--muted); }
  dd { margin: 0; color: var(--ink); min-width: 0; overflow-wrap: anywhere; }
  .hs { display: flex; flex-wrap: wrap; gap: var(--sp-3); }
  .h { display: inline-flex; align-items: center; gap: var(--sp-1h); }
  .acts { display: flex; justify-content: flex-end; gap: var(--sp-2); }
  .q { margin: 0; color: var(--muted); font-size: var(--fs-small); }
</style>
