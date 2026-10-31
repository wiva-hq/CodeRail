<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A name to give (a branch, a folder, a file): one field, the action; `run` answers an error or null.
  import { app, type Prompt } from '../lib/app.svelte';
  import Sheet from './ui/Sheet.svelte';
  import Button from './ui/Button.svelte';
  import Icon from './Icon.svelte';
  let { p }: { p: Prompt } = $props();
  // svelte-ignore state_referenced_locally
  let v = $state(p.value);
  let busy = $state(false);
  let error = $state<string | null>(null);
  async function yes() {
    if (!v.trim()) return;
    busy = true; error = null;
    try { error = await p.run(v.trim()); if (!error) app.prompt = null; } catch (e) { error = String((e as Error)?.message ?? e); }
    busy = false;
  }
</script>

<Sheet title={p.title} width={440} onclose={() => (app.prompt = null)}>
  <label class="lbl-field">{p.label}<input class="field" bind:value={v} placeholder={p.placeholder} spellcheck="false" autocapitalize="off" /></label>
  {#if error}<div class="err" style="margin-top:var(--sp-2)"><Icon name="warning" size={15} />{error}</div>{/if}
  {#snippet footer()}
    <span class="sp"></span>
    <Button onclick={() => (app.prompt = null)}>Cancel</Button>
    <Button variant="primary" {busy} disabled={!v.trim()} onclick={yes}>{p.yes}</Button>
  {/snippet}
</Sheet>
