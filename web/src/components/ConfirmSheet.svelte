<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The one confirm (app.confirmIt): a title, what happens, Cancel and the action (red when it can't be undone).
  import { app, type Confirm } from '../lib/app.svelte';
  import Sheet from './ui/Sheet.svelte';
  import Button from './ui/Button.svelte';
  let { c }: { c: Confirm } = $props();
  let busy = $state(false);
  async function yes() {
    busy = true;
    try { await c.run(); app.confirm = null; } catch (e) { app.toast(String((e as Error)?.message ?? e), 'warning'); }
    busy = false;
  }
</script>

<Sheet title={c.title} width={440} onclose={() => (app.confirm = null)}>
  {#if c.body}<p class="b">{c.body}</p>{/if}
  {#snippet footer()}
    <span class="sp"></span>
    <Button onclick={() => (app.confirm = null)}>Cancel</Button>
    <Button variant={c.danger ? 'solid-danger' : 'primary'} data-primary {busy} onclick={yes}>{c.yes}</Button>
  {/snippet}
</Sheet>

<style>
  .b { margin: 0; color: var(--ink2); line-height: 1.5; }
</style>
