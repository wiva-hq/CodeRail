<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // "Install CodeRail Bridge", as a dialog: two ways in (the Mac app, once a build is on the download host, or the install
  // line in a terminal), each as numbered steps, and the `coderail link` line for a bridge that's already there.
  import { copyText } from '../lib/app.svelte';
  import Sheet from './ui/Sheet.svelte';
  import Button from './ui/Button.svelte';
  import SegmentedControl from './ui/SegmentedControl.svelte';
  let { onclose, hasMacApp }: { onclose: () => void; hasMacApp: boolean } = $props();
  const origin = location.origin;
  const install = `curl -fsSL ${origin}/install.sh | sh`;
  const link = `coderail link ${origin}`;
  const openApp = `coderail://link?server=${encodeURIComponent(origin)}`;
  const onMac = /Macintosh|Mac OS X/.test(navigator.userAgent) && !/iPhone|iPad/.test(navigator.userAgent);
  // svelte-ignore state_referenced_locally
  let way = $state<'mac' | 'terminal'>(hasMacApp && onMac ? 'mac' : 'terminal');
</script>

{#snippet cmd(text: string, what: string)}
  <div class="cmd"><code class="selectable">{text}</code><Button variant="icon" size="sm" icon="copy" tip="Copy {what}" onclick={() => copyText(text, 'Copied')} /></div>
{/snippet}

<Sheet title="Install CodeRail Bridge" width={520} {onclose} autofocus={false}>
  {#if hasMacApp}
    <SegmentedControl label="How" value={way} onchange={(v) => (way = v as 'mac' | 'terminal')}
      options={[{ id: 'mac', label: 'Mac app', icon: 'mac' }, { id: 'terminal', label: 'Terminal', icon: 'terminal' }]} />
  {/if}
  <ol class="steps">
    {#if way === 'mac' && hasMacApp}
      <li><span class="n">1</span><div><b>Download CodeRail for Mac</b><span class="q">macOS 13 or later</span>
        <div class="act"><Button variant="primary" icon="download" onclick={() => (location.href = '/download/CodeRail.zip')}>Download for Mac</Button></div></div></li>
      <li><span class="n">2</span><div><b>Open it</b><span class="q">Already have it? <a href={openApp}>Open it to link</a></span></div></li>
      <li><span class="n">3</span><div><b>Approve the code it shows</b></div></li>
    {:else}
      <li><span class="n">1</span><div><b>Run this on the computer</b><span class="q">macOS or Linux</span>
        {@render cmd(install, 'install command')}</div></li>
      <li><span class="n">2</span><div><b>Approve the code it prints</b></div></li>
    {/if}
  </ol>
  <div class="foot">
    <span class="q">Bridge already installed? Link it with</span>
    {@render cmd(link, 'link command')}
  </div>
</Sheet>

<style>
  .steps { list-style: none; margin: var(--sp-4) 0 0; padding: 0; display: flex; flex-direction: column; gap: var(--sp-4); }
  .steps li { display: flex; gap: var(--sp-3); align-items: flex-start; }
  .steps li > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .n { width: 24px; height: 24px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--sel); color: var(--ink); font-size: var(--fs-small); font-weight: var(--w-strong); }
  b { font-weight: var(--w-control); color: var(--ink); line-height: 24px; }
  .q { color: var(--muted); font-size: var(--fs-small); line-height: 1.5; }
  .q a { color: var(--ink2); }
  .act { margin-top: var(--sp-2); }
  .steps .cmd { margin-top: var(--sp-2); }
  .foot { margin-top: var(--sp-5); padding-top: var(--sp-4); box-shadow: inset 0 var(--hairline) 0 var(--hair); display: flex; flex-direction: column; gap: var(--sp-1h); }
  .cmd { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1) var(--sp-1) var(--sp-1) var(--sp-3); border-radius: var(--r-md); background: var(--panel); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); }
  .cmd code { flex: 1; min-width: 0; font: 12.5px/20px var(--mono); overflow-x: auto; white-space: nowrap; scrollbar-width: none; }
</style>
