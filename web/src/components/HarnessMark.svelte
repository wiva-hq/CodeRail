<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts" module>
  /** A harness's brand mark, and a provider's. */
  const HARNESS: Record<string, string> = { 'claude-code': 'claude', codex: 'openai', hermes: 'hermes', opencode: 'opencode', gemini: 'gemini' };
  const PROVIDER: Record<string, string> = { claude: 'claude', chatgpt: 'openai', openai: 'openai', google: 'gemini', nous: 'nous', openrouter: 'openrouter', copilot: 'copilot' };
  export const markOf = (harness?: string) => (harness ? HARNESS[harness] ?? PROVIDER[harness] ?? harness : '');
</script>

<script lang="ts">
  // A harness or provider logo on its tile: the real brand mark (monochrome, design/vendor/lobehub-icons, MIT) on the
  // brand's own tile where it has one (Claude white on its orange, Codex black on white), else in the ink colour on
  // a panel tile with a hairline; `bare` draws the mark alone. An unknown harness gets its first letter.
  //
  //   <HarnessMark harness="codex" size={20} />
  import { LOGOS } from '../lib/logos.gen';
  let { harness, size = 20, bare = false, name = '' }: { harness?: string; size?: number; bare?: boolean; name?: string } = $props();
  const RADIUS: Record<number, number> = { 16: 5, 18: 5, 20: 6, 24: 7, 28: 8, 32: 9, 40: 11, 48: 13, 56: 15 };
  let mark = $derived(markOf(harness));
  let logo = $derived(LOGOS[mark]);
  let r = $derived(RADIUS[Math.round(size)] ?? size * 0.28);
  let inner = $derived(bare ? size : Math.round(size * 0.6));
</script>

<span class="hm" class:bare data-brand={bare ? undefined : mark} style="width:{size}px;height:{size}px;border-radius:{r}px" aria-hidden="true">
  {#if logo}
    <svg width={inner} height={inner} viewBox={logo.viewBox.join(' ')} fill="currentColor">
      {#each logo.paths as d, i (i)}<path {d} fill-rule={logo.evenOdd ? 'evenodd' : undefined} />{/each}
    </svg>
  {:else}
    <span class="l" style="font-size:{Math.round(size * 0.5)}px">{(name || harness || '?')[0].toUpperCase()}</span>
  {/if}
</span>

<style>
  .hm { display: inline-flex; align-items: center; justify-content: center; flex: none; color: var(--ink); background: var(--panel); box-shadow: inset 0 0 0 var(--hairline) var(--hair); }
  .hm.bare { background: none; box-shadow: none; }
  .hm[data-brand='claude'] { background: #d97757; color: #fff; box-shadow: none; }
  .hm[data-brand='openai'] { background: #fff; color: #000; box-shadow: inset 0 0 0 var(--hairline) rgba(0, 0, 0, 0.12); }
  .l { font-weight: var(--w-strong); color: var(--ink2); line-height: 1; }
</style>
