<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Pull requests, through the computer's own `gh`: open, yours, or closed ones; each opening to its description, its
  // checks (a failed run can run again), its changed files, and Check out, Merge (the ways the repository allows) and
  // Open on GitHub. Without gh, or signed out of it, says how to fix that on the computer.
  import { untrack } from 'svelte';
  import type { GhPull } from '@coderail/protocol';
  import type { GitRepo } from '../../../lib/git.svelte';
  import { openWeb } from '../../../lib/git.svelte';
  import { app } from '../../../lib/app.svelte';
  import { plainError } from '../../../lib/api';
  import { edges } from '../../../lib/edges';
  import { ago } from '../../../lib/format';
  import { parseUnified, extOf, type FileDiff } from '../../../lib/diffs';
  import { slideOpen } from '../../../lib/slide';
  import { tip } from '../../../lib/tip';
  import Icon from '../../Icon.svelte';
  import PathLabel from '../../PathLabel.svelte';
  import DiffView from '../../DiffView.svelte';
  import CardLoad from '../../CardLoad.svelte';
  import Markdown from '../../Markdown.svelte';
  import Button from '../../ui/Button.svelte';
  import Menu from '../../ui/Menu.svelte';
  import SegmentedControl from '../../ui/SegmentedControl.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import ChecksBadge from './ChecksBadge.svelte';
  let { repo, mode, wrap, onchanges }: { repo: GitRepo; mode: 'unified' | 'split'; wrap: boolean; onchanges: () => void } = $props();
  const st = $derived(repo.st!);
  let filter = $state<'open' | 'mine' | 'closed'>('open');
  let list = $state<GhPull[] | null>(null);
  let error = $state<string | null>(null);
  let openN = $state<number | null>(null);
  let detail = $state<GhPull | 'loading' | null>(null);
  let files = $state<FileDiff[] | 'loading' | null>(null);
  let fileOpen = $state<Record<string, boolean>>({});
  let mergeMenu = $state<HTMLElement | null>(null);

  async function load(fresh = false) {
    const f = filter;
    error = null;
    try {
      const l = await repo.call<GhPull[]>('gh.pulls', { state: f === 'mine' ? 'open' : f === 'closed' ? 'all' : 'open', mine: f === 'mine', fresh }, 45_000);
      if (f === filter) list = f === 'closed' ? l.filter((p) => p.state !== 'OPEN') : l;
    } catch (e) { if (f === filter) { error = plainError(e); list = list ?? null; } }
  }
  $effect(() => { void filter; untrack(() => { list = null; openN = null; void load(); }); });

  async function toggle(p: GhPull, fresh = false) {
    if (openN === p.number && !fresh) { openN = null; return; }
    openN = p.number;
    if (!fresh) { detail = 'loading'; files = null; fileOpen = {}; }
    try { detail = await repo.call<GhPull>('gh.pull', { number: p.number, fresh }, 45_000); } catch (e) { app.toast(plainError(e), 'warning'); openN = null; }
  }
  async function showFiles(n: number) {
    files = 'loading';
    try { files = parseUnified((await repo.call<{ diff: string; truncated?: boolean }>('gh.diff', { number: n }, 60_000)).diff); } catch (e) { app.toast(plainError(e), 'warning'); files = null; }
  }
  const METHOD: Record<string, string> = { squash: 'Squash and merge', merge: 'Create a merge commit', rebase: 'Rebase and merge' };
  function merge(p: GhPull, method: string) {
    app.confirmIt({ title: `${METHOD[method]}: #${p.number}?`, body: `${p.title}\n\n${p.head} into ${p.base}, on GitHub.`, yes: METHOD[method],
      run: async () => { await repo.run('merge', 'gh.merge', { number: p.number, method, head: p.headOid }, `Merged #${p.number}`); void load(true); void toggle(p, true); } });
  }
  function checkout(p: GhPull) {
    void repo.run('checkout', 'gh.checkout', { number: p.number }, `On ${p.head}`, 115_000).then(() => onchanges());
  }
  const REVIEW: Record<string, string> = { APPROVED: 'Approved', CHANGES_REQUESTED: 'Changes requested', REVIEW_REQUIRED: 'Review required' };
  const ICON: Record<string, string> = { pass: 'success', fail: 'error', pending: 'clock', skipping: 'details', cancel: 'stop' };
</script>

{#if repo.gh?.gh === 'missing'}
  <EmptyState compact icon="branch" text="GitHub CLI isn’t on this computer" tip="Install gh on the computer (cli.github.com), then sign in with `gh auth login`. CodeRail uses its sign-in and never holds a token." />
{:else if repo.gh?.gh === 'signed-out'}
  <EmptyState compact icon="lock" text="GitHub CLI isn’t signed in" tip="On the computer, run `gh auth login` (in a terminal here works too). CodeRail uses its sign-in and never holds a token."
    action={{ label: 'Check again', run: () => { repo.gh = undefined; void repo.load(); } }} />
{:else}
  <div class="body scroll" {@attach edges()}>
    <div class="tools">
      <SegmentedControl size="sm" label="Pull requests" value={filter} onchange={(v) => (filter = v as typeof filter)} options={[{ id: 'open', label: 'Open' }, { id: 'mine', label: 'Yours' }, { id: 'closed', label: 'Closed' }]} />
      <span class="sp"></span>
      <Button icon="refresh" variant="icon" size="sm" tip="Refresh" onclick={() => load(true)} />
      {#if repo.gh}<Button icon="ext" variant="icon" size="sm" tip="Open on GitHub" onclick={() => openWeb(repo.gh!.url + '/pulls')} />{/if}
    </div>
    {#if list === null}<CardLoad {error} retry={() => load(true)} />
    {:else if !list.length}<EmptyState compact icon="branch" text={filter === 'mine' ? 'You have no open pull requests' : filter === 'closed' ? 'No closed pull requests' : 'No open pull requests'} />
    {:else}
      <div class="list">
        {#each list as p (p.number)}
          {@const mine = st.branch === p.head}
          <button class="prow" class:open={openN === p.number} onclick={() => toggle(p)} aria-expanded={openN === p.number}>
            <span class="pi {p.state.toLowerCase()}" class:draft={p.draft}><Icon name="branch" size={15} /></span>
            <span class="pm">
              <span class="pt cut">{p.title}</span>
              <span class="pmeta">#{p.number} · {p.author} · {ago(p.updatedAt, app.now)}{#if p.draft} · draft{/if}{#if REVIEW[p.review]} · {REVIEW[p.review]}{/if}</span>
            </span>
            {#if mine}<span class="here" {@attach tip('Checked out here')}><Icon name="check" size={14} /></span>{/if}
            <ChecksBadge checks={p.checks} />
          </button>
          {#if openN === p.number}
            <div class="detail" transition:slideOpen>
              {#if detail === 'loading' || !detail}<div class="reading"><span class="spinner"></span>Reading…</div>
              {:else}
                {@const d = detail}
                <div class="branches mono"><span class="cut">{d.head}</span><Icon name="arrowr" size={13} /><span class="cut">{d.base}</span>
                  {#if d.additions != null}<span class="counts"><span class="add">+{d.additions}</span><span class="del">−{d.deletions}</span> · {d.changedFiles} file{d.changedFiles === 1 ? '' : 's'}</span>{/if}</div>
                <div class="acts">
                  <Button size="sm" variant="quiet" icon="ext" onclick={() => openWeb(d.url)}>Open on GitHub</Button>
                  {#if d.state === 'OPEN'}
                    {#if !mine}<Button size="sm" variant="quiet" icon="branch" disabled={!repo.can || !!repo.busy} busy={repo.busy === 'checkout'} tip={st.files.length ? 'Commit or stash your changes first' : `Switch to ${d.head}`} onclick={() => checkout(d)}>Check out</Button>{/if}
                    {#if repo.gh?.mergeMethods?.length && ['ADMIN', 'MAINTAIN', 'WRITE'].includes(repo.gh.permission ?? '')}
                      <Button size="sm" variant="primary" iconEnd="chevd" disabled={!repo.can || !!repo.busy || d.draft || d.mergeable === 'CONFLICTING'} busy={repo.busy === 'merge'}
                        tip={d.draft ? 'A draft can’t be merged' : d.mergeable === 'CONFLICTING' ? 'It has conflicts with its base' : 'Merge on GitHub'}
                        onclick={(e) => (mergeMenu = e.currentTarget as HTMLElement)}>Merge</Button>
                    {/if}
                  {/if}
                </div>
                {@const body = (d.body ?? '').replace(/<!--[\s\S]*?-->/g, '').trim()}
                {#if body}<div class="desc"><Markdown text={body} /></div>{/if}
                {#if d.list?.length}
                  <div class="h">Checks</div>
                  {#each d.list as c, i (i)}
                    <div class="check">
                      <span class="ci {c.bucket}"><Icon name={ICON[c.bucket]} size={15} /></span>
                      <span class="cut cn">{c.workflow ? `${c.workflow} / ` : ''}{c.name}</span>
                      {#if c.bucket === 'fail' && c.runId}<Button size="xs" variant="quiet" disabled={!repo.can} onclick={() => repo.run('rerun', 'gh.rerun', { runId: c.runId, failed: true }, 'Running the failed jobs again')}>Re-run</Button>{/if}
                      {#if c.link}<Button icon="ext" variant="icon" size="xs" tip="Details" onclick={() => openWeb(c.link!)} />{/if}
                    </div>
                  {/each}
                {/if}
                <div class="h">Files</div>
                {#if files === null}<button class="showall" onclick={() => showFiles(d.number)}>Show changed files</button>
                {:else if files === 'loading'}<div class="reading"><span class="spinner"></span>Reading…</div>
                {:else}
                  {#each files as f (f.path)}
                    <button class="file" onclick={() => (fileOpen = { ...fileOpen, [f.path]: !fileOpen[f.path] })}>
                      <span class="chev" class:on={fileOpen[f.path]}><Icon name="chevr" size={12} /></span>
                      <span class="path"><PathLabel path={f.path} split /></span>
                      <span class="counts"><span class="add">+{f.added}</span><span class="del">−{f.removed}</span></span>
                    </button>
                    {#if fileOpen[f.path]}<div class="dbody" transition:slideOpen>{#if f.binary}<div class="note">Binary file.</div>{:else}<DiffView lines={f.lines} lang={extOf(f.path)} {mode} {wrap} />{/if}</div>{/if}
                  {/each}
                {/if}
              {/if}
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/if}

{#if mergeMenu && detail && detail !== 'loading'}
  {@const d = detail}
  <Menu anchor={mergeMenu} width={240} items={(repo.gh?.mergeMethods ?? []).map((m) => ({ id: m, label: METHOD[m] }))} onpick={(id) => merge(d, id)} onclose={() => (mergeMenu = null)} label="Merge" />
{/if}

<style>
  .sp { flex: 1; }
  .body { flex: 1; min-height: 0; padding: var(--sp-2) var(--gutter) var(--gutter); display: flex; flex-direction: column; }
  .body > :global(*) { flex-shrink: 0; }
  .tools { display: flex; align-items: center; gap: var(--sp-1); margin-bottom: var(--sp-2); }
  .list { display: flex; flex-direction: column; gap: var(--row-gap); }
  .prow { display: flex; align-items: center; gap: var(--sp-2); width: calc(100% + 2 * var(--row-x)); margin: 0 calc(-1 * var(--row-x)); padding: var(--sp-1h) var(--row-x); border-radius: var(--r-sm); text-align: left; }
  .prow:hover { background: var(--hover); }
  .pi { flex: none; display: inline-flex; color: var(--ok); }
  .pi.merged { color: var(--accent); } .pi.closed { color: var(--danger); } .pi.draft { color: var(--muted); }
  .pm { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .pt { font-size: var(--fs-quiet); color: var(--ink); white-space: nowrap; overflow: hidden; }
  .pmeta { font-size: var(--fs-small); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .here { flex: none; display: inline-flex; color: var(--accent); }
  .detail { display: flex; flex-direction: column; gap: var(--sp-1); padding: var(--sp-1) 0 var(--sp-3) var(--sp-2); }
  .branches { display: flex; align-items: center; gap: var(--sp-1); font-size: 12px; color: var(--muted); min-width: 0; }
  .branches .cut { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 40%; }
  .branches .counts { margin-left: auto; font-family: var(--sans); }
  .acts { display: flex; flex-wrap: wrap; gap: var(--sp-1); padding: var(--sp-1) 0; }
  .desc { font-size: var(--fs-small); color: var(--ink2); padding: var(--sp-1) 0; max-height: 320px; overflow: auto; }
  .h { font-size: var(--fs-meta); color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; padding-top: var(--sp-2); }
  .check { display: flex; align-items: center; gap: var(--sp-2); min-height: 28px; font-size: var(--fs-small); }
  .cn { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--ink2); }
  .ci { flex: none; display: inline-flex; }
  .ci.pass { color: var(--ok); } .ci.fail { color: var(--danger); } .ci.pending { color: var(--warn); } .ci.skipping, .ci.cancel { color: var(--muted); }
  .file { display: flex; align-items: center; gap: var(--row-x); height: var(--row); width: 100%; padding: 0 var(--sp-1); border-radius: var(--r-sm); text-align: left; }
  .file:hover { background: var(--hover); }
  .chev { color: var(--muted); display: inline-flex; transition: transform var(--t-base) var(--ease-base); flex: none; }
  .chev.on { transform: rotate(90deg); }
  .path { flex: 1; min-width: 0; font-size: var(--fs-small); }
  .counts { flex: none; display: inline-flex; gap: var(--sp-1h); font-family: var(--mono); font-size: var(--fs-small); color: var(--muted); }
  .add { color: var(--diff-added-ink); } .del { color: var(--diff-removed-ink); }
  .dbody { margin: 0 0 var(--sp-2); border-radius: var(--r-md); background: var(--tint); overflow: hidden; }
  .reading { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); color: var(--muted); font-size: var(--fs-quiet); }
  .note { padding: var(--sp-2) var(--sp-3); color: var(--muted); font-size: var(--fs-small); }
</style>
