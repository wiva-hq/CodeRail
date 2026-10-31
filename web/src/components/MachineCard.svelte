<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A machine on the home grid: its name, host and system, whether it is online (live, from its socket), the
  // harnesses installed there, your role, and the approvals waiting.
  import type { MachineSummary } from '@coderail/protocol';
  import { app } from '../lib/app.svelte';
  import { paths } from '../lib/router.svelte';
  import { ago } from '../lib/format';
  import HarnessMark from './HarnessMark.svelte';
  import { osName } from '../lib/machineText';
  let { m }: { m: MachineSummary } = $props();
  // (Its socket, for presence and the approvals count; opened only for one that is online.)
  const conn = $derived(m.online ? app.conn(m.id) : null);
  const online = $derived(conn?.ready ? conn.online : m.online);
  const info = $derived(conn?.info ?? m.info);
  const pending = $derived(conn?.approvals.length ?? 0);
  const running = $derived(conn?.sessions.filter((s) => s.state === 'running').length ?? 0);
  const harnesses = $derived((info?.harnesses ?? []).filter((h) => h.installed));
</script>

<a class="mcard" href={paths.machine(m.id)}>
  <div class="top">
    <span class="sdot" class:on={online}></span>
    <span class="name cut">{m.name}</span>
    {#if pending}<span class="badge" title="Approvals waiting">{pending}</span>{/if}
  </div>
  <div class="host cut">{info ? `${info.hostname} · ${osName(info.os)}` : 'Not seen yet'}</div>
  <div class="state">{online ? (running ? `Online · ${running} working` : 'Online') : m.lastSeen ? `Offline · seen ${ago(m.lastSeen, app.now)}` : 'Offline'}</div>
  <div class="bottom">
    <span class="hs">{#each harnesses as h (h.id)}<span title="{h.name}{h.version ? ' ' + h.version : ''}"><HarnessMark harness={h.id} size={24} name={h.name} /></span>{/each}</span>
    <span class="sp"></span>
    <span class="tag">{m.scope.role[0].toUpperCase() + m.scope.role.slice(1)}</span>
  </div>
</a>

<style>
  .mcard { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-4); min-height: 148px; text-decoration: none; color: var(--ink);
    background: var(--panel); border-radius: var(--r-card); box-shadow: inset 0 0 0 var(--hairline) var(--hair2), var(--shadow-card); transition: box-shadow var(--t-fast) ease-out, transform var(--t-quick) var(--ease-snap); }
  .mcard:hover { box-shadow: inset 0 0 0 var(--hairline) color-mix(in srgb, var(--hair2), var(--ink) 20%), var(--shadow-card); }
  .mcard:active { transform: scale(0.99); }
  .top { display: flex; align-items: center; gap: var(--sp-2); }
  .name { flex: 1; min-width: 0; font-size: var(--fs-head); font-weight: var(--w-head); white-space: nowrap; overflow: hidden; }
  .host { color: var(--ink2); font-size: var(--fs-quiet); white-space: nowrap; overflow: hidden; }
  .state { color: var(--muted); font-size: var(--fs-small); }
  .bottom { display: flex; align-items: center; gap: var(--sp-2); margin-top: auto; padding-top: var(--sp-3); }
  .hs { display: inline-flex; gap: var(--sp-1h); }
  .sp { flex: 1; }
  .badge { background: var(--warn); color: var(--ondanger); }
  :global(:root[data-scheme='dark']) .badge { color: #09090b; }
</style>
