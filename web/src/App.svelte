<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The window: who is signed in decides what shows (first run: Setup; signed out: Sign in, or an invite's sign-up),
  // then the route: the machines, a machine (desktop: MachineScreen; phone: PhoneApp), linking a computer, Settings.
  // Internal links go through the router; the toasts, the confirm and the prompt sheets sit over everything.
  import { onMount } from 'svelte';
  import { app } from './lib/app.svelte';
  import { router } from './lib/router.svelte';
  import { layout } from './lib/layout.svelte';
  import Auth from './components/screens/Auth.svelte';
  import Machines from './components/screens/Machines.svelte';
  import MachineScreen from './components/screens/MachineScreen.svelte';
  import LinkApprove from './components/screens/LinkApprove.svelte';
  import Settings from './components/screens/Settings.svelte';
  import PhoneApp from './components/screens/PhoneApp.svelte';
  import ConfirmSheet from './components/ConfirmSheet.svelte';
  import PromptSheet from './components/PromptSheet.svelte';
  import Toaster from './components/ui/Toaster.svelte';
  import EmptyState from './components/ui/EmptyState.svelte';
  import Mark from './components/Mark.svelte';

  onMount(() => { void app.boot(); });
  const r = $derived(router.route);
  // (First run: everything goes to /setup; after it, /setup goes home.)
  $effect(() => {
    if (app.user === null) return;
    if (app.needsSetup && r.name !== 'setup') router.go('/setup', true);
    else if (!app.needsSetup && r.name === 'setup' && app.user) router.go('/', true);
    else if (app.user && r.name === 'invite') router.go('/', true);
  });
  $effect(() => {
    const t = r.name === 'machine' ? app.machine(r.id)?.name : r.name === 'settings' ? 'Settings' : r.name === 'link' ? 'Install CodeRail Bridge' : null;
    document.title = t ? `${t} · CodeRail` : 'CodeRail';
  });

  // Same-origin links open in the app (⌘/Ctrl-click and target=_blank keep the browser's own behaviour).
  function click(e: MouseEvent) {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement)?.closest?.('a[href]') as HTMLAnchorElement | null;
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    const u = new URL(a.href, location.href);
    if (u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
    e.preventDefault();
    router.go(u.pathname + u.search + u.hash);
  }
</script>

<svelte:window onclick={click} />

<div class="win">
  {#if app.bootError}
    <div class="center"><Mark size={40} /><EmptyState fill={false} icon="warning" text={app.bootError} action={{ label: 'Try again', run: () => app.boot() }} /></div>
  {:else if app.user === null}
    <div class="center"><span class="spinner"></span></div>
  {:else if r.name === 'setup' || app.needsSetup}
    <Auth mode="setup" />
  {:else if !app.user}
    {#if r.name === 'invite'}<Auth mode="invite" code={r.code} />{:else}<Auth mode="signin" />{/if}
  {:else if r.name === 'home' || (layout.phone && r.name === 'machine')}
    {#if layout.phone}
      <PhoneApp machine={r.name === 'machine' ? r.id : null} session={r.name === 'machine' ? r.session : null} />
    {:else}<Machines />{/if}
  {:else if r.name === 'machine'}
    {#key r.id}<MachineScreen id={r.id} session={r.session} />{/key}
  {:else if r.name === 'link'}
    <LinkApprove code={r.code} />
  {:else if r.name === 'settings'}
    <Settings tab={r.tab} />
  {:else}
    <div class="center"><EmptyState fill={false} icon="search" text="Nothing here" action={{ label: 'Machines', run: () => router.go('/') }} /></div>
  {/if}
  {#if app.confirm}<ConfirmSheet c={app.confirm} />{/if}
  {#if app.prompt}<PromptSheet p={app.prompt} />{/if}
  <Toaster />
</div>

<style>
  .win { height: 100%; position: relative; background: var(--content); display: flex; flex-direction: column; }
  .win > :global(.page) { flex: 1; min-height: 0; }
  .center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--sp-4); }
</style>
