<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A machine's terminal in xterm (Forest's TermView, on CodeRail's protocol). Opened by `opener` (cols, rows → a
  // TerminalInfo with its `scrollback`), or attached to a running one by `term` (`term.attach` → {info, scrollback}).
  // The scrollback is written first, then the `term:<id>` output events that come after it (buffered meanwhile).
  // Keys go back with `term.write` in order (one write on its way at a time; what is typed meanwhile goes with the
  // next), never after the shell ended. It follows its box's size (`term.resize`). After a reconnect it attaches
  // again and replaces what it shows with the scrollback. ⌘C copies a selection, ⌘K clears, ⌘A selects all. When the
  // view goes it stops listening (`unsub`); the terminal keeps running on the machine until its tab is closed.
  import { onMount, untrack } from 'svelte';
  import { Terminal } from '@xterm/xterm';
  import { FitAddon } from '@xterm/addon-fit';
  import { WebLinksAddon } from '@xterm/addon-web-links';
  import type { TerminalInfo } from '@coderail/protocol';
  import { unb64 } from '../lib/b64';
  import { FONT, termTheme, followTheme } from '../lib/xterm';
  import { copyText } from '../lib/app.svelte';
  import type { MachineConn } from '../lib/machine.svelte';
  import '@xterm/xterm/css/xterm.css';
  let { conn, opener, term: given, readOnly = false, active = true, onexit, onerror, onopen }: {
    conn: MachineConn;
    opener?: (cols: number, rows: number) => Promise<TerminalInfo & { scrollback?: string }>;
    term?: string;
    /** Watch only: keys are not sent. */
    readOnly?: boolean;
    active?: boolean;
    onexit?: (code: number | null) => void;
    onerror?: (message: string) => void;
    onopen?: (info: TerminalInfo) => void;
  } = $props();
  let host = $state<HTMLDivElement>();
  let t: Terminal | undefined;
  let fit: FitAddon | undefined;
  let id: string | undefined = untrack(() => given);

  function refit() {
    if (!t || !fit || !host?.clientWidth || !host.clientHeight) return;
    try { fit.fit(); } catch { /* not laid out */ }
  }
  $effect(() => { if (active) requestAnimationFrame(() => { refit(); if (!readOnly) t?.focus(); }); });

  onMount(() => {
    const term = new Terminal({ fontFamily: FONT, fontSize: 12.5, lineHeight: 1.25, cursorBlink: true, macOptionIsMeta: true, scrollback: 5000, theme: termTheme(), disableStdin: readOnly });
    t = term;
    fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_e, uri) => { window.open(uri, '_blank', 'noopener'); }));
    term.open(host!);
    refit();
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !(e.metaKey || (e.ctrlKey && e.shiftKey))) return true;
      const k = e.key.toLowerCase();
      if (k === 'c' && term.hasSelection()) { copyText(term.getSelection()); term.clearSelection(); return false; }
      if (e.metaKey && k === 'k') { term.clear(); return false; }
      if (e.metaKey && k === 'a') { term.selectAll(); return false; }
      return !(e.metaKey && k === 'c');
    });
    let ready = false;
    let ended = false;
    /** Attached (or opened) once: only then does a reconnect attach again (the first connect is the first attach). */
    let live = false;
    let gone = false;
    const pending: Uint8Array[] = [];
    const show = (sb?: string) => { if (sb) term.write(unb64(sb)); for (const p of pending.splice(0)) term.write(p); ready = true; };
    let off: (() => void) | null = null;
    const listen = () => {
      if (!id || off) return;
      off = conn.listen(`term:${id}`, (ev: any) => {
        if (ev?.type === 'output') { const d = unb64(ev.data ?? ''); if (ready) term.write(d); else pending.push(d); }
        else if (ev?.type === 'exit') { ended = true; queue = ''; onexit?.(ev.code ?? null); }
      });
    };
    const attach = (reset: boolean) => {
      if (!id) return;
      ready = false;
      listen();
      conn.call<{ info: TerminalInfo; scrollback: string }>('term.attach', { id }).then((r) => {
        if (gone) return;
        live = true;
        if (reset) term.reset();
        pending.length = 0;
        show(r?.scrollback);
        if (r?.info?.exited != null && !ended) { ended = true; onexit?.(r.info.exited); }
        refit();
        conn.call('term.resize', { id, cols: term.cols, rows: term.rows }).catch(() => {});
      }).catch((e) => { if (gone) return; show(); onerror?.(String(e?.message ?? e)); });
    };
    const offRe = conn.onReconnect(() => { if (id && !ended && live) attach(true); });

    if (given) attach(false);
    else if (opener) {
      opener(term.cols, term.rows).then((r) => {
        if (gone) return;
        id = r.id;
        live = true;
        listen();
        // (`term.open` subscribes the opener; the scrollback is what came before that.)
        show(r.scrollback);
        onopen?.(r);
        refit();
        conn.call('term.resize', { id, cols: term.cols, rows: term.rows }).catch(() => {});
      }).catch((e) => { if (gone) return; ready = true; onerror?.(String(e?.message ?? e)); });
    } else ready = true;

    let queue = '';
    let sending = false;
    const flush = async () => {
      if (sending || !queue || !id) return;
      sending = true;
      const data = queue; queue = '';
      await conn.call('term.write', { id, data }).catch(() => {});
      sending = false;
      flush();
    };
    term.onData((d) => { if (!id || ended || readOnly) return; queue += d; flush(); });
    term.onResize(({ cols, rows }) => { if (id && !ended) conn.call('term.resize', { id, cols, rows }).catch(() => {}); });
    const ro = new ResizeObserver(() => refit());
    ro.observe(host!);
    const unfollow = followTheme(term);
    if (active && !readOnly) term.focus();
    return () => {
      gone = true;
      ro.disconnect();
      unfollow();
      offRe();
      off?.();
      term.dispose();
      if (id && conn.connected) conn.call('unsub', { topics: [`term:${id}`] }).catch(() => {});
    };
  });
</script>

<div class="tv" bind:this={host}></div>

<style>
  .tv { height: 100%; padding: var(--sp-2) var(--sp-1) var(--sp-1) var(--gutter); background: var(--terminal-bg); }
  .tv :global(.xterm-viewport) { scrollbar-width: thin; }
</style>
