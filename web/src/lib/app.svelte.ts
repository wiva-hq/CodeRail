// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The app's own state: who is signed in, the machines they can see, toasts and the one confirm sheet. Each machine's
// live state is its MachineConn (lib/machine.svelte.ts), opened on demand and kept while the page lives.
import type { MachineSummary } from '@coderail/protocol';
import { api, plainError, type User } from './api';
import { MachineConn } from './machine.svelte';
import { disablePush } from './push';

export interface Toast { id: number; text: string; icon: string; action?: { label: string; run: () => void } }
export interface Confirm { title: string; body?: string; yes: string; danger?: boolean; run: () => Promise<void> | void }
export interface Prompt { title: string; label: string; value: string; placeholder?: string; yes: string; run: (v: string) => Promise<string | null> }

class App {
  /** null while it asks the server; then the user, or false when signed out. */
  user = $state<User | null | false>(null);
  /** No user exists yet: /setup creates the first admin. */
  needsSetup = $state(false);
  bootError = $state<string | null>(null);
  machines = $state<MachineSummary[]>([]);
  machinesLoaded = $state(false);
  machinesError = $state<string | null>(null);
  toasts = $state<Toast[]>([]);
  confirm = $state<Confirm | null>(null);
  prompt = $state<Prompt | null>(null);
  /** A clock for "3m ago" and elapsed times. */
  now = $state(Date.now());
  private conns = new Map<string, MachineConn>();
  private nextToast = 1;

  constructor() {
    setInterval(() => (this.now = Date.now()), 1000);
  }

  async boot() {
    this.bootError = null;
    try {
      const r = await api.me();
      this.needsSetup = r.setup;
      this.user = r.user ?? false;
      if (r.user) void this.loadMachines();
    } catch (e) {
      this.bootError = plainError(e);
    }
  }
  signedIn(u: User) {
    this.user = u;
    this.needsSetup = false;
    void this.loadMachines();
  }
  async signOut() {
    // (This browser's notifications were the person's: the next one here doesn't get them.)
    await disablePush().catch(() => {});
    await api.logout().catch(() => {});
    for (const c of this.conns.values()) c.close();
    this.conns.clear();
    this.machines = [];
    this.machinesLoaded = false;
    this.user = false;
    // Drafts and recent choices stay with the person who wrote them, not the next one on this browser.
    try { for (const k of Object.keys(localStorage)) if (k.startsWith('coderail.') && !k.startsWith('coderail.theme')) localStorage.removeItem(k); } catch {}
  }

  async loadMachines() {
    try {
      this.machines = await api.machines();
      this.machinesError = null;
    } catch (e) {
      this.machinesError = plainError(e);
      if ((e as any)?.status === 401) this.user = false;
    }
    this.machinesLoaded = true;
  }
  machine(id: string) { return this.machines.find((m) => m.id === id); }

  /** The live connection to a machine (opened on first use). */
  conn(id: string): MachineConn {
    let c = this.conns.get(id);
    if (!c) { c = new MachineConn(id); this.conns.set(id, c); }
    return c;
  }
  dropConn(id: string) { this.conns.get(id)?.close(); this.conns.delete(id); }

  toast(text: string, icon = 'info', action?: Toast['action']) {
    const t = { id: this.nextToast++, text, icon, action };
    this.toasts = [...this.toasts, t].slice(-3);
  }
  dismissToast(id: number) { this.toasts = this.toasts.filter((t) => t.id !== id); }
  confirmIt(c: Confirm) { this.confirm = c; }
  ask(p: Prompt) { this.prompt = p; }
  /** Runs an action, toasting its error. → whether it worked. */
  async act(f: () => Promise<unknown>, ok?: string): Promise<boolean> {
    try { await f(); if (ok) this.toast(ok, 'success'); return true; } catch (e) { this.toast(plainError(e), 'warning'); return false; }
  }
}

export const app = new App();

/** Copies text, with a toast. */
export async function copyText(text: string, say?: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    if (say) app.toast(say, 'check');
    return true;
  } catch {
    // (No clipboard API: an off-screen textarea.)
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok && say) app.toast(say, 'check');
    return ok;
  }
}
