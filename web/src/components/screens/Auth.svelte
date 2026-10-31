<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Signing in, the first admin (/setup, with the deploy's setup token) and joining by an invite (/invite/:code):
  // Forest's sign-in look (the mark, one serif title, the fields, one button), on CodeRail's username and password.
  import { onMount } from 'svelte';
  import WivaBadge from '../WivaBadge.svelte';
  import { api, plainError } from '../../lib/api';
  import { app } from '../../lib/app.svelte';
  import { router } from '../../lib/router.svelte';
  import Mark from '../Mark.svelte';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  let { mode, code = '' }: { mode: 'signin' | 'setup' | 'invite'; code?: string } = $props();
  let token = $state('');
  let username = $state('');
  let password = $state('');
  let password2 = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let invite = $state<{ valid: boolean; isAdmin: boolean } | null>(null);

  onMount(() => {
    if (mode === 'invite') api.invite(code).then((r) => (invite = r)).catch((e) => { invite = { valid: false, isAdmin: false }; error = plainError(e); });
    // (A setup link may carry the token: /setup?token=…)
    const t = new URLSearchParams(location.search).get('token');
    if (t) token = t;
  });

  const title = $derived(mode === 'setup' ? 'Set up CodeRail' : mode === 'invite' ? 'Join CodeRail' : 'Sign in to CodeRail');
  const USER = /^[a-z0-9_.-]{2,32}$/;
  function check(): string | null {
    if (mode === 'setup' && !token.trim()) return 'Enter the setup token from your deploy';
    if (!username.trim()) return 'Enter a username';
    if (mode !== 'signin' && !USER.test(username.trim())) return 'Usernames are 2–32 of a–z, 0–9, _ . -';
    if (!password) return 'Enter a password';
    if (mode !== 'signin' && password.length < 8) return 'Passwords are at least 8 characters';
    if (mode !== 'signin' && password !== password2) return 'The passwords don’t match';
    return null;
  }
  async function go(e: Event) {
    e.preventDefault();
    error = check();
    if (error) return;
    busy = true;
    try {
      const u = username.trim().toLowerCase();
      const r = mode === 'setup' ? await api.setup(token.trim(), u, password) : mode === 'invite' ? await api.signup(code, u, password) : await api.login(u, password);
      app.signedIn(r.user);
      if (mode !== 'signin') router.go('/', true);
    } catch (err) { error = plainError(err); }
    busy = false;
  }
</script>

<div class="auth scroll">
  <form class="box" onsubmit={go}>
    <Mark size={44} />
    <h1 class="page-title">{title}</h1>
    {#if mode === 'setup'}
      <p class="say">Create the first admin. The setup token is your <code>SETUP_TOKEN</code> secret.</p>
    {:else if mode === 'invite'}
      {#if invite && !invite.valid}<p class="say">This invite has expired or was already used.</p>
      {:else if invite?.isAdmin}<p class="say">You’re invited as an admin.</p>{/if}
    {/if}
    {#if mode !== 'invite' || invite?.valid}
      {#if mode === 'setup'}<input class="field" type="password" placeholder="Setup token" bind:value={token} autocomplete="off" disabled={busy} />{/if}
      <input class="field" placeholder="Username" bind:value={username} autocomplete="username" autocapitalize="off" spellcheck="false" disabled={busy} />
      <input class="field" type="password" placeholder="Password" bind:value={password} autocomplete={mode === 'signin' ? 'current-password' : 'new-password'} disabled={busy} />
      {#if mode !== 'signin'}<input class="field" type="password" placeholder="Password again" bind:value={password2} autocomplete="new-password" disabled={busy} />{/if}
      {#if error}<div class="err"><Icon name="warning" size={15} /><span>{error}</span></div>{/if}
      <Button type="submit" variant="primary" block size="lg" {busy}>{mode === 'setup' ? 'Create admin' : mode === 'invite' ? 'Create account' : 'Sign in'}</Button>
    {:else if !invite}
      <span class="spinner"></span>
    {/if}
    {#if mode === 'signin'}<p class="foot">New here? Ask an admin for an invite.</p>{/if}
    <div class="built"><WivaBadge /></div>
  </form>
</div>

<style>
  .auth { height: 100%; display: flex; justify-content: center; background: var(--content); padding: max(calc(2 * var(--sp-12)), env(safe-area-inset-top)) var(--gutter) var(--sp-12); }
  .box { width: 300px; display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); }
  .page-title { margin: var(--sp-2) 0 var(--sp-3); text-align: center; }
  .say { margin: 0 0 var(--sp-2); color: var(--ink2); text-align: center; line-height: 1.5; font-size: var(--fs-quiet); }
  .say code { font-family: var(--mono); font-size: 12.5px; }
  .field { height: 40px; }
  .err { width: 100%; }
  .foot { margin: var(--sp-3) 0 0; color: var(--muted); font-size: var(--fs-small); }
  .built { margin-top: var(--sp-8); }
  :global(:root[data-phone]) .box { width: 100%; max-width: 420px; gap: var(--sp-4); }
  :global(:root[data-phone]) .field { height: 50px; font-size: 17px; border-radius: var(--r-lg); }
  :global(:root[data-phone]) .box :global(.btn.lg) { height: 50px; font-size: 17px; border-radius: var(--r-lg); }
</style>
