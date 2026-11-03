<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  import FilesCard from '../../../web/src/components/panes/FilesCard.svelte';
  import ChangesCard from '../../../web/src/components/panes/ChangesCard.svelte';
  import BrowserCard from '../../../web/src/components/panes/BrowserCard.svelte';
  import { MachineConn } from '../../../web/src/lib/machine.svelte';
  import { panes } from '../../../web/src/lib/panes.svelte';
  import { app } from '../../../web/src/lib/app.svelte';
  import '../../../web/src/styles/theme.css';
  import '../../../web/src/styles/base.css';
  import '../../../web/src/styles/app.css';
  let conn = new MachineConn('windows-gate2');
  let cwd = $state<string | null>(null);
  let active = $state<'files' | 'changes' | 'browser'>('files');
  const conv = 'windows-gate2';
  let browserTab = { id: 'browser-gate2', kind: 'browser' as const };
  fetch('/gate/config').then(r => r.json()).then(r => cwd = r.cwd);
</script>
<header><strong>Gate 2 · real Svelte components / Windows candidates</strong>
  <button onclick={() => active = 'files'}>Files</button>
  <button onclick={() => active = 'changes'}>Changes</button>
  <button onclick={() => active = 'browser'}>Browser</button>
  <span>{conn.online ? 'Windows connected' : 'Connecting'}</span>
</header>
<section>
  {#if cwd && active === 'files'}<FilesCard {conn} {cwd} />
  {:else if cwd && active === 'changes'}<ChangesCard {conn} {cwd} />
  {:else if active === 'browser'}<BrowserCard {conn} {conv} tab={browserTab} />{/if}
</section>
<aside aria-live="polite">{#each app.toasts as toast (toast.id)}<p>{toast.text}</p>{/each}</aside>
<style>
  header { height: 52px; display:flex; align-items:center; gap:16px; padding:0 20px; }
  header button { padding:8px; border:1px solid #999; border-radius:6px; }
  section { margin:10px; height:calc(100vh - 100px); display:flex; flex-direction:column; border:1px solid #999; }
  aside { position:fixed; right:20px; bottom:20px; padding:8px; background:var(--surface); }
</style>
