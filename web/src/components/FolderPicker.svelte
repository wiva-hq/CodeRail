<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A folder on the machine, picked by walking it (`fs.home` for where to start: the caller's folders, or home;
  // `fs.list` for each folder's folders). The path as breadcrumbs; ↑ to the parent; a folder's row opens it; the
  // folder shown is the one picked (`value`). A path can also be typed (the ⌨ button, or a double-click on the path):
  // ~ for home, Return goes there once the computer can list it, and says why when it can't. Like the Mac's file
  // picker, for those who may change files: New Folder (named in place, then opened), and on each folder's ⋯ or a
  // right-click, Rename… (in place) and Move to Trash.
  import { untrack } from 'svelte';
  import type { DirEntry } from '@coderail/protocol';
  import type { MachineConn } from '../lib/machine.svelte';
  import { tilde, untilde, parentOf } from '../lib/machineText';
  import Icon from './Icon.svelte';
  import Button from './ui/Button.svelte';
  import Menu, { type Item } from './ui/Menu.svelte';
  import { app } from '../lib/app.svelte';
  import { plainError } from '../lib/api';
  import { layer } from '../lib/layer.svelte';
  let { conn, value = $bindable(''), height = 280 }: { conn: MachineConn; value?: string; height?: number } = $props();
  let roots = $state<string[]>([]);
  let home = $state<string | null>(null);
  let dirs = $state<DirEntry[] | null>(null);
  let error = $state<string | null>(null);
  let hidden = $state(false);

  async function start() {
    try {
      const r = await conn.call<{ home: string; roots: string[] }>('fs.home');
      home = r.home; roots = r.roots ?? [r.home];
      if (!value) value = roots[0] ?? r.home;
    } catch (e) { error = (e as Error).message; }
  }
  $effect(() => { untrack(start); });
  /** Why a folder can't be shown, in words (the computer says ENOENT, EACCES and the like). */
  function folderError(e: unknown): string {
    const m = plainError(e);
    if (/ENOENT|no such file/i.test(m)) return 'That folder doesn’t exist on this computer';
    if (/ENOTDIR|not a directory/i.test(m)) return 'That’s a file, not a folder';
    if (/EACCES|EPERM|permission denied|not permitted/i.test(m)) return 'This computer won’t let CodeRail open that folder';
    return m;
  }
  async function list(path: string) {
    dirs = null; error = null;
    try {
      const r = await conn.call<{ path: string; entries: DirEntry[] }>('fs.list', { path, hidden });
      if (path !== value) return; // (a slow answer for a folder already left)
      dirs = r.entries.filter((e) => e.kind === 'dir' || e.kind === 'link').sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) { if (path === value) { error = folderError(e); dirs = []; } }
  }

  // ---- A typed path
  /** The path being typed, or null; why the last one typed couldn't be opened. */
  let typing = $state<string | null>(null);
  let typeError = $state<string | null>(null);
  let checking = $state(false);
  function startTyping() { typing = tilde(value, home); typeError = null; }
  function focusPath(el: HTMLInputElement) {
    el.focus();
    el.select();
    return layer.push('popover', () => { typing = null; typeError = null; });
  }
  async function goTyped() {
    const t = (typing ?? '').trim();
    if (!t) return;
    const path = untilde(t, home).replace(/(.)\/+$/, '$1');
    if (!path.startsWith('/')) { typeError = 'Type a full path, starting with / or ~'; return; }
    checking = true; typeError = null;
    try {
      await conn.call('fs.list', { path, hidden: false });
      value = path; typing = null;
    } catch (e) { typeError = folderError(e); }
    finally { checking = false; }
  }
  $effect(() => { void hidden; if (value) { const v = value; untrack(() => list(v)); } });
  // ---- New Folder, Rename…, Move to Trash
  const can = $derived(conn.canAct);
  /** A row being named in place: a new folder (path null) or a folder being renamed. */
  let editing = $state<{ path: string | null; name: string } | null>(null);
  let menu = $state<{ d: DirEntry; anchor?: HTMLElement; x?: number; y?: number } | null>(null);
  // (While a name is typed, Esc cancels it, not the sheet the picker is in: the field is a layer of its own.)
  function focusName(el: HTMLInputElement) {
    el.focus();
    el.select();
    return layer.push('popover', () => (editing = null));
  }
  async function commit() {
    const e = editing;
    if (!e) return;
    const name = e.name.trim();
    editing = null;
    if (!name || name.includes('/') || name === '.' || name === '..') { if (name) app.toast('That isn’t a folder name', 'warning'); return; }
    const target = `${value === '/' ? '' : value}/${name}`;
    try {
      if (e.path === null) {
        await conn.call('fs.mkdir', { path: target });
        value = target;
      } else if (target !== e.path) {
        await conn.call('fs.rename', { from: e.path, to: target });
        await list(value);
      }
    } catch (err) { app.toast(plainError(err), 'warning'); }
  }
  function nameKey(ev: KeyboardEvent) {
    if (ev.key === 'Enter') { ev.preventDefault(); void commit(); }

  }
  function trash(d: DirEntry) {
    app.confirmIt({ title: `Move “${d.name}” to the Trash?`, body: 'It goes to the computer’s Trash, with everything in it.', yes: 'Move to Trash', danger: true,
      run: async () => { await conn.call('fs.trash', { path: d.path }); await list(value); } });
  }
  const rowItems: Item[] = [{ id: 'rename', label: 'Rename…', icon: 'rename' }, { id: 'trash', label: 'Move to Trash', icon: 'trash', danger: true }];
  function pick(id: string) {
    const d = menu?.d;
    menu = null;
    if (!d) return;
    if (id === 'rename') editing = { path: d.path, name: d.name };
    if (id === 'trash') trash(d);
  }

  /** Up stops at a root (an operator limited to folders can't leave them). */
  const atRoot = $derived(roots.some((r) => r === value) || value === '/');
  const crumbs = $derived.by(() => {
    const root = roots.filter((r) => value === r || value.startsWith(r + '/')).sort((a, b) => b.length - a.length)[0] ?? '';
    const rest = value.slice(root.length).split('/').filter(Boolean);
    const out = [{ label: root ? tilde(root, home) : '/', path: root || '/' }];
    let at = root;
    for (const r of rest) { at = `${at}/${r}`; out.push({ label: r, path: at }); }
    return out;
  });
</script>

<div class="picker">
  <div class="where">
    <Button variant="icon" size="sm" icon="chevl" tip="Up" disabled={atRoot} onclick={() => (value = parentOf(value))} />
    {#if typing !== null}
      <!-- (Not a form: the picker sits inside the New session form, which Return must not submit.) -->
      <div class="typed">
        <input class="path" class:bad={!!typeError} bind:value={typing} oninput={() => (typeError = null)} {@attach focusPath} spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Folder path" aria-invalid={!!typeError}
          onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void goTyped(); } }} />
        {#if checking}<span class="spinner"></span>{/if}
      </div>
    {:else}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="crumbs" ondblclick={(e) => { if (e.target === e.currentTarget) startTyping(); }}>
        {#each crumbs as c, i (c.path)}
          {#if i}<span class="sl">/</span>{/if}
          <button class="cr" class:last={i === crumbs.length - 1} onclick={() => (value = c.path)}>{c.label}</button>
        {/each}
      </div>
      <Button variant="icon" size="sm" icon="rename" tip="Type a path" onclick={startTyping} />
    {/if}
    <Button variant="icon" size="sm" icon={hidden ? 'eye' : 'eyeoff'} tip={hidden ? 'Hide hidden folders' : 'Show hidden folders'} onclick={() => (hidden = !hidden)} />
  </div>
  {#if typing !== null && typeError}<div class="perr" role="alert"><Icon name="warning" size={14} />{typeError}</div>{/if}
  {#if roots.length > 1}
    <div class="roots">{#each roots as r (r)}<button class="chip" class:on={value === r || value.startsWith(r + '/')} onclick={() => (value = r)}>{tilde(r, home)}</button>{/each}</div>
  {/if}
  <div class="list scroll" style:height="{height}px">
    {#if error}<div class="note bad"><Icon name="warning" size={14} />{error}</div>
    {:else if !dirs}<div class="note"><span class="spinner"></span></div>
    {:else}
      {#if editing?.path === null}
        <div class="row edit"><span class="ico"><Icon name="folder" size={16} /></span>
          <input class="name" bind:value={editing.name} onkeydown={nameKey} onblur={commit} {@attach focusName} aria-label="New folder name" /></div>
      {/if}
      {#if !dirs.length && editing?.path !== null}<div class="note">No folders here</div>{/if}
      {#each dirs as d (d.path)}
        {#if editing?.path === d.path}
          <div class="row edit"><span class="ico"><Icon name="folder" size={16} /></span>
            <input class="name" bind:value={editing.name} onkeydown={nameKey} onblur={commit} {@attach focusName} aria-label="Folder name" /></div>
        {:else}
          <div class="rowwrap">
            <button class="row" onclick={() => (value = d.path)} oncontextmenu={(e) => { if (!can) return; e.preventDefault(); menu = { d, x: e.clientX, y: e.clientY }; }}>
              <span class="ico"><Icon name="folder" size={16} /></span><span class="n cut">{d.name}</span><Icon name="chevr" size={12} />
            </button>
            {#if can}<span class="more"><Button variant="icon" size="xs" icon="more" tip="More" onclick={(e) => (menu = { d, anchor: e.currentTarget as HTMLElement })} /></span>{/if}
          </div>
        {/if}
      {/each}
    {/if}
  </div>
  {#if can}
    <div class="foot">
      <Button size="sm" icon="plus" disabled={!dirs || !!error} onclick={() => (editing = { path: null, name: 'untitled folder' })}>New Folder</Button>
    </div>
  {/if}
</div>

{#if menu}
  <Menu items={rowItems} anchor={menu.anchor} x={menu.x} y={menu.y} end={!!menu.anchor} width={190} onpick={pick} onclose={() => (menu = null)} />
{/if}

<style>
  .picker { display: flex; flex-direction: column; gap: var(--sp-2); border-radius: var(--r-lg); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); padding: var(--sp-2); background: var(--panel); }
  .where { display: flex; align-items: center; gap: var(--sp-1); }
  .crumbs { flex: 1; min-width: 0; display: flex; align-items: center; overflow-x: auto; scrollbar-width: none; font-size: var(--fs-small); white-space: nowrap; }
  .cr { padding: var(--sp-0h) var(--sp-1); border-radius: var(--r-xs); color: var(--muted); }
  .cr:hover { background: var(--hover); color: var(--ink); }
  .cr.last { color: var(--ink); font-weight: var(--w-control); }
  .sl { color: var(--faint); }
  .typed { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-1h); }
  .path { flex: 1; min-width: 0; height: 26px; padding: 0 var(--sp-1h); border: 0; outline: 0; border-radius: var(--r-xs); background: var(--panel); box-shadow: inset 0 0 0 1.5px var(--accent-ring, var(--hair2)); font-family: var(--mono); font-size: 12.5px; color: var(--ink); }
  .path.bad { box-shadow: inset 0 0 0 1.5px var(--danger-ink); }
  .perr { display: flex; align-items: center; gap: var(--sp-1h); padding: 0 var(--sp-1); color: var(--danger-ink); font-size: var(--fs-small); }
  .roots { display: flex; flex-wrap: wrap; gap: var(--sp-1h); }
  .roots .chip { height: 26px; font-family: var(--mono); font-size: 12px; }
  .roots .chip.on { background: var(--sel); color: var(--ink); }
  .list { display: flex; flex-direction: column; gap: var(--row-gap); }
  .row { height: 30px; flex: none; gap: var(--sp-2); font-size: var(--fs-quiet); color: var(--ink); }
  .row .n { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; }
  .rowwrap { position: relative; display: flex; flex: none; }
  .rowwrap .row { flex: 1; min-width: 0; }
  .more { position: absolute; right: 22px; top: 50%; transform: translateY(-50%); opacity: 0; transition: opacity var(--t-fast) ease-out; }
  .rowwrap:hover .more, .rowwrap:focus-within .more { opacity: 1; }
  /* (Touch screens have no hover: the ⋯ is always there.) */
  @media (hover: none) { .more { opacity: 1; } }
  .row.edit { display: flex; align-items: center; padding: 0 var(--row-x); border-radius: var(--r-md); background: var(--sel); }
  .name { flex: 1; min-width: 0; height: 24px; padding: 0 var(--sp-1); border: 0; outline: 0; border-radius: var(--r-xs); background: var(--panel); box-shadow: inset 0 0 0 1.5px var(--accent-ring, var(--hair2)); font: inherit; color: var(--ink); }
  .foot { display: flex; align-items: center; gap: var(--sp-2); padding-top: var(--sp-1); box-shadow: inset 0 var(--hairline) 0 var(--hair); }
  .row :global(svg:last-child) { color: var(--faint); }
  .note { display: flex; align-items: center; justify-content: center; gap: var(--sp-2); padding: var(--sp-6); color: var(--muted); font-size: var(--fs-quiet); }
  .note.bad { color: var(--danger-ink); }
</style>
