<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A pull request's checks in one glyph and count, as GitHub draws them: a red cross when any failed, an amber dot
  // while any run, a green check when all passed; nothing without checks.
  import type { GhPull } from '@coderail/protocol';
  import { tip } from '../../../lib/tip';
  let { checks }: { checks: GhPull['checks'] } = $props();
  const total = $derived(checks.pass + checks.fail + checks.pending + checks.skipping + checks.cancel);
  const kind = $derived(checks.fail ? 'fail' : checks.pending ? 'pending' : 'pass');
  const said = $derived([checks.fail && `${checks.fail} failing`, checks.pending && `${checks.pending} running`, checks.pass && `${checks.pass} passed`, checks.skipping && `${checks.skipping} skipped`, checks.cancel && `${checks.cancel} cancelled`].filter(Boolean).join(' · '));
</script>

{#if total}
  <span class="badge {kind}" {@attach tip(said)} aria-label={said}>
    {#if kind === 'fail'}<svg viewBox="0 0 16 16"><path d="M5 5l6 6M11 5l-6 6" /></svg>
    {:else if kind === 'pending'}<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2" /></svg>
    {:else}<svg viewBox="0 0 16 16"><path d="M4 8.2l2.6 2.6L12 5.4" /></svg>{/if}
    <span>{kind === 'fail' ? checks.fail : kind === 'pending' ? checks.pending : checks.pass}/{total}</span>
  </span>
{/if}

<style>
  .badge { flex: none; display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-meta); font-variant-numeric: tabular-nums; color: var(--muted); }
  svg { width: 14px; height: 14px; fill: none; stroke-width: 2; stroke-linecap: round; }
  .pass svg { stroke: var(--ok); }
  .fail svg { stroke: var(--danger); }
  .pending svg { stroke: none; fill: var(--warn); }
</style>
