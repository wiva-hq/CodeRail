<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Camofox runs on the computer, one browser per chat session (its own profile), streams frames on
  // browser:<sessionId> and receives native input. Everyone who opens the chat attaches to the same browser.
  import { onMount } from 'svelte';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { plainError } from '../../lib/api';
  import { unb64 } from '../../lib/b64';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  let { conn, session, url, onnav, onback, parse }: {
    conn: MachineConn;
    /** The chat session whose browser this is. */
    session: string;
    /** An address just asked for (it opens there), or null to show the chat's browser as it is. */
    url: string | null;
    onnav: (url: string, title: string) => void;
    onback: () => void;
    /** Text typed in the address bar → an address (the card's rule: https, http for local ones). */
    parse: (text: string) => URL | null;
  } = $props();
  // svelte-ignore state_referenced_locally
  let addr = $state(url ?? ''), title = $state('');
  let id = $state<string | null>(null);
  let canvas = $state<HTMLCanvasElement>();
  let drawn = $state(false);
  let navigating = $state(false);
  let editing = false, mounted = false, decoding = false, epoch = 0, raf = 0, navigation = 0;
  let pendingFrame: { data: string; w: number; h: number } | undefined;
  let remoteSize = { w: 1, h: 1 };
  function present(frame: { data: string; w: number; h: number }) {
    pendingFrame = frame;
    if (decoding || raf || !mounted) return;
    raf = requestAnimationFrame(() => { raf = 0; void paint(); });
  }
  async function paint() {
    if (!canvas || !pendingFrame || !mounted) return;
    const frame = pendingFrame, generation = epoch;
    pendingFrame = undefined; decoding = true;
    try {
      const bytes = unb64(frame.data);
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
      try {
        if (!mounted || generation !== epoch || !canvas) return;
        if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
        if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
        canvas.getContext('2d', { alpha: false, desynchronized: true })?.drawImage(bitmap, 0, 0);
        remoteSize = { w: frame.w, h: frame.h };
        drawn = true; starting = false;
      } finally { bitmap.close(); }
    } catch (e) { error = plainError(e); }
    finally { decoding = false; if (pendingFrame) present(pendingFrame); }
  }
  let error = $state<string | null>(null);
  let starting = $state(true);
  let status = $state('Starting Camofox on the computer…');
  let view = $state<HTMLDivElement>();
  let size = { w: 0, h: 0 };
  const dpr = () => Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const call = (method: string, params: Record<string, unknown>) => conn.call(method, { sessionId: session, ...params }).catch((e) => { error = plainError(e); });

  function measure() {
    const r = view?.getBoundingClientRect();
    if (r) size = { w: Math.max(200, Math.round(r.width)), h: Math.max(200, Math.round(r.height)) };
  }
  /** The size last sent with open, attach or resize: the view is measured again, and a resize goes only if it moved. */
  let sent = '';
  const fit = () => { measure(); return { width: size.w, height: size.h, dpr: dpr() }; };
  const sized = (f: { width: number; height: number; dpr: number }) => { sent = `${f.width}x${f.height}@${f.dpr}`; return f; };
  function refit() {
    const f = fit();
    if (id && `${f.width}x${f.height}@${f.dpr}` !== sent) void call('browser.resize', sized(f));
  }
  let off: (() => void) | null = null;
  /** Follows whether the card is in sight (set up on mount). */
  let sight = () => {};
  function listen(tabId: string) {
    off?.();
    off = conn.listen(`browser:${tabId}`, (ev: any) => {
      if (ev?.type === 'frame') present(ev);
      else if (ev?.type === 'status') { status = ev.message; starting = true; }
      else if (ev?.type === 'error') { error = ev.message; starting = false; }
      else if (ev?.type === 'nav') { if (!editing) addr = ev.url; title = ev.title ?? ''; onnav(ev.url, ev.title ?? ''); }
      // (Someone in the chat closed it: back to the start.)
      else if (ev?.type === 'closed') { id = null; onback(); }
    });
  }
  async function open(u: string) {
    id = null; epoch++; pendingFrame = undefined; drawn = false; error = null; starting = true; status = 'Starting Camofox on the computer…';
    try {
      const r = await conn.call<{ id: string }>('browser.open', { sessionId: session, url: u, ...sized(fit()) });
      if (!mounted) return leave(r.id);
      id = r.id; listen(r.id);
      refit();
      // (The first frames came before this card was subscribed: the screen as it is now.)
      void call('browser.watch', { on: true });
      sight();
    } catch (e) { error = plainError(e); starting = false; }
  }
  /** The card closed while open or attach was answering: off the topic it just joined, or frames keep coming. */
  function leave(tabId: string) {
    if (conn.connected) void conn.call('unsub', { topics: [`browser:${tabId}`] }).catch(() => {});
  }
  onMount(() => {
    mounted = true; measure();
    (async () => {
      try {
        // (attach also resizes, subscribes and turns the frames on.)
        const r = await conn.call<{ id: string; url: string; title: string }>('browser.attach', { sessionId: session, ...sized(fit()) });
        if (!mounted) return leave(r.id);
        id = r.id; addr = url ?? r.url; title = r.title; listen(r.id);
        refit();
        if (url && url !== r.url) void call('browser.navigate', { url });
        sight();
        return;
      } catch { /* none open for this chat yet (or the bridge restarted) */ }
      if (url) await open(url);
      else onback();
    })();
    // (The view resized: the browser window follows, a moment after the last change.)
    let t: ReturnType<typeof setTimeout> | undefined;
    const resize = () => { clearTimeout(t); t = setTimeout(refit, 100); };
    const ro = new ResizeObserver(resize);
    window.addEventListener('resize', resize);
    if (view) ro.observe(view);
    // (Out of sight — a background tab, or the card scrolled or folded away: off the topic, so the hub tells
    // the computer to stop the frames unless someone else is watching; back in sight, a fresh frame.)
    let onScreen = true, away = false;
    const shown = () => onScreen && !document.hidden;
    // (Out of sight for 2 s first: a tab or an app switched away and straight back costs nothing.)
    let leaving: ReturnType<typeof setTimeout> | undefined;
    sight = () => {
      clearTimeout(leaving);
      if (!id) return;
      if (shown()) { if (away) { away = false; void restore(); } return; }
      if (away) return;
      leaving = setTimeout(() => {
        if (!id || shown()) return;
        away = true;
        // (browser.attach subscribed this connection; coming back attaches again.)
        if (conn.connected) void conn.call('unsub', { topics: [`browser:${id}`] }).catch(() => {});
      }, 2000);
    };
    const io = new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; sight(); });
    if (view) io.observe(view);
    document.addEventListener('visibilitychange', sight);
    let restoring = false;
    async function restore() {
      if (!id || restoring || !mounted || !shown()) return;
      restoring = true;
      try {
        await conn.call('browser.attach', { sessionId: session, ...sized(fit()) });
      } catch { if (mounted) await open(addr); }
      finally { restoring = false; }
    }
    const offRe = conn.onReconnect(() => void restore());
    const offMachine = conn.listen('machine', (ev) => { if (ev.type === 'online' && ev.online) void restore(); });
    return () => {
      mounted = false; epoch++; pendingFrame = undefined; cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      ro.disconnect(); io.disconnect(); document.removeEventListener('visibilitychange', sight); offRe(); offMachine(); off?.(); clearTimeout(t); clearTimeout(wheelT); clearTimeout(rest); clearTimeout(leaving);
      // (Off the topic: when no one else in the chat is looking, the hub stops the frames.)
      if (id && conn.connected) void conn.call('unsub', { topics: [`browser:${id}`] }).catch(() => {});
    };
  });

  // ---- Input: positions in the page's own pixels.
  const at = (e: MouseEvent) => { const r = view!.getBoundingClientRect(); return { x: Math.round((e.clientX - r.left) * remoteSize.w / r.width), y: Math.round((e.clientY - r.top) * remoteSize.h / r.height) }; };
  const mods = (e: KeyboardEvent | MouseEvent) => (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  const BUTTON = ['left', 'middle', 'right'];
  function mouse(e: PointerEvent, action: string) {
    if (!id || starting) return;
    if (action === 'mousePressed') { view?.focus(); (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); }
    void call('browser.input', { ev: { type: 'mouse', action, ...at(e), button: action === 'mouseMoved' ? (e.buttons ? 'left' : 'none') : BUTTON[e.button] ?? 'left', buttons: e.buttons, clickCount: action === 'mouseMoved' ? 0 : Math.max(1, e.detail), modifiers: mods(e) } });
  }
  // (Each move is a message through the hub. A drag sends at most ten a second; plain hover only where the pointer
  // comes to rest, enough for menus and hover states.)
  let lastMove = 0, rest: ReturnType<typeof setTimeout> | undefined, resting: PointerEvent | undefined;
  function move(e: PointerEvent) {
    clearTimeout(rest);
    if (!e.buttons) {
      resting = e;
      rest = setTimeout(() => { if (resting) mouse(resting, 'mouseMoved'); resting = undefined; }, 120);
      return;
    }
    const now = performance.now();
    if (now - lastMove < 100) return;
    lastMove = now; mouse(e, 'mouseMoved');
  }
  // (Scrolling gathered over 50 ms into one.)
  let wheel = { dx: 0, dy: 0, x: 0, y: 0 }, wheelT: ReturnType<typeof setTimeout> | undefined;
  function scroll(e: WheelEvent) {
    e.preventDefault();
    if (!id || starting) return;
    const p = at(e);
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? size.h : 1;
    wheel = { dx: wheel.dx + e.deltaX * scale, dy: wheel.dy + e.deltaY * scale, ...p };
    const modifiers = mods(e);
    wheelT ??= setTimeout(() => { const w = wheel; wheel = { dx: 0, dy: 0, x: 0, y: 0 }; wheelT = undefined; void call('browser.input', { ev: { type: 'wheel', ...w, modifiers } }); }, 50);
  }
  function key(e: KeyboardEvent, action: 'keyDown' | 'keyUp') {
    if (!id || starting) return;
    // (⌘V pastes through the paste event: the text comes from this computer's clipboard.)
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    void call('browser.input', { ev: { type: 'key', action, key: e.key, code: e.code, keyCode: e.keyCode, text: e.key.length === 1 ? e.key : e.key === 'Enter' ? '\r' : undefined, modifiers: mods(e) } });
  }
  function paste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text/plain');
    if (text && id) { e.preventDefault(); void call('browser.input', { ev: { type: 'text', text } }); }
  }
  async function navigate() {
    const u = parse(addr);
    if (!u) { error = 'Type an http or https address'; return; }
    error = null; addr = u.href; editing = false; navigating = true;
    const sequence = ++navigation;
    try { if (id) await call('browser.navigate', { url: u.href }); else await open(u.href); }
    finally { if (sequence === navigation) navigating = false; }
  }
  // (Closes the chat's browser for everyone in it.)
  async function back() { if (id) await call('browser.close', {}); onback(); }
</script>

<form class="bar" onsubmit={(e) => { e.preventDefault(); void navigate(); }}>
  <Button type="button" icon="close" variant="icon" size="sm" tip="Close this chat's browser" onclick={back} />
  <Button type="button" icon="chevl" variant="icon" size="sm" tip="Back" disabled={!id} onclick={() => call('browser.go', { delta: -1 })} />
  <Button type="button" icon="chevr" variant="icon" size="sm" tip="Forward" disabled={!id} onclick={() => call('browser.go', { delta: 1 })} />
  <Button type="button" icon="refresh" variant="icon" size="sm" tip="Reload" disabled={!id} onclick={() => call('browser.go', { delta: 0 })} />
  <span class="addr framed"><input bind:value={addr} spellcheck="false" autocapitalize="off" autocomplete="off" aria-label="Address" title={title}
    onfocus={(e) => { editing = true; (e.currentTarget as HTMLInputElement).select(); }} onblur={() => (editing = false)} /></span>
  {#if starting || navigating}<span class="progress" aria-hidden="true"><i></i></span>{/if}
</form>
{#if error}<div class="err bar-err"><Icon name="warning" size={14} />{error}<Button size="sm" variant="quiet" onclick={() => { const u = parse(addr)?.href ?? url; if (u) void open(u); }}>Open again</Button></div>{/if}
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
<div class="view" bind:this={view} tabindex="0" role="application" aria-label="Browser: {title || addr}"
  onpointerdown={(e) => mouse(e, 'mousePressed')} onpointerup={(e) => mouse(e, 'mouseReleased')} onpointermove={move}
  onwheel={scroll} onkeydown={(e) => key(e, 'keyDown')} onkeyup={(e) => key(e, 'keyUp')} onpaste={paste} oncontextmenu={(e) => e.preventDefault()}>
  <canvas bind:this={canvas} class:ready={drawn}></canvas>
  {#if !drawn && starting}<div class="wait" role="status"><span class="spinner"></span><span>{status}</span></div>{/if}
</div>

<style>
  .bar { position: relative; display: flex; align-items: center; gap: var(--sp-1); height: var(--card-head); padding: 0 calc(var(--gutter) - var(--sp-1h)); box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair); flex: none; }
  .addr { flex: 1; min-width: 0; display: flex; align-items: center; height: 30px; padding: 0 var(--sp-2); margin: 0 var(--sp-1); }
  .addr input { flex: 1; min-width: 0; height: 100%; outline: none; font-family: var(--mono); font-size: 12.5px; }
  .progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; overflow: hidden; }
  .progress i { position: absolute; top: 0; bottom: 0; width: 30%; background: var(--accent); border-radius: 1px; animation: crawl 1.2s var(--ease-base) infinite; }
  @keyframes crawl { from { left: -30%; } to { left: 100%; } }
  .bar-err { margin: var(--sp-2) var(--gutter); display: flex; align-items: center; gap: var(--sp-2); }
  .view { position: relative; flex: 1; min-height: 0; overflow: hidden; outline: none; background: var(--webpage); cursor: default; touch-action: none; }
  .view:focus-visible { box-shadow: inset 0 0 0 2px var(--accent-ring); }
  .view canvas { position: absolute; top: 0; left: 0; width: 100%; height: 100%; visibility: hidden; user-select: none; pointer-events: none; }
  .view canvas.ready { visibility: visible; }
  .wait { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; gap: var(--sp-2); color: var(--muted); font-size: var(--fs-quiet); }
</style>
