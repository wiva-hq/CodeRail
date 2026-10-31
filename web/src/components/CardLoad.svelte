<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A card's read that is not done: a spinner while it runs; when it failed, "Could not
  // load", its reason as the tooltip, and Retry.
  import EmptyState from './ui/EmptyState.svelte';
  import Button from './ui/Button.svelte';
  let { error = null, retry }: { error?: string | null; retry: () => void } = $props();
</script>

{#if error}
  <EmptyState compact icon="warning" text="Could not load" tip={error}><Button size="sm" onclick={retry}>Retry</Button></EmptyState>
{:else}
  <div class="wait" role="status" aria-label="Loading"><span class="spinner"></span></div>
{/if}

<style>
  .wait { display: flex; justify-content: center; padding: var(--sp-10) 0; animation: fade var(--t-base) var(--ease-base) 150ms both; }
</style>
