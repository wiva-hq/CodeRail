<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A checkbox with a third state, "some" (GitHub Desktop's file that only some of its lines go in): a 16 square,
  // the accent when checked or some, a hairline box when not.
  let { state, label, disabled = false, onchange }: { state: 'all' | 'some' | 'none'; label: string; disabled?: boolean; onchange: (on: boolean) => void } = $props();
</script>

<button type="button" class="check {state}" role="checkbox" aria-checked={state === 'all' ? 'true' : state === 'some' ? 'mixed' : 'false'} aria-label={label} {disabled}
  onclick={(e) => { e.stopPropagation(); onchange(state === 'none'); }}>
  {#if state === 'all'}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 8.2l2.6 2.6L12 5.4" /></svg>
  {:else if state === 'some'}<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 8h7" /></svg>{/if}
</button>

<style>
  .check { flex: none; width: 16px; height: 16px; border-radius: 4px; display: inline-grid; place-items: center; box-shadow: inset 0 0 0 1.25px var(--hair2); background: var(--panel); transition: background var(--t-fast) ease-out, box-shadow var(--t-fast) ease-out; }
  .check:hover:not(:disabled) { box-shadow: inset 0 0 0 1.25px var(--muted); }
  .check.all, .check.some { background: var(--accent); box-shadow: none; }
  .check:disabled { opacity: 0.5; }
  .check:focus-visible { outline: 2px solid var(--accent-ring); outline-offset: 1px; }
  svg { width: 14px; height: 14px; fill: none; stroke: var(--panel); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
</style>
