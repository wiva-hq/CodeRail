<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A file in the Files card: its path as breadcrumbs (a folder goes back to the tree with it open), then the file
  // as its kind shows best. Pictures (fit or actual size), video and sound (they seek: read by Range from the files
  // route), PDFs, fonts, Word documents, spreadsheets and a zip's list come by URL, any size; Markdown, HTML and SVG
  // (a preview or the source), CSV/TSV (a table), JSON (formatted), notebooks and code (in its language's colours)
  // are read as text (`fs.read`, the start of a large one); anything else is a hex dump. Download is always there.
  // Edit (operators, the machine online, a whole text file) turns it into a text editor: Save writes it (`fs.write`).
  import { onMount, untrack } from 'svelte';
  import type { FileContent } from '@coderail/protocol';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { app, copyText } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { highlight, langOf, onHighlighterReady, tokenLines } from '../../lib/markdown';
  import { edges } from '../../lib/edges';
  import { b64Text, unb64 } from '../../lib/b64';
  import { fileSize } from '../../lib/format';
  import { BY_URL, downloadFile, extOf, fileUrl, kindOf, parseDelimited } from '../../lib/files';
  import { tip } from '../../lib/tip';
  import Markdown from '../Markdown.svelte';
  import Button from '../ui/Button.svelte';
  import Menu, { type Item } from '../ui/Menu.svelte';
  import SegmentedControl from '../ui/SegmentedControl.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import TableView from './viewers/TableView.svelte';
  import HexView from './viewers/HexView.svelte';
  import FontView from './viewers/FontView.svelte';
  import NotebookView from './viewers/NotebookView.svelte';
  import DocxView from './viewers/DocxView.svelte';
  import SheetView from './viewers/SheetView.svelte';
  import ZipView from './viewers/ZipView.svelte';
  let { conn, path, root, onback }: { conn: MachineConn; path: string; root: string; onback: (folder?: string) => void } = $props();
  const ext = $derived(extOf(path));
  const kind = $derived(kindOf(path));
  const byUrl = $derived(BY_URL.has(kind));
  const url = $derived(fileUrl(conn.id, path));
  let file = $state<FileContent | null>(null);
  let error = $state<string | null>(null);
  let wrap = $state(false);
  /** Preview (the default) or the source, for kinds that have both. */
  let view = $state<'preview' | 'source'>('preview');
  let menu = $state<HTMLElement | null>(null);
  let ready = $state(0);
  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let actual = $state(false);
  let broken = $state(false);
  let dims = $state('');
  onMount(() => onHighlighterReady(() => ready++));

  async function read() {
    error = null;
    // (Kinds shown by URL need only the size and that it's there; a byte is enough.)
    try { file = await conn.call<FileContent>('fs.read', byUrl ? { path, max: 1 } : { path }); } catch (e) { error = plainError(e); }
  }
  $effect(() => { void path; untrack(() => { file = null; editing = false; view = 'preview'; actual = false; broken = false; dims = ''; void read(); }); });
  /** Its text, when it is text (the bridge says by its bytes; an SVG comes as base64 and is text too). */
  const text = $derived.by(() => {
    if (!file || byUrl) return null;
    if (file.encoding === 'utf8') return file.content;
    try { const t = b64Text(file.content); return t.slice(0, 8192).includes('\u0000') || t.slice(0, 8192).includes('�') ? null : t; } catch { return null; }
  });
  const hex = $derived(file && !byUrl && text == null ? unb64(file.content) : null);
  /** Kinds with a preview and a source. */
  const twoWay = $derived(text != null && (kind === 'markdown' || kind === 'html' || kind === 'svg' || kind === 'table' || kind === 'json' || kind === 'notebook'));
  const showSource = $derived(text != null && (!twoWay || view === 'source'));
  const lang = $derived(langOf(ext) || (kind === 'notebook' ? 'json' : kind === 'svg' ? 'xml' : ext));
  const shown = $derived(kind === 'json' && view === 'preview' && text != null ? pretty(text) : text);
  const code = $derived(shown != null && ready >= 0 ? highlight(shown.length > 400_000 ? shown.slice(0, 400_000) : shown, kind === 'json' ? 'json' : lang) : '');
  $effect(() => { if (text != null && lang) tokenLines('', lang); });
  const rows = $derived(kind === 'table' && text != null ? parseDelimited(text, ext === 'tsv' ? '\t' : text.slice(0, 2000).includes('\t') && !text.slice(0, 2000).includes(',') ? '\t' : ',') : []);
  const canEdit = $derived(conn.canAct && text != null && !file?.truncated);
  const rel = $derived(path.startsWith(root + '/') ? path.slice(root.length + 1) : path);
  const crumbs = $derived(rel.split('/'));
  const name = $derived(crumbs.at(-1) ?? path);
  function pretty(t: string) {
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return t; }
  }
  const VIEWS: Record<string, [string, string]> = {
    markdown: ['Preview', 'Source'], html: ['Preview', 'Source'], svg: ['Picture', 'Source'], table: ['Table', 'Source'], json: ['Formatted', 'Source'], notebook: ['Notebook', 'Source'],
  };

  async function download() {
    await app.act(() => downloadFile(conn.id, path));
  }
  function items(): Item[] {
    const out: Item[] = [{ id: 'download', label: 'Download', icon: 'download' }];
    if (byUrl || kind === 'svg' || kind === 'html') out.push({ id: 'tab', label: 'Open in a new tab', icon: 'ext' });
    out.push({ id: 's', sep: true }, { id: 'copy', label: 'Copy path', icon: 'copy' });
    if (text != null) out.push({ id: 'copytext', label: 'Copy contents', icon: 'copy' });
    out.push({ id: 'reload', label: 'Reload', icon: 'refresh' });
    return out;
  }
  function pick(id: string) {
    if (id === 'download') void download();
    else if (id === 'tab') window.open(url, '_blank', 'noopener');
    else if (id === 'copy') copyText(path, 'Path copied');
    else if (id === 'copytext' && text != null) copyText(text, 'Copied');
    else if (id === 'reload') { broken = false; void read(); }
  }
  function edit() { draft = text ?? ''; editing = true; }
  async function save() {
    saving = true;
    try {
      await conn.call('fs.write', { path, content: draft, encoding: 'utf8' });
      app.toast(`Saved ${name}`, 'success');
      editing = false;
      await read();
    } catch (e) { app.toast(plainError(e), 'warning'); }
    saving = false;
  }
  function editKeys(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (draft === text || confirm('Discard your changes?')) editing = false; }
    else if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const t = e.currentTarget as HTMLTextAreaElement, a = t.selectionStart, b = t.selectionEnd;
      draft = draft.slice(0, a) + '  ' + draft.slice(b);
      requestAnimationFrame(() => t.setSelectionRange(a + 2, a + 2));
    }
  }
</script>

<div class="viewer">
  <div class="vbar">
    <Button icon="chevl" variant="icon" size="sm" tip="Back to files" onclick={() => onback()} />
    <nav class="crumbs" aria-label="Path">
      {#each crumbs as c, i (i)}
        {#if i < crumbs.length - 1}<button class="cr cut" onclick={() => onback(root + '/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button><span class="slash">/</span>
        {:else}<span class="cr last cut" {@attach tip(file ? `${path} · ${fileSize(file.size)}${dims ? ' · ' + dims : ''}` : path)}>{c}</span>{/if}
      {/each}
    </nav>
    <span class="sp"></span>
    {#if editing}
      <Button size="sm" variant="quiet" onclick={() => (editing = false)}>Cancel</Button>
      <Button size="sm" variant="primary" busy={saving} disabled={draft === text} onclick={save}>Save</Button>
    {:else}
      {#if twoWay}
        <SegmentedControl size="sm" label="View" value={view} onchange={(v) => (view = v as typeof view)} options={[{ id: 'preview', label: VIEWS[kind][0] }, { id: 'source', label: VIEWS[kind][1] }]} />
      {/if}
      {#if kind === 'image' && !broken}
        <Button icon={actual ? 'minimize' : 'maximize'} variant="icon" size="sm" tip={actual ? 'Fit' : 'Actual size'} onclick={() => (actual = !actual)} />
      {/if}
      {#if showSource}
        <Button icon="wave" variant="icon" size="sm" on={wrap} tip={wrap ? 'Don’t wrap lines' : 'Wrap lines'} onclick={() => (wrap = !wrap)} />
      {/if}
      {#if text != null}<Button icon="edit" variant="icon" size="sm" disabled={!canEdit} tip={canEdit ? 'Edit' : file?.truncated ? 'Too large to edit here' : !conn.online ? 'The computer is offline' : 'Viewers can’t edit'} onclick={edit} />{/if}
      <Button icon="download" variant="icon" size="sm" tip="Download" disabled={!conn.online} onclick={download} />
      <Button icon="more" variant="icon" size="sm" tip="More" on={!!menu} onclick={(e) => (menu = menu ? null : (e.currentTarget as HTMLElement))} />
    {/if}
  </div>
  {#if file?.truncated && !editing && !byUrl}
    <div class="note">Large file ({fileSize(file.size)}): showing its start only. <button class="link" onclick={download}>Download it</button></div>
  {/if}
  {#if editing}
    <textarea class="editor selectable" bind:value={draft} onkeydown={editKeys} spellcheck="false" autocapitalize="off" aria-label="Edit {path}"></textarea>
  {:else}
    <div class="vbody scroll selectable" class:wrap class:fill={kind === 'pdf' || kind === 'docx' || (kind === 'html' && view === 'preview')} {@attach edges()}>
      {#if error}<EmptyState compact icon="warning" text="Could not open" tip={error}><Button size="sm" onclick={read}>Retry</Button></EmptyState>
      {:else if !file}<div class="loading"><span class="spinner"></span></div>
      {:else if kind === 'image'}
        {#if broken}
          <EmptyState compact icon="photo" text="This browser can’t show this picture" tip="{ext.toUpperCase()} · {fileSize(file.size)}"><Button size="sm" icon="download" onclick={download}>Download</Button></EmptyState>
        {:else}
          <div class="media" class:actual>
            <button class="pic" onclick={() => (actual = !actual)} aria-label={actual ? 'Fit' : 'Actual size'}>
              <img src={url} alt={name} onerror={() => (broken = true)} onload={(e) => { const i = e.currentTarget as HTMLImageElement; dims = `${i.naturalWidth} × ${i.naturalHeight}`; }} />
            </button>
          </div>
        {/if}
      {:else if kind === 'svg' && view === 'preview'}<div class="media"><img src={url} alt={name} class="svg" /></div>
      {:else if kind === 'video'}
        {#if broken}<EmptyState compact icon="play" text="This browser can’t play this video" tip="{ext.toUpperCase()} · {fileSize(file.size)}"><Button size="sm" icon="download" onclick={download}>Download</Button></EmptyState>
        {:else}<div class="media"><!-- svelte-ignore a11y_media_has_caption --><video src={url} controls preload="metadata" playsinline onerror={() => (broken = true)}></video></div>{/if}
      {:else if kind === 'audio'}
        {#if broken}<EmptyState compact icon="play" text="This browser can’t play this sound" tip="{ext.toUpperCase()} · {fileSize(file.size)}"><Button size="sm" icon="download" onclick={download}>Download</Button></EmptyState>
        {:else}<div class="sound"><audio src={url} controls preload="metadata" onerror={() => (broken = true)}></audio></div>{/if}
      {:else if kind === 'pdf'}<iframe class="frame" src={url} title={name}></iframe>
      {:else if kind === 'font'}<FontView {url} {name} />
      {:else if kind === 'docx'}<DocxView {url} size={file.size} />
      {:else if kind === 'sheet'}<SheetView {url} size={file.size} />
      {:else if kind === 'zip'}<ZipView {url} size={file.size} />
      {:else if text != null && kind === 'markdown' && view === 'preview'}<div class="mdp"><Markdown {text} /></div>
      {:else if text != null && kind === 'html' && view === 'preview'}<iframe class="frame light" title={name} sandbox="allow-scripts" srcdoc={text}></iframe>
      {:else if text != null && kind === 'table' && view === 'preview'}<TableView {rows} />
      {:else if text != null && kind === 'notebook' && view === 'preview'}<NotebookView {text} {ready} />
      {:else if text != null}<div class="source">{@html code}</div>
      {:else if hex}<HexView bytes={hex} size={file.size} />
      {:else}<EmptyState compact icon="file" text="Binary file ({fileSize(file.size)})" />{/if}
    </div>
  {/if}
</div>

{#if menu}<Menu anchor={menu} end width={220} items={items()} onpick={pick} onclose={() => (menu = null)} />{/if}

<style>
  .viewer { display: flex; flex-direction: column; height: 100%; }
  .vbar { display: flex; align-items: center; gap: var(--sp-1); height: var(--card-head); padding: 0 calc(var(--gutter) - var(--sp-1h)); box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair); flex: none; }
  .crumbs { display: flex; align-items: center; min-width: 0; overflow: hidden; font-size: var(--fs-small); white-space: nowrap; }
  .cr { padding: var(--sp-0h) var(--sp-1); border-radius: var(--r-xs); color: var(--muted); flex: 0 1 auto; min-width: 18px; overflow: hidden; text-overflow: ellipsis; }
  button.cr:hover { background: var(--hover); color: var(--ink); }
  .cr.last { color: var(--ink); font-weight: var(--w-control); flex: 0 0 auto; max-width: 100%; }
  .slash { color: var(--faint); flex: none; }
  .sp { flex: 1; min-width: var(--sp-1); }
  .note { padding: var(--sp-1h) var(--gutter); color: var(--muted); font-size: var(--fs-small); background: var(--warn-soft); flex: none; }
  .link { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
  .vbody { flex: 1; min-height: 0; overflow: auto; }
  .vbody.fill { overflow: hidden; display: flex; flex-direction: column; }
  /* (As wide as its longest line, so the lines scroll sideways together; not the app's boxed .code.) */
  .source { width: max-content; min-width: 100%; }
  .wrap .source { width: auto; }
  .source :global(pre) { margin: 0; padding: var(--sp-3) var(--gutter); font: 12.5px/19px var(--mono); background: transparent !important; white-space: pre; }
  .wrap .source :global(pre) { white-space: pre-wrap; word-break: break-all; }
  /* (Fit: the whole picture in the card, both ways, measured against the card (container units); Actual size: its
     own pixels, scrolled.) */
  .media { --pad: var(--gutter); box-sizing: border-box; display: flex; justify-content: center; align-items: center; padding: var(--pad); height: 100%; container-type: size; }
  .pic { display: block; cursor: zoom-in; }
  .media.actual { justify-content: flex-start; align-items: flex-start; height: auto; container-type: normal; }
  .media.actual .pic { cursor: zoom-out; }
  .media img { display: block; max-width: 100cqw; max-height: 100cqh; border-radius: var(--r-sm); box-shadow: 0 0 0 var(--hairline) var(--hair);
    /* (A checkerboard behind a picture with transparent parts.) */
    background: repeating-conic-gradient(var(--tint) 0% 25%, transparent 0% 50%) 50% / 16px 16px; }
  .media.actual img { max-width: none; max-height: none; }
  .media img.svg { min-width: min(240px, 100%); }
  .media video { display: block; max-width: 100cqw; max-height: 100cqh; border-radius: var(--r-sm); background: #000; }
  .sound { display: flex; justify-content: center; padding: var(--sp-10) var(--gutter); }
  .sound audio { width: min(520px, 100%); }
  .frame { flex: 1; width: 100%; min-height: 0; border: 0; background: var(--panel); }
  .frame.light { background: #fff; }
  .mdp { padding: var(--sp-3) var(--gutter) var(--gutter); }
  .loading { display: flex; justify-content: center; padding: var(--sp-10) 0; }
  .editor { flex: 1; min-height: 0; width: 100%; border: 0; outline: 0; resize: none; padding: var(--sp-3) var(--gutter); font: 12.5px/19px var(--mono); color: var(--ink); background: var(--panel); tab-size: 2; white-space: pre; overflow: auto; }
  :global(:root[data-phone]) .media { --pad: var(--sp-3); }
</style>
