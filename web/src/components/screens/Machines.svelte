<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Home: your machines as cards (MachineCard). "Install CodeRail Bridge" by the title opens AddComputerSheet; with no
  // computer yet, the page says so and offers the same.
  import { app } from '../../lib/app.svelte';
  import TopBar from '../TopBar.svelte';
  import MachineCard from '../MachineCard.svelte';
  import CardLoad from '../CardLoad.svelte';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  import WivaBadge from '../WivaBadge.svelte';
  import AddComputerSheet from '../AddComputerSheet.svelte';
  let hasMacApp = $state(false);
  let adding = $state(false);
  void fetch('/download/latest.json').then((r) => (hasMacApp = r.ok), () => {});
  const sorted = $derived([...app.machines].sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name)));
  $effect(() => {
    // (Back on the page: the list again, for machines linked or removed meanwhile.)
    const again = () => { if (document.visibilityState === 'visible') void app.loadMachines(); };
    document.addEventListener('visibilitychange', again);
    return () => document.removeEventListener('visibilitychange', again);
  });
</script>

<div class="page">
  <TopBar />
  <div class="scroll body">
    <div class="column wide">
      <div class="head">
        <h1 class="page-title">Machines</h1>
        {#if sorted.length}<Button icon="plus" onclick={() => (adding = true)}>Install CodeRail Bridge</Button>{/if}
      </div>
      {#if !app.machinesLoaded}<CardLoad retry={() => app.loadMachines()} />
      {:else if app.machinesError && !app.machines.length}<CardLoad error={app.machinesError} retry={() => app.loadMachines()} />
      {:else if !sorted.length}
        <div class="none">
          <span class="ic"><Icon name="mac" size={22} /></span>
          <b>No computers yet</b>
          <Button variant="primary" icon="plus" onclick={() => (adding = true)}>Install CodeRail Bridge</Button>
        </div>
      {:else}
        <div class="grid">{#each sorted as m (m.id)}<MachineCard {m} />{/each}</div>
      {/if}
      <div class="built"><WivaBadge /></div>
    </div>
  </div>
</div>
{#if adding}<AddComputerSheet {hasMacApp} onclose={() => (adding = false)} />{/if}

<style>
  .body { flex: 1; min-height: 0; }
  .built { display: flex; justify-content: center; margin: var(--sp-12) 0 var(--sp-6); }
  .wide { max-width: 1080px; }
  .head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); flex-wrap: wrap; margin-bottom: var(--sp-6); }
  .head .page-title { margin: 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: var(--sp-4); align-items: start; }
  .none { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); text-align: center; padding: var(--sp-12) var(--sp-5); border-radius: var(--r-card); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); background: var(--tint); }
  .none .ic { width: 44px; height: 44px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; background: var(--sel); color: var(--ink); margin-bottom: var(--sp-1); }
  .none b { font-size: var(--fs-title); font-weight: var(--w-head); }
</style>
