<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The History tab, GitHub Desktop's: the branch's commits (an arrow on those not pushed yet, their tags), each
  // opening to its message and files, each file to its diff; on a commit's menu, Copy SHA, View on the web, Create
  // branch or tag from it, Check it out, Revert it, Reset to it, and for the last one not pushed, Amend or Undo.
  // Compare: another branch's commits this one doesn't have (Behind; Merge them in, or Cherry-pick one) or the
  // other way (Ahead).
  import { untrack } from 'svelte';
  import type { GitCommit, GitCommitFile } from '@coderail/protocol';
  import type { GitRepo } from '../../../lib/git.svelte';
  import { ghLink, openWeb } from '../../../lib/git.svelte';
  import { app, copyText } from '../../../lib/app.svelte';
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
  import Button from '../../ui/Button.svelte';
  import Menu, { type Item } from '../../ui/Menu.svelte';
  import SegmentedControl from '../../ui/SegmentedControl.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import Markdown from '../../Markdown.svelte';
  let { repo, mode, wrap, onchanges }: { repo: GitRepo; mode: 'unified' | 'split'; wrap: boolean; onchanges: () => void } = $props();
  const st = $derived(repo.st!);
  let log = $state<GitCommit[] | null>(null);
  let more = $state(true);
  let compare = $state<string | null>(null);
  let side = $state<'behind' | 'ahead'>('behind');
  let counts = $state<{ ahead: number; behind: number } | null>(null);
  let openC = $state<string | null>(null);
  let detail = $state<{ commit: GitCommit; files: GitCommitFile[] } | 'loading' | null>(null);
  let fileOpen = $state<Record<string, FileDiff | 'loading' | { error: string }>>({});
  let menu = $state<{ c: GitCommit; anchor?: HTMLElement; x?: number; y?: number } | null>(null);
  let chooser = $state<HTMLElement | null>(null);

  const range = $derived(compare ? (side === 'behind' ? `HEAD..${compare}` : `${compare}..HEAD`) : undefined);
  async function load(again = false) {
    const r = range;
    try {
      const l = await repo.call<GitCommit[]>('git.log', { limit: 50, skip: again ? (log?.length ?? 0) : 0, ...(r ? { rev: r } : {}) });
      if (r !== range) return;
      log = again ? [...(log ?? []), ...l] : l;
      more = l.length === 50;
    } catch (e) { app.toast(plainError(e), 'warning'); log = log ?? []; }
  }
  $effect(() => { void range; void repo.logStamp; untrack(() => { log = null; openC = null; void load(); }); });
  $effect(() => { void repo.logStamp; const c = compare; untrack(() => { counts = null; if (c) repo.call('git.compare', { branch: c }).then((x) => { if (compare === c) counts = x; }).catch(() => {}); }); });

  async function toggle(c: GitCommit) {
    if (openC === c.hash) { openC = null; return; }
    openC = c.hash; detail = 'loading'; fileOpen = {};
    try { detail = await repo.call('git.show', { rev: c.hash }); } catch (e) { app.toast(plainError(e), 'warning'); openC = null; }
  }
  async function toggleFile(c: GitCommit, f: GitCommitFile) {
    if (fileOpen[f.path]) { const x = { ...fileOpen }; delete x[f.path]; fileOpen = x; return; }
    fileOpen = { ...fileOpen, [f.path]: 'loading' };
    try {
      const r = await repo.call<{ diff: string; truncated?: boolean }>('git.diff', { rev: c.hash, path: f.path });
      fileOpen = { ...fileOpen, [f.path]: parseUnified(r.diff)[0] ?? { path: f.path, lines: [], added: 0, removed: 0, binary: false } };
    } catch (e) { fileOpen = { ...fileOpen, [f.path]: { error: plainError(e) } }; }
  }

  // ---- a commit's menu
  const top = $derived(log?.[0]);
  function items(c: GitCommit): Item[] {
    const can = repo.can && !st.operation;
    const last = !compare && c.hash === top?.hash && c.hash === st.head;
    const out: Item[] = [];
    if (last && c.local) out.push({ id: 'amend', label: 'Amend commit…', icon: 'edit', disabled: !can }, { id: 'undo', label: 'Undo commit', icon: 'restore', disabled: !can || (c.parents?.length ?? 0) > 1 }, { id: 's0', sep: true });
    if (compare && side === 'behind') out.push({ id: 'pick', label: `Cherry-pick onto ${st.branch ?? 'HEAD'}`, icon: 'plus', disabled: !can }, { id: 's0', sep: true });
    out.push({ id: 'branch', label: 'Create branch from commit…', icon: 'branch', disabled: !can }, { id: 'tag', label: 'Create tag…', icon: 'hash', disabled: !can });
    for (const t of c.tags ?? []) out.push({ id: 'untag:' + t, label: `Delete tag ${t}`, icon: 'trash', disabled: !can });
    out.push({ id: 's1', sep: true });
    if (!compare || side === 'ahead') {
      out.push({ id: 'revert', label: 'Revert changes in commit', icon: 'restore', disabled: !can });
      if (c.hash !== st.head) out.push({ id: 'reset', label: 'Reset to commit…', icon: 'history', disabled: !can });
    }
    out.push({ id: 'checkout', label: 'Check out commit', icon: 'diff', disabled: !can }, { id: 's2', sep: true }, { id: 'sha', label: 'Copy SHA', icon: 'copy' });
    if (c.tags?.length) out.push({ id: 'copytag', label: 'Copy tag', icon: 'copy' });
    if (st.remote?.web && !c.local) out.push({ id: 'web', label: 'View on the web', icon: 'ext' });
    return out;
  }
  function pick(id: string, c: GitCommit) {
    if (id === 'sha') copyText(c.hash, 'SHA copied');
    else if (id === 'copytag') copyText(c.tags![0], 'Tag copied');
    else if (id === 'web' && st.remote?.web) openWeb(ghLink.commit(st.remote.web, c.hash));
    else if (id === 'amend') { repo.amendNow = true; onchanges(); }
    else if (id === 'undo') void repo.run<{ message: string }>('undo', 'git.undo', {}, 'Undone: its changes are back').then((r) => { if (r) { repo.restored = r.message; onchanges(); } });
    else if (id === 'branch') app.ask({ title: 'Create a branch', label: `From ${c.short}: ${c.subject}`, value: '', placeholder: 'feature/name', yes: 'Create branch', run: async (v) => {
      try { await repo.call('git.checkout', { branch: v.trim(), create: true, from: c.hash }); app.toast(`On ${v.trim()}`, 'success'); await repo.load(); return null; } catch (e) { return plainError(e); }
    } });
    else if (id === 'tag') app.ask({ title: 'Create a tag', label: `On ${c.short}: ${c.subject}`, value: '', placeholder: 'v1.0.0', yes: 'Create tag', run: async (v) => {
      try { await repo.call('git.tag', { name: v.trim(), rev: c.hash }); app.toast(`Tagged ${v.trim()}: push with tags to share it`, 'success'); repo.logStamp++; return null; } catch (e) { return plainError(e); }
    } });
    else if (id.startsWith('untag:')) { const t = id.slice(6); app.confirmIt({ title: `Delete the tag ${t}?`, body: 'Only here: a copy on the remote stays.', yes: 'Delete tag', danger: true, run: () => { void repo.run('tag', 'git.tag', { name: t, delete: true }, `Deleted ${t}`).then(() => repo.logStamp++); } }); }
    else if (id === 'revert') void repo.run('revert', 'git.revert', { rev: c.hash }, `Reverted ${c.short}`);
    else if (id === 'pick') void repo.run('pick', 'git.cherry_pick', { revs: [c.hash] }, `Picked ${c.short} onto ${st.branch}`);
    else if (id === 'reset') app.confirmIt({ title: `Reset ${st.branch ?? 'HEAD'} to ${c.short}?`, body: 'The commits after it go; their changes stay as changes, to commit again or discard.', yes: 'Reset', danger: true,
      run: () => { void repo.run('reset', 'git.reset', { rev: c.hash }, `Reset to ${c.short}`).then(() => onchanges()); } });
    else if (id === 'checkout') app.confirmIt({ title: `Check out ${c.short}?`, body: 'You’ll be on that commit with no branch (detached HEAD). Make a branch there to keep new commits.', yes: 'Check out',
      run: () => { void repo.run('checkout', 'git.checkout', { rev: c.hash }, `On ${c.short}`); } });
  }

  // ---- compare
  const branchItems = $derived.by((): Item[] => {
    const b = repo.branches;
    if (!b) return [{ id: 'loading', label: 'Loading…', disabled: true }];
    const out: Item[] = b.local.filter((x) => x.name !== b.current).map((x) => ({ id: 'b:' + x.name, label: x.name, desc: x.subject ? `${ago(x.at, app.now)} · ${x.subject}` : undefined }));
    const remote = b.remote.filter((r) => !b.local.some((l) => r.name.endsWith('/' + l.name) && l.name === b.current));
    if (remote.length) out.push({ id: 'h', header: true, label: 'Remote' }, ...remote.slice(0, 40).map((x) => ({ id: 'b:' + x.name, label: x.name })));
    return out;
  });
  async function openChooser(el: HTMLElement) { chooser = el; await repo.loadBranches(); }
</script>

<div class="body scroll" {@attach edges()}>
  <div class="tools">
    {#if compare}
      <button class="cmp on" onclick={(e) => openChooser(e.currentTarget as HTMLElement)}><Icon name="branch" size={15} /><span class="cut">{compare}</span><Icon name="chevd" size={14} /></button>
      <SegmentedControl size="sm" label="Direction" value={side} onchange={(v) => (side = v as typeof side)}
        options={[{ id: 'behind', label: `Behind${counts ? ' ' + counts.behind : ''}`, tip: `Commits on ${compare} that ${st.branch ?? 'HEAD'} doesn’t have` }, { id: 'ahead', label: `Ahead${counts ? ' ' + counts.ahead : ''}`, tip: `Commits on ${st.branch ?? 'HEAD'} that ${compare} doesn’t have` }]} />
      <span class="sp"></span>
      <Button icon="close" variant="icon" size="sm" tip="Back to history" onclick={() => (compare = null)} />
    {:else}
      <button class="cmp" onclick={(e) => openChooser(e.currentTarget as HTMLElement)}><Icon name="branch" size={15} /><span>Compare to a branch…</span></button>
    {/if}
  </div>
  {#if compare && side === 'behind' && counts?.behind}
    <div class="mergebar">
      <span>{counts.behind} commit{counts.behind === 1 ? '' : 's'} on {compare} {counts.behind === 1 ? 'isn’t' : 'aren’t'} on {st.branch ?? 'HEAD'}.</span>
      <Button size="sm" variant="primary" disabled={!repo.can || !!repo.busy || !!st.operation} busy={repo.busy === 'merge'}
        onclick={() => repo.run('merge', 'git.merge', { branch: compare }, `Merged ${compare} into ${st.branch}`).then(() => onchanges())}>Merge into {st.branch ?? 'HEAD'}</Button>
    </div>
  {/if}
  {#if log === null}<CardLoad retry={() => load()} />
  {:else if !log.length}<EmptyState compact icon="history" text={compare ? (side === 'behind' ? `Nothing on ${compare} to bring in` : `Nothing here that ${compare} doesn’t have`) : 'No commits yet'} />
  {:else}
    <div class="list">
      {#each log as c (c.hash)}
        <div class="crow" class:open={openC === c.hash} class:menu={menu?.c === c} role="group" oncontextmenu={(e) => { e.preventDefault(); menu = { c, x: e.clientX, y: e.clientY }; }}>
          <button class="commit" onclick={() => toggle(c)} aria-expanded={openC === c.hash}>
            <span class="cm">
              <span class="cs cut">{c.subject}</span>
              <span class="cmeta">{c.author} · {ago(c.at, app.now)}{#if c.parents && c.parents.length > 1}<span class="faint"> · merge</span>{/if}</span>
            </span>
            {#each c.tags ?? [] as t (t)}<span class="tag cut">{t}</span>{/each}
            {#if c.local}<span class="up" {@attach tip('Not pushed yet')}><Icon name="upload" size={14} /></span>{/if}
          </button>
          <span class="acts"><Button icon="more" variant="icon" size="xs" tip="More" on={menu?.c === c} onclick={(e) => (menu = { c, anchor: e.currentTarget as HTMLElement })} /></span>
        </div>
        {#if openC === c.hash}
          <div class="detail" transition:slideOpen>
            {#if detail === 'loading' || !detail}<div class="reading"><span class="spinner"></span>Reading…</div>
            {:else}
              <div class="dmeta"><span class="mono">{c.short}</span> · {c.email} · {new Date(c.at).toLocaleString()}</div>
              {#if detail.commit.body}<div class="dbodytext"><Markdown text={detail.commit.body} /></div>{/if}
              {#if !detail.files.length}<div class="note">No file changes.</div>{/if}
              {#each detail.files as f (f.path)}
                {@const d = fileOpen[f.path]}
                <button class="file" onclick={() => toggleFile(c, f)} aria-expanded={!!d}>
                  <span class="chev" class:on={!!d}><Icon name="chevr" size={12} /></span>
                  <span class="st st-{f.status}">{f.status}</span>
                  <span class="path">{#if f.orig}<PathLabel path={f.orig} split /><span class="faint"> → </span>{/if}<PathLabel path={f.path} split /></span>
                  {#if f.added != null}<span class="counts"><span class="add">+{f.added}</span><span class="del">−{f.removed}</span></span>{:else}<span class="faint">binary</span>{/if}
                </button>
                {#if d}
                  <div class="dbody" transition:slideOpen>
                    {#if d === 'loading'}<div class="reading"><span class="spinner"></span>Reading…</div>
                    {:else if 'error' in d}<div class="note">{d.error}</div>
                    {:else if d.binary}<div class="note">Binary file.</div>
                    {:else if !d.lines.length}<div class="note">No lines changed.</div>
                    {:else}<DiffView lines={d.lines} lang={extOf(f.path)} {mode} {wrap} />{/if}
                  </div>
                {/if}
              {/each}
            {/if}
          </div>
        {/if}
      {/each}
      {#if more}<button class="showall" onclick={() => load(true)}>Show more</button>{/if}
    </div>
  {/if}
</div>

{#each menu ? [menu] : [] as m (m)}
  <Menu anchor={m.anchor} x={m.x} y={m.y} end={!!m.anchor} width={250} items={items(m.c)} onpick={(id) => pick(id, m.c)} onclose={() => (menu = null)} />
{/each}
{#if chooser}
  <Menu anchor={chooser} width={300} items={branchItems} search="Filter branches" label="Compare to" onpick={(id) => { if (id.startsWith('b:')) { compare = id.slice(2); side = 'behind'; } }} onclose={() => (chooser = null)} />
{/if}

<style>
  .sp { flex: 1; }
  .faint { color: var(--faint); }
  .body { flex: 1; min-height: 0; padding: var(--sp-2) var(--gutter) var(--gutter); display: flex; flex-direction: column; }
  .body > :global(*) { flex-shrink: 0; }
  .tools { display: flex; align-items: center; gap: var(--sp-1); margin-bottom: var(--sp-2); min-height: 28px; }
  .cmp { display: inline-flex; align-items: center; gap: var(--sp-1h); height: 28px; padding: 0 var(--sp-2); border-radius: var(--r-md); color: var(--muted); font-size: var(--fs-small); min-width: 0; max-width: 50%; }
  .cmp:hover { background: var(--hover); color: var(--ink); }
  .cmp.on { color: var(--ink); background: var(--tint); box-shadow: inset 0 0 0 var(--hairline) var(--hair); }
  .cmp :global(svg) { flex: none; }
  .mergebar { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); margin-bottom: var(--sp-2); border-radius: var(--r-md); background: var(--accent-tint); font-size: var(--fs-small); color: var(--ink2); }
  .mergebar span { flex: 1; min-width: 0; }
  .list { display: flex; flex-direction: column; gap: var(--row-gap); }
  .crow { position: relative; display: flex; align-items: center; margin: 0 calc(-1 * var(--row-x)); border-radius: var(--r-sm); transition: background var(--t-fast) ease-out; }
  .crow:hover, .crow.menu { background: var(--hover); }
  .commit { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-1h) var(--sp-1) var(--sp-1h) var(--row-x); text-align: left; }
  .cm { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .cs { font-size: var(--fs-quiet); color: var(--ink); white-space: nowrap; overflow: hidden; }
  .cmeta { font-size: var(--fs-small); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tag { flex: 0 1 auto; max-width: 30%; height: 20px; line-height: 20px; padding: 0 var(--sp-1h); border-radius: 999px; background: var(--accent-tint); color: var(--accent); font-size: var(--fs-meta); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .up { flex: none; display: inline-flex; color: var(--muted); }
  .acts { flex: none; display: inline-flex; padding-right: var(--sp-1h); opacity: 0; transition: opacity var(--t-fast) ease-out; }
  .crow:hover .acts, .crow.menu .acts, .acts:focus-within { opacity: 1; }
  :global(:root[data-phone]) .acts { opacity: 1; }
  .detail { padding: var(--sp-1) 0 var(--sp-3) var(--sp-2); display: flex; flex-direction: column; gap: var(--row-gap); }
  .dmeta { font-size: var(--fs-small); color: var(--muted); padding: 0 0 var(--sp-1); }
  .dmeta .mono { font-size: 12px; }
  .dbodytext { font-size: var(--fs-small); color: var(--ink2); padding: 0 0 var(--sp-2); }
  .file { display: flex; align-items: center; gap: var(--row-x); height: var(--row); width: 100%; padding: 0 var(--sp-1); border-radius: var(--r-sm); text-align: left; }
  .file:hover { background: var(--hover); }
  .chev { color: var(--muted); display: inline-flex; transition: transform var(--t-base) var(--ease-base); flex: none; }
  .chev.on { transform: rotate(90deg); }
  .st { font-family: var(--mono); font-size: var(--fs-small); font-weight: var(--w-control); width: 14px; text-align: center; color: var(--muted); flex: none; }
  .st-A { color: var(--diff-added-ink); } .st-D { color: var(--diff-removed-ink); } .st-R { color: var(--accent); }
  .path { flex: 1; min-width: 0; font-size: var(--fs-small); display: flex; align-items: center; overflow: hidden; }
  .counts { flex: none; display: inline-flex; gap: var(--sp-1h); font-family: var(--mono); font-size: var(--fs-small); }
  .add { color: var(--diff-added-ink); } .del { color: var(--diff-removed-ink); }
  .dbody { margin: 0 0 var(--sp-2); border-radius: var(--r-md); background: var(--tint); overflow: hidden; }
  .reading { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); color: var(--muted); font-size: var(--fs-quiet); }
  .note { padding: var(--sp-2) var(--sp-3); color: var(--muted); font-size: var(--fs-small); }
</style>
