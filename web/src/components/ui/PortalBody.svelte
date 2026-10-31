<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // (What a Portal renders inside #layer.)
  import type { Snippet } from 'svelte';
  let { children }: { children: Snippet } = $props();
</script>

{@render children()}
