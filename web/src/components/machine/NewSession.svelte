<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A new agent session: which harness (the machine's installed ones your grant allows, `agent.harnesses`) and in
  // which folder (FolderPicker), then `agent.new`. Opens the session when it starts.
  import { onMount } from 'svelte';
  import type { HarnessInfo, SessionRow } from '@coderail/protocol';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { plainError } from '../../lib/api';
  import { kept, keep } from '../../lib/kept';
  import Sheet from '../ui/Sheet.svelte';
  import Button from '../ui/Button.svelte';
  import OptionGroup from '../ui/OptionGroup.svelte';
  import OptionRow from '../ui/OptionRow.svelte';
  import HarnessMark from '../HarnessMark.svelte';
  import FolderPicker from '../FolderPicker.svelte';
  import Icon from '../Icon.svelte';
  let { conn, cwd = '', onclose, onstarted }: { conn: MachineConn; cwd?: string; onclose: () => void; onstarted: (s: SessionRow) => void } = $props();
  // svelte-ignore state_referenced_locally
  const KEY = `coderail.new.${conn.id}`;
  const last = kept<{ harness?: string; cwd?: string }>(KEY, {});
  let harnesses = $state<HarnessInfo[] | null>(null);
  let harness = $state(last.harness ?? '');
  // svelte-ignore state_referenced_locally
  let folder = $state(cwd || last.cwd || '');
  let busy = $state(false);
  let error = $state<string | null>(null);
  onMount(async () => {
    try { harnesses = await conn.call<HarnessInfo[]>('agent.harnesses'); }
    catch { harnesses = conn.info?.harnesses ?? []; }
    const ok = usable();
    if (!ok.some((h) => h.id === harness)) harness = ok[0]?.id ?? '';
  });
  const usable = () => (harnesses ?? []).filter((h) => h.installed && conn.harnessAllowed(h.id));
  async function start() {
    if (!harness || !folder) return;
    busy = true; error = null;
    try {
      const s = await conn.call<SessionRow>('agent.new', { harness, cwd: folder }, 120_000);
      keep(KEY, { harness, cwd: folder });
      if (!conn.sessions.some((x) => x.sessionId === s.sessionId)) conn.sessions = [s, ...conn.sessions];
      onstarted(s);
      onclose();
    } catch (e) { error = plainError(e); }
    busy = false;
  }
</script>

<Sheet title="New session" width={560} {onclose}>
  <div class="form">
    <div class="lbl-field">Agent
      {#if !harnesses}<div class="wait"><span class="spinner"></span></div>
      {:else}
        <OptionGroup label="Agent">
          {#each harnesses as h (h.id)}
            {@const allowed = conn.harnessAllowed(h.id)}
            <OptionRow compact selected={harness === h.id} disabled={!h.installed || !allowed} title={h.name}
              description={!h.installed ? 'Not installed on this computer' : !allowed ? 'Not allowed for you here' : h.version ?? undefined}
              onselect={() => (harness = h.id)}>
              {#snippet lead()}<HarnessMark harness={h.id} size={24} name={h.name} />{/snippet}
            </OptionRow>
          {/each}
        </OptionGroup>
        {#if !usable().length}<div class="err"><Icon name="warning" size={15} />No agent you can use is installed on this computer.</div>{/if}
      {/if}
    </div>
    <div class="lbl-field">Folder<FolderPicker {conn} bind:value={folder} height={220} /></div>
    {#if error}<div class="err"><Icon name="warning" size={15} />{error}</div>{/if}
  </div>
  {#snippet footer()}
    <span class="path mono"><span dir="ltr" class="in">{folder}</span></span>
    <span class="sp"></span>
    <Button onclick={onclose}>Cancel</Button>
    <Button variant="primary" {busy} disabled={!harness || !folder} onclick={start}>Start</Button>
  {/snippet}
</Sheet>

<style>
  .wait { padding: var(--sp-3); display: flex; justify-content: center; }
  .path .in { unicode-bidi: isolate; }
  .path { color: var(--muted); min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; flex: 0 1 auto; }
</style>
