<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // One person's access to a machine, as a dialog: who (when giving someone access: the people who don't have it
  // yet), the role as three cards, and for an operator the folders, the agents and the terminal. Nothing changes
  // until Save; Remove access is here too for someone who has it.
  import { HARNESSES, type Role } from '@coderail/protocol';
  import type { Grant } from '../lib/api';
  import Sheet from './ui/Sheet.svelte';
  import Button from './ui/Button.svelte';
  import Switch from './ui/Switch.svelte';
  import Icon from './Icon.svelte';
  import HarnessMark from './HarnessMark.svelte';
  let { machine, grant, people = [], onsave, onremove, onclose }: {
    machine: string;
    /** Someone's access to change; none to give someone access. */
    grant?: Grant;
    /** Who may be given access (without `grant`). */
    people?: { id: string; username: string }[];
    onsave: (g: Grant) => Promise<boolean>;
    onremove?: () => void;
    onclose: () => void;
  } = $props();
  const ROLES: { id: Role; label: string; desc: string; icon: string }[] = [
    { id: 'viewer', label: 'Viewer', desc: 'Sees sessions, files and diffs. Changes nothing.', icon: 'eye' },
    { id: 'operator', label: 'Operator', desc: 'Drives agents, files and git, within the folders and agents you pick.', icon: 'play' },
    { id: 'owner', label: 'Owner', desc: 'Everything, the terminal, and who has access.', icon: 'crown' },
  ];
  // svelte-ignore state_referenced_locally
  const g0 = grant;
  // svelte-ignore state_referenced_locally
  let who = $state(g0?.userId ?? people[0]?.id ?? '');
  let role = $state<Role>(g0?.role ?? 'viewer');
  let folders = $state((g0?.folders ?? []).join('\n'));
  let harnesses = $state<string[] | null>(g0?.harnesses ?? null);
  let terminal = $state(g0?.terminal ?? false);
  let busy = $state(false);
  const name = $derived(g0?.username ?? people.find((p) => p.id === who)?.username ?? '');
  function toggle(h: string) {
    const all = HARNESSES.map((x) => x.id);
    const cur = harnesses ?? all;
    const v = cur.includes(h) ? cur.filter((x) => x !== h) : [...cur, h];
    harnesses = v.length === all.length ? null : v;
  }
  async function save() {
    if (!who) return;
    const list = folders.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    const op = role === 'operator';
    busy = true;
    const ok = await onsave({
      userId: who, username: name, role,
      folders: op && list.length ? list : null,
      harnesses: op ? harnesses : null,
      terminal: role === 'owner' ? true : role === 'viewer' ? false : terminal,
    });
    busy = false;
    if (ok) onclose();
  }
</script>

<Sheet title={g0 ? `${g0.username} on ${machine}` : `Give access to ${machine}`} width={520} {onclose} autofocus={false}>
  {#if !g0}
    <div class="lbl">Person</div>
    <div class="people">
      {#each people as p (p.id)}
        <button class="person" class:on={who === p.id} onclick={() => (who = p.id)} aria-pressed={who === p.id}>
          <span class="av">{p.username[0]?.toUpperCase()}</span><span class="cut">{p.username}</span>
          {#if who === p.id}<span class="ck"><Icon name="check" size={16} /></span>{/if}
        </button>
      {/each}
    </div>
  {/if}
  <div class="lbl">Role</div>
  <div class="roles" role="radiogroup" aria-label="Role">
    {#each ROLES as r (r.id)}
      <button class="role" class:on={role === r.id} role="radio" aria-checked={role === r.id} onclick={() => (role = r.id)}>
        <span class="ri"><Icon name={r.icon} size={16} /></span>
        <span class="rt"><b>{r.label}</b><span>{r.desc}</span></span>
        <span class="dot" aria-hidden="true"></span>
      </button>
    {/each}
  </div>
  {#if role === 'operator'}
    <label class="lbl" for="g-folders">Folders <span class="q">one per line, empty = all</span></label>
    <textarea id="g-folders" class="field mono" rows={Math.max(2, folders.split('\n').length)} bind:value={folders} placeholder="Everywhere"></textarea>
    <div class="lbl">Agents</div>
    <div class="hchips">
      {#each HARNESSES as h (h.id)}
        {@const on = !harnesses || harnesses.includes(h.id)}
        <button class="chip" class:on onclick={() => toggle(h.id)} aria-pressed={on}><HarnessMark harness={h.id} size={16} bare />{h.name}{#if on}<Icon name="check" size={14} />{/if}</button>
      {/each}
    </div>
    <label class="term"><Switch on={terminal} label="Terminal" onchange={(v) => (terminal = v)} /><span>Terminal <span class="q">ignores folder limits</span></span></label>
  {/if}
  {#snippet footer()}
    {#if g0 && onremove}<Button variant="danger" onclick={() => { onclose(); onremove(); }}>Remove access</Button>{/if}
    <span class="sp"></span>
    <Button onclick={onclose}>Cancel</Button>
    <Button variant="primary" {busy} disabled={!who} onclick={save}>{g0 ? 'Save' : 'Give access'}</Button>
  {/snippet}
</Sheet>

<style>
  .lbl { display: block; margin: var(--sp-4) 0 var(--sp-2); font-size: var(--fs-small); font-weight: var(--w-control); color: var(--ink2); }
  .lbl:first-child { margin-top: 0; }
  .q { font-weight: normal; color: var(--muted); margin-left: var(--sp-1); }
  .people { display: flex; flex-wrap: wrap; gap: var(--sp-1h); }
  .person { display: inline-flex; align-items: center; gap: var(--sp-2); height: 36px; padding: 0 var(--sp-3) 0 var(--sp-1); border-radius: 18px; box-shadow: inset 0 0 0 var(--hairline) var(--hair2); color: var(--ink2); max-width: 220px; }
  .person.on { box-shadow: inset 0 0 0 1.5px var(--ink); color: var(--ink); }
  .av { width: 28px; height: 28px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--p4-bg); color: var(--p4-fg); font-size: 12px; font-weight: var(--w-strong); }
  .ck { display: inline-flex; color: var(--ink); }
  .roles { display: flex; flex-direction: column; gap: var(--sp-1h); }
  .role { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-3); border-radius: var(--r-lg); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); text-align: left; }
  .role:hover { background: var(--hover); }
  .role.on { box-shadow: inset 0 0 0 1.5px var(--ink); }
  .ri { width: 32px; height: 32px; border-radius: 9px; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--sel); color: var(--ink2); }
  .rt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .rt b { font-weight: var(--w-control); color: var(--ink); }
  .rt span { font-size: var(--fs-small); color: var(--muted); line-height: 1.4; }
  .dot { width: 18px; height: 18px; border-radius: 50%; flex: none; box-shadow: inset 0 0 0 1.5px var(--hair2); }
  .role.on .dot { box-shadow: inset 0 0 0 5px var(--ink); }
  textarea { width: 100%; font-size: 12.5px; }
  .hchips { display: flex; flex-wrap: wrap; gap: var(--sp-1h); }
  .hchips .chip { height: 30px; }
  .hchips .chip.on { color: var(--ink); background: var(--sel); }
  .term { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-4); font-size: var(--fs-quiet); }
  .sp { flex: 1; }
</style>
