<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The bar over a page (machines, settings, linking): the mark and the name (home), what the page adds, and you
  // (Settings, Sign out).
  import type { Snippet } from 'svelte';
  import { app } from '../lib/app.svelte';
  import { router } from '../lib/router.svelte';
  import Mark from './Mark.svelte';
  import Icon from './Icon.svelte';
  import Menu from './ui/Menu.svelte';
  let { title, children }: { title?: string; children?: Snippet } = $props();
  let me = $state<HTMLElement | null>(null);
  const user = $derived(app.user || null);
  function pick(id: string) {
    if (id === 'settings') router.go('/settings');
    else if (id === 'out') void app.signOut();
  }
</script>

<header class="topbar">
  <a class="home" href="/" aria-label="Machines"><Mark size={24} /><span class="nm">CodeRail</span></a>
  {#if title}<span class="slash">/</span><span class="ttl cut">{title}</span>{/if}
  <span class="sp"></span>
  {#if children}{@render children()}{/if}
  {#if user}
    <button class="me" class:on={!!me} aria-haspopup="menu" onclick={(e) => (me = me ? null : (e.currentTarget as HTMLElement))}>
      <span class="av">{user.username[0]?.toUpperCase()}</span><span class="un cut">{user.username}</span><Icon name="chevd" size={14} />
    </button>
  {/if}
</header>
{#if me}
  <Menu anchor={me} end width={220} onclose={() => (me = null)} onpick={pick}
    items={[{ id: 'settings', label: 'Settings', icon: 'gear' }, { id: 's', sep: true }, { id: 'out', label: 'Sign out', icon: 'signout' }]} />
{/if}

<style>
  .topbar { height: var(--titlebar); flex: none; display: flex; align-items: center; gap: var(--sp-2); padding: 0 var(--sp-4) 0 var(--sp-5); }
  .home { display: inline-flex; align-items: center; gap: var(--sp-2); text-decoration: none; color: var(--ink); border-radius: var(--r-md); padding: var(--sp-1) var(--sp-1h); margin-left: calc(-1 * var(--sp-1h)); }
  .home:hover { background: var(--hover); }
  .nm { font-weight: var(--w-head); font-size: var(--fs-title); letter-spacing: -0.1px; }
  .slash { color: var(--faint); }
  .ttl { color: var(--ink2); font-weight: var(--w-control); white-space: nowrap; overflow: hidden; min-width: 0; }
  .sp { flex: 1; }
  .me { display: inline-flex; align-items: center; gap: var(--sp-2); height: 32px; padding: 0 var(--sp-2) 0 var(--sp-1); border-radius: var(--r-md); color: var(--ink2); }
  .me:hover, .me.on { background: var(--hover); color: var(--ink); }
  .av { width: 24px; height: 24px; border-radius: 50%; background: var(--p4-bg); color: var(--p4-fg); display: inline-flex; align-items: center; justify-content: center; font-size: 12px; font-weight: var(--w-strong); }
  .un { max-width: 140px; white-space: nowrap; overflow: hidden; }
  :global(:root[data-phone]) .un { display: none; }
  :global(:root[data-phone]) .topbar { padding: var(--safe-t, 0) calc(var(--gutter) + var(--safe-r, 0px)) 0 calc(var(--gutter) + var(--safe-l, 0px)); height: calc(var(--titlebar) + var(--safe-t, 0px)); }
</style>
