<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The composer (Forest's): grows from one line to eight, then scrolls; Enter sends, Shift+Enter breaks the line,
  // never while an input method composes. Pictures come by +, paste or a drop, and go as ACP image blocks. A draft
  // starting with / lists the agent's commands (↑ ↓, Tab or Return inserts). One round button: Send, or Stop (a ring)
  // while the agent works and the draft is empty (`agent.cancel`). Drafts are kept per session. On the phone (`phone`),
  // the Claude app's card: the text on top, then a row of the session's controls (`bar`) and the round Send.
  import { untrack, type Snippet } from 'svelte';
  import type { SessionRow } from '@coderail/protocol';
  import type { MachineConn, SessionView } from '../../lib/machine.svelte';
  import { app } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { b64 } from '../../lib/b64';
  import { kept, keep } from '../../lib/kept';
  import { tip } from '../../lib/tip';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  let { conn, row, view, onsent, phone = false, bar }: { conn: MachineConn; row: SessionRow; view: SessionView; onsent?: () => void; phone?: boolean; bar?: Snippet } = $props();
  let ta = $state<HTMLTextAreaElement>();
  let picker = $state<HTMLInputElement>();
  let camera = $state<HTMLInputElement>();
  const KEY = $derived(`coderail.draft.${conn.id}.${row.sessionId}`);
  let draft = $state('');
  $effect(() => { const k = KEY; untrack(() => { draft = kept(k, ''); images = []; requestAnimationFrame(grow); }); });
  $effect(() => { const k = KEY, d = draft; const t = setTimeout(() => keep(k, d || null), 300); return () => clearTimeout(t); });
  let images = $state<{ id: number; name: string; mimeType: string; data: string; url: string }[]>([]);
  let sending = $state(false);
  let composedAt = 0;
  const LINE = 24, MAX = LINE * 8 + 28;
  const working = $derived(row.state === 'running');
  const ready = $derived(!!draft.trim() || images.length > 0);
  const action = $derived<'send' | 'stop' | 'none'>(ready ? 'send' : working ? 'stop' : 'none');

  // ---- / commands
  let cmdActive = $state(0);
  const cmdQuery = $derived(/^\/(\S*)$/.exec(draft)?.[1] ?? null);
  const cmds = $derived(cmdQuery == null ? [] : view.commands.filter((c) => c.name.toLowerCase().startsWith(cmdQuery.toLowerCase())).slice(0, 8));
  function pickCmd(name: string) { draft = `/${name} `; ta?.focus(); }

  function grow() { if (ta) { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, MAX) + 'px'; } }
  function key(e: KeyboardEvent) {
    const ime = e.isComposing || e.keyCode === 229 || Date.now() - composedAt < 500;
    if (cmds.length && !ime) {
      if (e.key === 'ArrowDown') { e.preventDefault(); cmdActive = (cmdActive + 1) % cmds.length; return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); cmdActive = (cmdActive - 1 + cmds.length) % cmds.length; return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && cmds[cmdActive] && draft !== `/${cmds[cmdActive].name}`)) { e.preventDefault(); pickCmd(cmds[cmdActive].name); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !ime && !(document.documentElement.dataset.phone)) { e.preventDefault(); void send(); }
  }
  async function send() {
    if (action === 'stop') { conn.call('agent.cancel', { sessionId: row.sessionId }).catch((e) => app.toast(plainError(e), 'warning')); return; }
    if (action !== 'send' || sending) return;
    const prompt: any[] = [];
    for (const im of images) prompt.push({ type: 'image', mimeType: im.mimeType, data: im.data });
    if (draft.trim()) prompt.push({ type: 'text', text: draft });
    const was = draft, wasImages = images;
    draft = ''; images = [];
    keep(KEY, null);
    requestAnimationFrame(grow);
    sending = true;
    onsent?.();
    try { await conn.call('agent.prompt', { sessionId: row.sessionId, prompt }, 30_000); }
    catch (e) { draft = was; images = wasImages; app.toast(plainError(e), 'warning'); }
    sending = false;
  }
  let nextImg = 1;
  async function attach(files: File[]) {
    for (const f of files) {
      if (!f.type.startsWith('image/')) { app.toast(`${f.name}: only pictures can be sent to the agent`, 'warning'); continue; }
      if (f.size > 5 << 20) { app.toast(`${f.name} is larger than 5 MB`, 'warning'); continue; }
      const data = b64(await f.arrayBuffer());
      images = [...images, { id: nextImg++, name: f.name, mimeType: f.type, data, url: URL.createObjectURL(f) }];
    }
  }
  function paste(e: ClipboardEvent) {
    const fs = [...(e.clipboardData?.files ?? [])];
    if (fs.length) { e.preventDefault(); void attach(fs); }
  }
  export function focus() { ta?.focus(); }
  export function drop(files: File[]) { void attach(files); }
  /** The picture picker (the phone's Camera and Photos). */
  export function pick(cam = false) { (cam ? camera : picker)?.click(); }
  const take = (e: Event) => { const i = e.currentTarget as HTMLInputElement; void attach([...(i.files ?? [])]); i.value = ''; };
</script>

<div class="composer" class:phone>
  {#if cmds.length}
    <div class="cmds" role="listbox" aria-label="Commands">
      {#each cmds as c, i (c.name)}
        <button class="cmd" class:on={i === cmdActive} role="option" aria-selected={i === cmdActive} onpointerenter={() => (cmdActive = i)} onclick={() => pickCmd(c.name)}>
          <span class="cn">/{c.name}</span>{#if c.description}<span class="cd cut">{c.description}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
  {#if images.length}
    <div class="files">
      {#each images as f (f.id)}
        <span class="att" {@attach tip(f.name)}><img src={f.url} alt="" /><Button variant="icon" size="xs" icon="close" iconSize={12} tip="Remove" onclick={() => (images = images.filter((x) => x.id !== f.id))} /></span>
      {/each}
    </div>
  {/if}
  {#if phone}
    <textarea bind:this={ta} class="pta" rows="1" placeholder={working ? 'Add to the queue, or stop' : `Reply to ${row.harness === 'codex' ? 'Codex' : 'Claude Code'}`} bind:value={draft} spellcheck="true"
      oninput={() => { grow(); cmdActive = 0; }} onkeydown={key} onpaste={paste} oncompositionend={() => (composedAt = Date.now())} aria-label="Message"></textarea>
    <div class="pbar">
      {@render bar?.()}
      {#if action === 'stop'}
        <button class="send stop" onclick={send} aria-label="Stop" {@attach tip('Stop')}><Icon name="stopc" size={26} stroke={1.6} /></button>
      {:else}
        <button class="send" class:ready={action === 'send'} disabled={action === 'none' || sending} onclick={send} aria-label="Send" {@attach tip(action === 'send' ? 'Send  ⏎' : '')}><Icon name="send" size={16} stroke={2.2} /></button>
      {/if}
    </div>
    <input bind:this={picker} type="file" accept="image/*" multiple hidden onchange={take} />
    <input bind:this={camera} type="file" accept="image/*" capture="environment" hidden onchange={take} />
  {:else}
  <div class="line">
    <span class="lead"><Button icon="plus" variant="icon" tip="Attach pictures" onclick={() => picker?.click()} /></span>
    <input bind:this={picker} type="file" accept="image/*" multiple hidden onchange={take} />
    <input bind:this={camera} type="file" accept="image/*" capture="environment" hidden onchange={take} />
    <textarea bind:this={ta} rows="1" placeholder={working ? 'Add to the queue, or stop' : `Message ${row.title || 'the agent'}`} bind:value={draft} spellcheck="true"
      oninput={() => { grow(); cmdActive = 0; }} onkeydown={key} onpaste={paste}
      oncompositionend={() => (composedAt = Date.now())} aria-label="Message"></textarea>
    <span class="tail">
      {#if action === 'stop'}
        <button class="send stop" onclick={send} aria-label="Stop" {@attach tip('Stop')}><Icon name="stopc" size={26} stroke={1.6} /></button>
      {:else}
        <button class="send" class:ready={action === 'send'} disabled={action === 'none' || sending} onclick={send} aria-label="Send" {@attach tip(action === 'send' ? 'Send  ⏎' : '')}><Icon name="send" size={16} stroke={2.2} /></button>
      {/if}
    </span>
  </div>
  {/if}
</div>

<style>
  .composer { position: relative; width: 100%; border-radius: var(--r-composer); background: var(--panel); box-shadow: var(--shadow-composer); transition: box-shadow var(--t-base) var(--ease-base); }
  .composer:focus-within { box-shadow: var(--shadow-composer-focus); }
  .files { display: flex; flex-wrap: wrap; gap: var(--sp-1h); padding: var(--sp-3) var(--sp-3) 0; }
  .att { position: relative; display: inline-flex; width: 56px; height: 56px; border-radius: var(--r-md); overflow: hidden; box-shadow: 0 0 0 var(--hairline) var(--hair2); }
  .att img { width: 100%; height: 100%; object-fit: cover; }
  .att :global(.iconbtn) { position: absolute; top: 2px; right: 2px; background: var(--pop); }
  .line { display: flex; align-items: flex-end; gap: var(--sp-1); padding: 0 var(--sp-2); }
  .lead, .tail { display: inline-flex; align-items: center; gap: var(--sp-0h); flex: none; height: 52px; }
  textarea { flex: 1; min-width: 0; display: block; font: inherit; font-size: var(--fs-message); line-height: 24px; padding: 14px var(--sp-1); border: 0; outline: 0; background: none; resize: none; min-height: 52px; color: var(--ink); overflow-y: auto; scrollbar-width: thin; }
  textarea::placeholder { color: var(--muted); }
  .send { width: 32px; height: 32px; margin-left: var(--sp-0h); border-radius: 50%; background: var(--primary); color: var(--onprimary); opacity: 0.2; display: inline-flex; align-items: center; justify-content: center; flex: none;
    transition: transform var(--t-quick) var(--ease-snap), background var(--t-quick) var(--ease-snap), opacity var(--t-quick) var(--ease-snap); }
  .send.ready { opacity: 1; }
  .send.ready:hover { background: var(--primaryhover); }
  .send.ready:active, .send.stop:active { transform: scale(0.92); }
  .send.stop { background: transparent; color: var(--ink); opacity: 1; }
  .send.stop:hover { background: var(--hover); }
  .cmds { position: absolute; left: 0; right: 0; bottom: calc(100% + var(--sp-2)); z-index: var(--z-raised); padding: var(--sp-1h); background: var(--pop); border-radius: var(--r-xl); box-shadow: var(--shadow-pop); display: flex; flex-direction: column; }
  .cmd { display: flex; align-items: center; gap: var(--sp-3); min-height: var(--row); padding: var(--sp-1) var(--row-x); border-radius: var(--r-md); text-align: left; }
  .cmd.on { background: var(--hover); }
  .cn { font-family: var(--mono); font-size: 13px; color: var(--ink); flex: none; }
  .composer.phone { border-radius: 30px; background: color-mix(in srgb, var(--panel) 88%, transparent); -webkit-backdrop-filter: blur(20px); backdrop-filter: blur(20px);
    box-shadow: inset 0 0 0 var(--hairline) var(--hair2), 0 6px 24px rgba(0, 0, 0, 0.08); }
  .pta { width: 100%; padding: 16px var(--sp-5) var(--sp-1); min-height: 52px; font-size: 17px; }
  .pbar { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-3) var(--sp-3); }
  .phone .send { width: 40px; height: 40px; margin: 0; }
  .phone .send :global(svg) { width: 18px; height: 18px; }
  .phone .send.stop :global(svg) { width: 30px; height: 30px; }
  .cd { color: var(--muted); font-size: var(--fs-small); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
