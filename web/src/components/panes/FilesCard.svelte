<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Files (on `fs.list`), as the Claude app draws them: the filter on top (it filters what has been read and reads
  // the rest, up to 3000 entries), then the tree: a folder is a chevron and its name, a file its kind's glyph and its
  // name, a line down each open folder's children, hidden files shown. Rooted at the session's folder, or one picked
  // from the ⋯ beside the filter (with New file, New folder, hidden files, Refresh). A file opens in the card. Any file
  // downloads, a folder as a .zip; files dropped on the tree (or on a folder in it), or chosen with Upload files…,
  // are uploaded there in parts, each with its progress until it's done. The tree keeps up with the computer: a folder
  // shown is listed again when something in it changes there.
  import { untrack } from 'svelte';
  import type { DirEntry } from '@coderail/protocol';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { plainError } from '../../lib/api';
  import { app, copyText } from '../../lib/app.svelte';
  import { edges } from '../../lib/edges';
  import { tilde, parentOf, join } from '../../lib/machineText';
  import { downloadFile, downloadFolder, kindOf, newUpload, upload, type Kind, type Upload } from '../../lib/files';
  import { fileSize } from '../../lib/format';
  import { tip } from '../../lib/tip';
  import Icon from '../Icon.svelte';
  import CardLoad from '../CardLoad.svelte';
  import FileViewer from './FileViewer.svelte';
  import FolderPicker from '../FolderPicker.svelte';
  import Button from '../ui/Button.svelte';
  import Sheet from '../ui/Sheet.svelte';
  import Menu, { type Item } from '../ui/Menu.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  let { conn, cwd = null }: { conn: MachineConn; cwd?: string | null } = $props();
  type Row = { name: string; path: string; kind: 'folder' | 'file'; depth: number; size: number };
  let chosen = $state<string | null>(null);
  let homeRoot = $state<string | null>(null);
  // (Another session's folder: the tree follows it, unless you picked one.)
  $effect(() => { void cwd; untrack(() => { chosen = null; }); });
  const root = $derived(chosen ?? cwd ?? homeRoot);
  $effect(() => { if (!cwd && !homeRoot && conn.online) conn.call<{ home: string; roots: string[] }>('fs.home').then((r) => (homeRoot = r.roots?.[0] ?? r.home)).catch(() => {}); });
  let rows = $state<Row[] | null>(null);
  let open = $state<Set<string>>(new Set());
  let kids = $state<Record<string, Row[]>>({});
  let q = $state('');
  let error = $state<string | null>(null);
  let file = $state<string | null>(null);
  let hidden = $state(true);
  let picking = $state(false);
  let pickValue = $state('');
  let menu = $state<{ r: Row; anchor?: HTMLElement; x?: number; y?: number } | null>(null);
  let crawling = $state(false);
  // (Plain objects, read again by reassigning: the upload loop and the Cancel button share them.)
  let uploads = $state.raw<Upload[]>([]);
  let chooser = $state<HTMLInputElement | null>(null);
  let chooseFor = $state<string | null>(null);
  /** The folder files dragged over would go to (the root, or a folder row under the pointer). */
  let dropAt = $state<string | null>(null);

  async function list(path: string, depth = 0): Promise<Row[]> {
    // (Subscribed first: the computer watches the folder from the moment it's listed.)
    watch(path);
    const r = await conn.call<{ entries: DirEntry[] }>('fs.list', { path, hidden });
    return (r.entries ?? []).filter((e) => e.name !== '.git').map((e) => ({ name: e.name, path: e.path, kind: (e.kind === 'dir' ? 'folder' : 'file') as Row['kind'], depth, size: e.size }))
      .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'folder' ? -1 : 1));
  }
  async function load() {
    const at = root;
    if (!at) return;
    error = null;
    try {
      const r = await list(at);
      const k: Record<string, Row[]> = {};
      for (const o of open) if (o.startsWith(at + '/')) k[o] = await list(o, o.slice(at.length + 1).split('/').length).catch(() => []);
      // (The root changed meanwhile: this answer is for another folder.)
      if (at !== root) return;
      rows = r; kids = k;
    } catch (e) { if (at === root) { error = plainError(e); rows = rows ?? []; } }
  }
  $effect(() => { void root; void hidden; void conn.online; untrack(() => { rows = null; kids = {}; open = new Set(); if (root && conn.online) void load(); }); });
  // ---- live: each folder shown is watched on the computer (`fs:<folder>`) and listed again when something in it changes
  const subs = new Map<string, () => void>();
  function watch(dir: string) {
    if (!subs.has(dir)) subs.set(dir, conn.subscribe('fs:' + dir, () => void relist(dir)));
  }
  // (The root, the open folders, and while searching every folder read: the rest stop.)
  $effect(() => {
    const keep = new Set<string>([root ?? '', ...open, ...(q.trim() ? Object.keys(kids) : [])]);
    untrack(() => { for (const [dir, off] of subs) if (!keep.has(dir)) { off(); subs.delete(dir); } });
  });
  $effect(() => {
    const offRe = conn.onReconnect(() => void load());
    return () => { offRe(); for (const off of subs.values()) off(); subs.clear(); };
  });
  /** A folder read again where it's shown: the root, or one whose children were read. */
  async function relist(dir: string) {
    if (!root) return;
    if (dir === root) { const r = await list(root).catch(() => null); if (r && root === dir) rows = r; return; }
    if (!dir.startsWith(root + '/') || !kids[dir]) return;
    const l = await list(dir, dir.slice(root.length + 1).split('/').length).catch(() => null);
    if (l && kids[dir]) kids = { ...kids, [dir]: l };
  }
  async function toggle(r: Row) {
    const o = new Set(open);
    if (o.has(r.path)) { o.delete(r.path); open = o; return; }
    o.add(r.path);
    open = o;
    // (What was read before shows at once; it's read again, and watched again, since it wasn't while closed.)
    if (kids[r.path]) void relist(r.path);
    else kids = { ...kids, [r.path]: await list(r.path, r.depth + 1).catch(() => []) };
  }
  async function crawl() {
    if (crawling) return;
    crawling = true;
    let seen = (rows?.length ?? 0) + Object.values(kids).reduce((n, l) => n + l.length, 0);
    const todo = [...(rows ?? []), ...Object.values(kids).flat()].filter((r) => r.kind === 'folder' && !kids[r.path] && !/^(node_modules|\.|dist|build|target)/.test(r.name));
    while (todo.length && seen < 3000 && q.trim()) {
      const f = todo.shift()!;
      const l = await list(f.path, f.depth + 1).catch(() => []);
      kids = { ...kids, [f.path]: l };
      seen += l.length;
      todo.push(...l.filter((r) => r.kind === 'folder' && !/^(node_modules|\.)/.test(r.name)));
    }
    crawling = false;
  }
  $effect(() => { if (q.trim()) untrack(crawl); });
  const shown = $derived.by(() => {
    if (!rows) return [];
    if (q.trim()) {
      const n = q.trim().toLowerCase();
      return [...rows, ...Object.values(kids).flat()].filter((r) => r.kind === 'file' && r.path.toLowerCase().includes(n)).map((r) => ({ ...r, depth: 0 })).slice(0, 300);
    }
    const out: Row[] = [];
    const walk = (l: Row[]) => { for (const r of l) { out.push(r); if (r.kind === 'folder' && open.has(r.path)) walk(kids[r.path] ?? []); } };
    walk(rows);
    return out;
  });
  const can = $derived(conn.canAct);
  function items(r: Row): Item[] {
    const out: Item[] = [];
    if (r.kind === 'file') out.push({ id: 'view', label: 'Open', icon: 'file' }, { id: 'download', label: 'Download', icon: 'download', disabled: !conn.online });
    else {
      out.push({ id: 'newfile', label: 'New file…', icon: 'plus', disabled: !can }, { id: 'newdir', label: 'New folder…', icon: 'folder', disabled: !can });
      out.push({ id: 'upload', label: 'Upload files…', icon: 'upload', disabled: !can }, { id: 'zip', label: 'Download as .zip', icon: 'download', disabled: !conn.online });
      out.push({ id: 'root', label: 'Show only this folder', icon: 'folder' });
    }
    out.push({ id: 's1', sep: true });
    out.push({ id: 'rename', label: 'Rename…', icon: 'rename', disabled: !can }, { id: 'copy', label: 'Copy path', icon: 'copy' });
    out.push({ id: 's2', sep: true }, { id: 'trash', label: 'Move to Trash…', icon: 'trash', danger: true, disabled: !can });
    return out;
  }
  function pick(id: string, r: Row) {
    if (id === 'view') file = r.path;
    else if (id === 'root') chosen = r.path;
    else if (id === 'copy') copyText(r.path, 'Path copied');
    else if (id === 'newfile') newFile(r.path);
    else if (id === 'newdir') newFolder(r.path);
    else if (id === 'rename') rename(r);
    else if (id === 'trash') trash(r);
    else if (id === 'download') void app.act(() => downloadFile(conn.id, r.path));
    else if (id === 'zip') void zip(r.path);
    else if (id === 'upload') choose(r.path);
  }

  // ---- downloads and uploads
  async function zip(dir: string) {
    app.toast(`Zipping ${dir.split('/').pop() || dir}…`, 'download');
    await app.act(() => downloadFolder(conn.id, dir));
  }
  function choose(dir: string) {
    chooseFor = dir;
    chooser?.click();
  }
  let running = false;
  /** Files into a folder, one after another (each in parts); the folder is read again as each lands. */
  async function send(list: File[], dir: string) {
    if (!can) return app.toast(conn.online ? 'Viewers can’t upload' : 'The computer is offline', 'warning');
    const jobs = list.map((f) => ({ f, u: newUpload(f, dir) }));
    uploads = [...uploads, ...jobs.map((j) => j.u)];
    if (running) { queue.push(...jobs); return; }
    queue.push(...jobs);
    running = true;
    while (queue.length) {
      const { f, u } = queue.shift()!;
      if (u.cancel) { drop(u); continue; }
      try {
        await upload(conn, f, u, () => (uploads = [...uploads]));
        drop(u);
        await refresh(u.dir);
      } catch (e) {
        if (u.cancel) drop(u);
        else { u.error = plainError(e); uploads = [...uploads]; }
      }
    }
    running = false;
  }
  const queue: { f: File; u: Upload }[] = [];
  function drop(u: Upload) { uploads = uploads.filter((x) => x !== u); }
  function picked(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const list = [...(input.files ?? [])];
    input.value = '';
    if (list.length && chooseFor) void send(list, chooseFor);
  }
  const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  function over(e: DragEvent, dir: string | null) {
    if (!hasFiles(e) || !can) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    dropAt = dir ?? root;
  }
  function dropped(e: DragEvent) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const dir = dropAt ?? root;
    dropAt = null;
    // (Files only: a dropped folder has no bytes of its own to send.)
    const list = [...(e.dataTransfer?.files ?? [])].filter((f) => f.size > 0 || f.type !== '');
    if (dir && list.length) void send(list, dir);
  }

  // ---- changing the tree (operators, the machine online): names are asked in a sheet, never the browser's prompt
  /** A folder read again (the root, or an open one) and opened, after something changed in it. */
  async function refresh(dir: string) {
    if (!root) return;
    if (dir === root) { const r = await list(root).catch(() => null); if (r && root === dir) rows = r; return; }
    const depth = dir.slice(root.length + 1).split('/').length;
    kids = { ...kids, [dir]: await list(dir, depth).catch(() => []) };
    if (!open.has(dir)) open = new Set([...open, dir]);
  }
  const bad = (v: string) => (!v || v === '.' || v === '..' || v.includes('/') ? 'A name, without “/”' : null);
  function newFile(dir: string) {
    app.ask({ title: 'New file', label: `In ${tilde(dir, conn.info?.home)}`, value: '', placeholder: 'notes.md', yes: 'Create', run: async (v) => {
      const why = bad(v); if (why) return why;
      const path = join(dir, v);
      try { await conn.call('fs.write', { path, content: '', encoding: 'utf8' }); } catch (e) { return plainError(e); }
      await refresh(dir);
      file = path;
      return null;
    } });
  }
  function newFolder(dir: string) {
    app.ask({ title: 'New folder', label: `In ${tilde(dir, conn.info?.home)}`, value: '', placeholder: 'folder', yes: 'Create', run: async (v) => {
      const why = bad(v); if (why) return why;
      const path = join(dir, v);
      try { await conn.call('fs.mkdir', { path }); } catch (e) { return plainError(e); }
      await refresh(dir);
      await refresh(path);
      return null;
    } });
  }
  function rename(r: Row) {
    app.ask({ title: `Rename ${r.kind === 'folder' ? 'folder' : 'file'}`, label: 'Name', value: r.name, yes: 'Rename', run: async (v) => {
      const why = bad(v); if (why) return why;
      if (v === r.name) return null;
      const dir = parentOf(r.path);
      try { await conn.call('fs.rename', { from: r.path, to: join(dir, v) }); } catch (e) { return plainError(e); }
      if (r.kind === 'folder') { const k = { ...kids }; for (const x of Object.keys(k)) if (x === r.path || x.startsWith(r.path + '/')) delete k[x]; kids = k; open = new Set([...open].filter((x) => x !== r.path && !x.startsWith(r.path + '/'))); }
      await refresh(dir);
      return null;
    } });
  }
  function trash(r: Row) {
    app.confirmIt({ title: `Move ${r.name} to the Trash?`, body: `On ${conn.info?.hostname ?? 'the computer'}, from ${tilde(parentOf(r.path), conn.info?.home)}. You can put it back from the computer’s Trash.`, yes: 'Move to Trash', danger: true,
      run: async () => {
        await conn.call('fs.trash', { path: r.path });
        if (file === r.path) file = null;
        await refresh(parentOf(r.path));
      } });
  }
  let more = $state<HTMLElement | null>(null);
  const moreItems = $derived<Item[]>([
    { id: 'pick', label: 'Choose a folder…', icon: 'folder', disabled: !conn.online },
    ...(chosen && cwd ? [{ id: 'session', label: 'Back to the session folder', icon: 'arrowl' }] : []),
    { id: 's0', sep: true },
    { id: 'newfile', label: 'New file…', icon: 'plus', disabled: !can || !root },
    { id: 'newdir', label: 'New folder…', icon: 'folder', disabled: !can || !root },
    { id: 'upload', label: 'Upload files…', icon: 'upload', disabled: !can || !root },
    { id: 'zip', label: 'Download as .zip', icon: 'download', disabled: !conn.online || !root },
    { id: 's1', sep: true },
    { id: 'hidden', label: 'Show hidden files', icon: 'eye', on: hidden },
    { id: 'refresh', label: 'Refresh', icon: 'refresh', disabled: !conn.online },
    ...(root ? [{ id: 'copyroot', label: 'Copy folder path', icon: 'copy' }] : []),
  ]);
  function pickMore(id: string) {
    if (id === 'pick') { pickValue = root ?? ''; picking = true; }
    else if (id === 'session') chosen = null;
    else if (id === 'newfile' && root) newFile(root);
    else if (id === 'newdir' && root) newFolder(root);
    else if (id === 'hidden') hidden = !hidden;
    else if (id === 'refresh') void load();
    else if (id === 'copyroot' && root) copyText(root, 'Path copied');
    else if (id === 'upload' && root) choose(root);
    else if (id === 'zip' && root) void zip(root);
  }
  /** A file's glyph by its kind: a picture, something that plays, an archive, code, else a plain page. */
  const CODE = /\.(m?[jt]sx?|c[jt]s|svelte|vue|json|jsonc|ya?ml|toml|html?|css|s[ac]ss|less|md|mdx|py|rb|go|rs|swift|kt|java|c|h|cc|cpp|hpp|cs|php|sh|zsh|bash|sql|graphql|lua|ex|exs|zig|dart|xml|svg|ini|conf|lock|ipynb)$/i;
  const GLYPH: Partial<Record<Kind, string>> = { image: 'photo', video: 'play', audio: 'play', zip: 'stack' };
  const glyph = (name: string) => GLYPH[kindOf(name)] ?? (CODE.test(name) ? 'code' : 'file');
  async function back(folder?: string) {
    file = null;
    if (!folder || !root) return;
    const parts = folder.slice(root.length + 1).split('/').filter(Boolean);
    const o = new Set(open);
    for (let i = 1; i <= parts.length; i++) {
      const at = root + '/' + parts.slice(0, i).join('/');
      o.add(at);
      if (!kids[at]) kids = { ...kids, [at]: await list(at, i).catch(() => []) };
    }
    open = o;
  }
  const rel = (p: string) => (root && p.startsWith(root + '/') ? p.slice(root.length + 1) : p);
</script>

{#if file && root}
  <FileViewer {conn} path={file} {root} onback={back} />
{:else}
  <div class="body scroll" class:dropping={dropAt === root} role="group" aria-label="Files" {@attach edges()}
    ondragover={(e) => over(e, null)} ondragleave={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) dropAt = null; }} ondrop={dropped}>
    {#if !conn.online}<EmptyState compact icon="folder" text="The computer is offline" />
    {:else if !root}<CardLoad retry={() => {}} />
    {:else}
      <div class="top">
        <label class="find"><Icon name="search" size={16} /><input placeholder="Filter files" bind:value={q} aria-label="Filter files"
          onkeydown={(e) => { if (e.key === 'Escape' && q) { e.stopPropagation(); q = ''; } }} />{#if crawling}<span class="spinner"></span>{/if}</label>
        <Button icon="more" variant="icon" size="sm" tip={root ? `${tilde(root, conn.info?.home)}` : 'More'} on={!!more} onclick={(e) => (more = more ? null : (e.currentTarget as HTMLElement))} />
      </div>
      {#if uploads.length}
        <div class="ups">
          {#each uploads as u (u.id)}
            <div class="up" class:bad={!!u.error}>
              <Icon name={u.error ? 'warning' : 'upload'} size={16} />
              <span class="un cut" {@attach tip(u.error ?? `To ${tilde(u.dir, conn.info?.home)}`)}>{u.name}</span>
              {#if u.error}<span class="us">Failed</span>
              {:else}<span class="bar"><span style:width="{u.size ? (u.sent / u.size) * 100 : 0}%"></span></span><span class="us">{fileSize(u.sent)} of {fileSize(u.size)}</span>{/if}
              <Button icon="close" variant="icon" size="xs" tip={u.error ? 'Dismiss' : 'Cancel'} onclick={() => { u.cancel = true; if (u.error || !running) drop(u); }} />
            </div>
          {/each}
        </div>
      {/if}
      {#if !rows || error}<CardLoad {error} retry={load} />
      {:else if !rows.length}<EmptyState compact icon="folder" text="Empty folder" />
      {:else if q.trim() && !shown.length && !crawling}
        <EmptyState compact icon="search" text="No match for “{q.trim()}”" fill={false}><Button size="sm" onclick={() => (q = '')}>Clear</Button></EmptyState>
      {/if}
      {#each shown as r (r.path)}
        <div class="line" class:menu={menu?.r === r} class:drop={r.kind === 'folder' && dropAt === r.path} style="--d:{r.depth}"
          role="group" ondragover={(e) => over(e, r.kind === 'folder' ? r.path : parentOf(r.path))}>
          {#each { length: r.depth } as _, i (i)}<span class="guide" style="--i:{i}" aria-hidden="true"></span>{/each}
          <button class="row" aria-expanded={r.kind === 'folder' ? open.has(r.path) : undefined}
            onclick={() => (r.kind === 'folder' ? toggle(r) : (file = r.path))}
            oncontextmenu={(e) => { e.preventDefault(); menu = { r, x: e.clientX, y: e.clientY }; }}>
            {#if r.kind === 'folder'}<span class="ic chev" class:on={open.has(r.path) && !q.trim()}><Icon name="chevr" size={16} stroke={1.8} /></span>
            {:else}<span class="ic"><Icon name={glyph(r.name)} size={16} /></span>{/if}
            <span class="n cut">{q.trim() ? rel(r.path) : r.name}</span>
          </button>
          <span class="acts"><Button icon="more" variant="icon" size="xs" tip="More" on={menu?.r === r} onclick={(e) => (menu = { r, anchor: e.currentTarget as HTMLElement })} /></span>
        </div>
      {/each}
    {/if}
  </div>
{/if}

{#each menu ? [menu] : [] as m (m)}
  <Menu anchor={m.anchor} x={m.x} y={m.y} end={!!m.anchor} width={230} items={items(m.r)} onpick={(id) => pick(id, m.r)} onclose={() => (menu = null)} />
{/each}
<input bind:this={chooser} type="file" multiple hidden onchange={picked} />
{#if more}
  <Menu anchor={more} end width={240} items={moreItems} onpick={pickMore} onclose={() => (more = null)} label="Files" />
{/if}
{#if picking}
  <Sheet title="Choose a folder" width={520} onclose={() => (picking = false)}>
    <FolderPicker {conn} bind:value={pickValue} height={300} />
    {#snippet footer()}
      <span class="sp"></span>
      <Button onclick={() => (picking = false)}>Cancel</Button>
      <Button variant="primary" disabled={!pickValue} onclick={() => { chosen = pickValue; open = new Set(); picking = false; }}>Open</Button>
    {/snippet}
  </Sheet>
{/if}

<style>
  .sp { flex: 1; }
  .body { padding: var(--sp-3) var(--sp-3) var(--gutter); flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .body > :global(*) { flex-shrink: 0; }
  .top { display: flex; align-items: center; gap: var(--sp-1); margin: 0 0 var(--sp-2); }
  .find { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2); height: 34px; padding: 0 var(--sp-3); border-radius: 10px; background: var(--tint); box-shadow: inset 0 0 0 var(--hairline) var(--hair); color: var(--muted); }
  .find:focus-within { box-shadow: inset 0 0 0 1px var(--hair2); }
  .find input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: none; color: var(--ink); font-size: var(--fs-quiet); }
  .find input::placeholder { color: var(--muted); }
  /* (A row: 32 tall; each level 20 in, a hairline down from its folder's chevron.) */
  .line { position: relative; display: flex; align-items: center; border-radius: 8px; transition: background var(--t-fast) ease-out; }
  .line:hover, .line.menu { background: var(--hover); }
  .guide { position: absolute; top: 0; bottom: 0; left: calc(var(--sp-2) + 8px + var(--i) * 20px); width: var(--hairline); background: var(--hair2); pointer-events: none; }
  .row { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2); height: 32px; padding: 0 var(--sp-1h) 0 calc(var(--sp-2) + var(--d) * 20px); text-align: left; font-size: var(--fs-quiet); color: var(--ink); }
  .ic { width: 16px; display: inline-flex; justify-content: center; flex: none; color: var(--ink2); }
  .chev { color: var(--muted); transition: transform var(--t-base) var(--ease-base); }
  .chev.on { transform: rotate(90deg); }
  .n { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acts { flex: none; display: inline-flex; padding-right: var(--sp-1); opacity: 0; transition: opacity var(--t-fast) ease-out; }
  .line:hover .acts, .line.menu .acts, .acts:focus-within { opacity: 1; }
  :global(:root[data-phone]) .acts { opacity: 1; }
  :global(:root[data-phone]) .row { height: 40px; font-size: 15px; }
  .body.dropping { box-shadow: inset 0 0 0 2px var(--accent, var(--hair2)); border-radius: 10px; }
  .line.drop { background: var(--sel); box-shadow: inset 0 0 0 1px var(--hair2); }
  .ups { display: flex; flex-direction: column; gap: 2px; margin: 0 0 var(--sp-2); }
  .up { display: flex; align-items: center; gap: var(--sp-2); height: 32px; padding: 0 var(--sp-1) 0 var(--sp-2); border-radius: 8px; background: var(--tint); color: var(--ink2); font-size: var(--fs-small); }
  .up.bad { color: var(--diff-removed-ink, var(--ink2)); }
  .un { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
  .bar { flex: 0 0 64px; height: 4px; border-radius: 2px; background: var(--hair); overflow: hidden; }
  .bar span { display: block; height: 100%; background: var(--ink2); transition: width var(--t-fast) linear; }
  .us { flex: none; color: var(--muted); font-variant-numeric: tabular-nums; }
</style>
