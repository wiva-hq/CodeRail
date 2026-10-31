<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Changes and git, as GitHub Desktop has them (on `git.*`, and `gh.*` for GitHub through the computer's own sign-in):
  // the branch (switch, with your changes left on it or brought along; new, merge, squash, rebase, update from the
  // default branch, rename, delete), the one sync button (Publish branch, Pull, Push or Fetch, by what's due), and
  // the tabs: Changes (pick files and lines, commit), History (and compare to a branch), Pull requests. A folder
  // that isn't a repository can become one, or get one cloned into it. Read again when the window comes back, the
  // session's turn ends, or something here changes it. Viewers see it all read only.
  import { untrack } from 'svelte';
  import type { MachineConn } from '../../lib/machine.svelte';
  import { GitRepo, ghLink, openWeb } from '../../lib/git.svelte';
  import { app, copyText } from '../../lib/app.svelte';
  import { plainError } from '../../lib/api';
  import { kept, keep } from '../../lib/kept';
  import { ago } from '../../lib/format';
  import { tilde, baseName } from '../../lib/machineText';
  import { tip } from '../../lib/tip';
  import Icon from '../Icon.svelte';
  import CardLoad from '../CardLoad.svelte';
  import FolderPicker from '../FolderPicker.svelte';
  import Button from '../ui/Button.svelte';
  import Sheet from '../ui/Sheet.svelte';
  import Switch from '../ui/Switch.svelte';
  import Menu, { type Item } from '../ui/Menu.svelte';
  import SegmentedControl from '../ui/SegmentedControl.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import ChangesTab from './git/ChangesTab.svelte';
  import HistoryTab from './git/HistoryTab.svelte';
  import PullsTab from './git/PullsTab.svelte';
  let { conn, cwd = null, stamp = 0 }: { conn: MachineConn; cwd?: string | null; stamp?: number } = $props();
  let chosen = $state<string | null>(null);
  $effect(() => { void cwd; untrack(() => { chosen = null; }); });
  const dir = $derived(chosen ?? cwd);
  let repo = $state<GitRepo | null>(null);
  $effect(() => { const d = dir; void conn.online; untrack(() => { repo = d ? new GitRepo(conn, d) : null; void repo?.load(); }); });
  $effect(() => { void stamp; untrack(() => { if (repo?.st !== undefined) void repo?.load(); }); });
  $effect(() => {
    const again = () => { if (document.visibilityState === 'visible') void repo?.load(); };
    window.addEventListener('focus', again);
    return () => window.removeEventListener('focus', again);
  });
  const st = $derived(repo?.st);
  let tab = $state<'changes' | 'history' | 'pulls'>('changes');
  let mode = $state<'unified' | 'split'>(kept('coderail.diffMode', 'unified'));
  $effect(() => keep('coderail.diffMode', mode));
  let wrap = $state(false);
  let picking = $state(false);
  let pickValue = $state('');
  const can = $derived(conn.canAct);
  const why = $derived(!conn.online ? 'The computer is offline' : 'Viewers can’t change the repository');
  $effect(() => { if (tab === 'pulls' && st && !st.remote?.github) tab = 'changes'; });

  // ---- the sync button: what's due, as GitHub Desktop decides it
  const sync = $derived.by(() => {
    if (!st) return null;
    if (!st.remote) return repo?.everywhere ? { id: 'publish', label: 'Publish repository', icon: 'upload', tip: 'Make a GitHub repository of it and push' } : null;
    const name = st.remote.name;
    const fetched = st.fetchedAt ? `Last fetched ${ago(st.fetchedAt, app.now)}` : 'Never fetched';
    if (!st.branch) return { id: 'fetch', label: `Fetch ${name}`, icon: 'sync', tip: fetched };
    if (!st.upstream || st.upstreamGone) return { id: 'pubbranch', label: 'Publish branch', icon: 'upload', tip: `Push ${st.branch} to ${name}` };
    if (st.behind) return { id: 'pull', label: `Pull ${name}`, icon: 'arrowr', count: `↓${st.behind}${st.ahead ? ` ↑${st.ahead}` : ''}`, tip: `${st.behind} to pull${st.ahead ? `, ${st.ahead} to push` : ''} · ${fetched}` };
    if (st.ahead) return { id: 'push', label: `Push ${name}`, icon: 'upload', count: `↑${st.ahead}`, tip: `${st.ahead} to push to ${st.upstream}` };
    return { id: 'fetch', label: `Fetch ${name}`, icon: 'sync', tip: fetched };
  });
  function doSync(id: string) {
    if (!repo) return;
    if (id === 'fetch') void repo.run('sync', 'git.fetch', {}, 'Fetched', 120_000);
    else if (id === 'pull') void repo.run('sync', 'git.pull', {}, (r: any) => (r?.conflicts ? null : /Already up to date/.test(r?.output ?? '') ? 'Already up to date' : 'Pulled'), 120_000);
    else if (id === 'push') void repo.run('sync', 'git.push', {}, 'Pushed', 120_000);
    else if (id === 'pubbranch') void repo.run('sync', 'git.push', { setUpstream: true }, `Published ${st?.branch}`, 120_000);
    else if (id === 'force') app.confirmIt({ title: `Force push ${st?.branch}?`, body: `The branch on ${st?.remote?.name} is replaced with yours, unless someone pushed to it since you last fetched. Commits only there are lost.`, yes: 'Force push', danger: true,
      run: () => { void repo!.run('sync', 'git.push', { force: true }, 'Force pushed', 120_000); } });
    else if (id === 'tags') void repo.run('sync', 'git.push', { tags: true, setUpstream: !st?.upstream }, 'Pushed, with tags', 120_000);
    else if (id === 'publish') openPublish();
  }

  // ---- the ⋯ menu
  let more = $state<HTMLElement | null>(null);
  const moreItems = $derived.by((): Item[] => {
    const out: Item[] = [];
    if (st?.remote) {
      out.push({ id: 'fetch', label: `Fetch ${st.remote.name}`, icon: 'sync', disabled: !can }, { id: 'pull', label: `Pull ${st.remote.name}`, icon: 'arrowr', disabled: !can || !st.upstream },
        { id: 'push', label: st.upstream ? `Push ${st.remote.name}` : 'Publish branch', icon: 'upload', disabled: !can || !st.branch },
        { id: 'force', label: 'Force push…', icon: 'upload', disabled: !can || !st.upstream || !st.ahead, desc: st.ahead && st.behind ? 'Your branch and the remote’s went apart' : undefined },
        { id: 'tags', label: 'Push with tags', icon: 'hash', disabled: !can || !st.branch }, { id: 's0', sep: true });
      if (st.remote.web) out.push({ id: 'web', label: st.remote.github ? 'View on GitHub' : 'View on the web', icon: 'ext' });
      if (repo?.gh?.gh === 'ok' && st.branch) out.push(repo.pull ? { id: 'pr', label: `Open pull request #${repo.pull.number}`, icon: 'branch' } : { id: 'newpr', label: 'Create pull request…', icon: 'branch', disabled: !can || st.branch === (repo.gh.defaultBranch ?? st.defaultBranch) });
      else if (st.remote.web && st.branch && st.upstream) out.push({ id: 'compare', label: 'Compare on the web', icon: 'ext' });
      out.push({ id: 's1', sep: true });
    }
    if (st) {
      out.push({ id: 'space', label: 'Hide whitespace changes', icon: 'wave', on: repo?.hideSpace });
      if (st.branch) out.push({ id: 'copybranch', label: 'Copy branch name', icon: 'copy' });
      out.push({ id: 's2', sep: true });
    }
    out.push({ id: 'pick', label: 'Choose a folder…', icon: 'folder', disabled: !conn.online });
    if (chosen && cwd) out.push({ id: 'session', label: 'Back to the session folder', icon: 'arrowl' });
    out.push({ id: 'clone', label: 'Clone a repository…', icon: 'download', disabled: !can || !dir });
    if (st && !st.remote && repo?.everywhere) out.push({ id: 'publish', label: 'Publish to GitHub…', icon: 'upload', disabled: !can || st.unborn });
    return out;
  });
  function pickMore(id: string) {
    if (!repo) { if (id === 'pick') { pickValue = dir ?? ''; picking = true; } return; }
    if (['fetch', 'pull', 'force', 'tags', 'publish'].includes(id)) doSync(id);
    else if (id === 'push') doSync(st?.upstream ? 'push' : 'pubbranch');
    else if (id === 'web' && st?.remote?.web) openWeb(st.branch ? ghLink.tree(st.remote.web, st.branch) : st.remote.web);
    else if (id === 'compare' && st?.remote?.web && st.branch) openWeb(ghLink.compare(st.remote.web, st.defaultBranch ?? 'main', st.branch));
    else if (id === 'pr' && repo.pull) openWeb(repo.pull.url);
    else if (id === 'newpr') openPr();
    else if (id === 'space') repo.hideSpace = !repo.hideSpace;
    else if (id === 'copybranch' && st?.branch) copyText(st.branch, 'Branch name copied');
    else if (id === 'pick') { pickValue = dir ?? ''; picking = true; }
    else if (id === 'session') chosen = null;
    else if (id === 'clone') clone();
  }

  // ---- branches
  let branchMenu = $state<HTMLElement | null>(null);
  let chooser = $state<{ kind: 'merge' | 'squash' | 'rebase' | 'delete'; anchor: HTMLElement } | null>(null);
  async function openBranches(el: HTMLElement) { if (repo) repo.branches = null; branchMenu = el; await repo?.loadBranches(); }
  const branchItems = $derived.by((): Item[] => {
    const b = repo?.branches;
    if (!b) return [{ id: 'loading', label: 'Loading…', disabled: true }];
    const row = (n: string) => {
      const x = b.local.find((l) => l.name === n);
      const ab = x && (x.ahead || x.behind) ? ` · ${x.ahead ? '↑' + x.ahead : ''}${x.behind ? ' ↓' + x.behind : ''}` : '';
      return { id: 'b:' + n, label: n, on: n === b.current, desc: x ? `${ago(x.at, app.now)}${ab}` : undefined, disabled: !can };
    };
    const out: Item[] = [];
    const def = b.default && b.local.some((l) => l.name === b.default) ? b.default : null;
    if (def) out.push({ id: 'h0', header: true, label: 'Default branch' }, row(def));
    const recent = b.recent.filter((n) => n !== def);
    if (recent.length) out.push({ id: 'h1', header: true, label: 'Recent' }, ...recent.map(row));
    const rest = b.local.map((l) => l.name).filter((n) => n !== def && !recent.includes(n));
    if (rest.length) out.push({ id: 'h2', header: true, label: recent.length || def ? 'Other branches' : 'Branches' }, ...rest.map(row));
    const remote = b.remote.filter((r) => !b.local.some((l) => l.upstream === r.name || r.name.endsWith('/' + l.name)));
    if (remote.length) out.push({ id: 'h3', header: true, label: 'Remote' }, ...remote.slice(0, 50).map((r) => ({ id: 'r:' + r.name, label: r.name, desc: ago(r.at, app.now), disabled: !can })));
    const cur = b.current ?? 'HEAD';
    out.push({ id: 's', sep: true }, { id: 'new', label: 'New branch…', icon: 'plus', disabled: !can });
    if (b.current) {
      const up = st?.remote && b.default && b.default !== b.current ? `${st.remote.name}/${b.default}` : null;
      if (up && b.remote.some((r) => r.name === up)) out.push({ id: 'update', label: `Update from ${b.default}`, icon: 'sync', disabled: !can, desc: `Merge ${up} into ${cur}` });
      out.push({ id: 'merge', label: `Merge into ${cur}…`, icon: 'branch', disabled: !can }, { id: 'squash', label: `Squash and merge into ${cur}…`, icon: 'branch', disabled: !can },
        { id: 'rebase', label: `Rebase ${cur}…`, icon: 'branch', disabled: !can }, { id: 's2', sep: true },
        { id: 'rename', label: `Rename ${cur}…`, icon: 'rename', disabled: !can });
    }
    out.push({ id: 'delete', label: 'Delete a branch…', icon: 'trash', disabled: !can || b.local.length < 2 });
    return out;
  });
  function pickBranch(id: string) {
    if (!repo || !st) return;
    const anchor = branchMenu!;
    if (id.startsWith('b:')) switchTo({ branch: id.slice(2) });
    else if (id.startsWith('r:')) { const r = id.slice(2); switchTo({ branch: r.replace(/^[^/]+\//, ''), track: r }); }
    else if (id === 'new') app.ask({ title: 'New branch', label: `From ${st.branch ?? 'HEAD'}`, value: '', placeholder: 'feature/name', yes: 'Create branch', run: async (v) => {
      try { await repo!.call('git.checkout', { branch: v.trim(), create: true }); app.toast(`On ${v.trim()}`, 'success'); await repo!.load(); return null; } catch (e) { return plainError(e); }
    } });
    else if (id === 'update') void repo.run('merge', 'git.merge', { branch: `${st.remote!.name}/${repo.branches!.default}` }, `Updated from ${repo.branches!.default}`);
    else if (id === 'rename') app.ask({ title: 'Rename branch', label: 'Name', value: st.branch ?? '', yes: 'Rename', run: async (v) => {
      if (v.trim() === st!.branch) return null;
      try { await repo!.call('git.branch_rename', { from: st!.branch, to: v.trim() }); app.toast(`Renamed to ${v.trim()}`, 'success'); await repo!.load(); return null; } catch (e) { return plainError(e); }
    } });
    else if (id === 'merge' || id === 'squash' || id === 'rebase' || id === 'delete') setTimeout(() => (chooser = { kind: id, anchor }));
  }
  /** Switching branches with changes here: leave them on this branch (stashed) or bring them along. */
  let switching = $state<{ branch: string; track?: string } | null>(null);
  function switchTo(p: { branch: string; track?: string }) {
    if (!repo || p.branch === st?.branch) return;
    if (st?.files.length) { switching = p; return; }
    void repo.run('checkout', 'git.checkout', p, `On ${p.branch}`);
  }
  function switchWith(changes: 'stash' | 'bring') {
    const p = switching!;
    switching = null;
    void repo!.run('checkout', 'git.checkout', { ...p, changes }, changes === 'stash' ? `On ${p.branch}: your changes wait on ${st?.branch}` : `On ${p.branch}, with your changes`);
  }
  const chooserItems = $derived.by((): Item[] => {
    const b = repo?.branches;
    if (!b || !chooser) return [];
    const others = b.local.filter((l) => l.name !== b.current).map((l) => ({ id: l.name, label: l.name, desc: ago(l.at, app.now) }));
    const cur = b.current ?? 'HEAD';
    const title: Item = { id: 'title', header: true, label: chooser.kind === 'merge' ? `Merge into ${cur}` : chooser.kind === 'squash' ? `Squash and merge into ${cur}` : chooser.kind === 'rebase' ? `Rebase ${cur} onto` : 'Delete a branch' };
    if (chooser.kind === 'delete') return [title, ...others.map((o) => ({ ...o, icon: 'trash', danger: true }))];
    return [title, ...others, ...(b.remote.length ? [{ id: 'h', header: true, label: 'Remote' }] : []), ...b.remote.map((r) => ({ id: r.name, label: r.name }))];
  });
  function choose(name: string) {
    if (!repo || !chooser) return;
    const k = chooser.kind;
    const cur = st?.branch ?? 'HEAD';
    if (k === 'merge') void repo.run('merge', 'git.merge', { branch: name }, `Merged ${name} into ${cur}`);
    else if (k === 'squash') void repo.run('merge', 'git.merge', { branch: name, squash: true }, `Squashed ${name}: commit it to finish`);
    else if (k === 'rebase') app.confirmIt({ title: `Rebase ${cur} onto ${name}?`, body: `${cur}’s commits are replayed on top of ${name}. If it was pushed, you’ll need to force push after.`, yes: 'Rebase',
      run: () => { void repo!.run('rebase', 'git.rebase', { onto: name }, `Rebased onto ${name}`, 120_000); } });
    else if (k === 'delete') {
      const x = repo.branches?.local.find((l) => l.name === name);
      app.confirmIt({ title: `Delete ${name}?`, body: x?.upstream ? `Only here. To delete it on the remote too, delete it there (or with “git push --delete”).` : 'Its commits that no other branch has are lost.', yes: 'Delete', danger: true,
        run: () => { void repo!.run('delete', 'git.branch_delete', { branch: name }, `Deleted ${name}`); } });
    }
  }

  // ---- sheets: pull request, publish, clone
  let prSheet = $state<{ title: string; body: string; base: string; draft: boolean; busy: boolean } | null>(null);
  async function openPr() {
    if (!repo || !st) return;
    const b = repo.branches ?? await repo.loadBranches();
    const head = repo.head;
    prSheet = { title: head && head.local !== undefined ? head.subject : st.branch ?? '', body: head?.body ?? '', base: repo.gh?.defaultBranch ?? b.default ?? 'main', draft: false, busy: false };
  }
  async function createPr() {
    if (!prSheet || !repo) return;
    prSheet.busy = true;
    try {
      const r = await repo.call<{ url: string; number: number | null; existed?: boolean }>('gh.create', { title: prSheet.title, body: prSheet.body, base: prSheet.base, draft: prSheet.draft }, 115_000);
      app.toast(r.existed ? `It already has #${r.number}` : `Opened #${r.number}`, 'success', { label: 'Open', run: () => openWeb(r.url) });
      prSheet = null;
      repo.pull = undefined;
      await repo.load();
    } catch (e) { app.toast(plainError(e), 'warning'); if (prSheet) prSheet.busy = false; }
  }
  let pubSheet = $state<{ name: string; private: boolean; description: string; busy: boolean } | null>(null);
  function openPublish() { pubSheet = { name: baseName(st?.root ?? dir ?? 'repository'), private: true, description: '', busy: false }; }
  async function publish() {
    if (!pubSheet || !repo) return;
    pubSheet.busy = true;
    try {
      const r = await repo.call<{ url: string | null }>('gh.publish', { name: pubSheet.name.trim(), private: pubSheet.private, description: pubSheet.description }, 115_000);
      app.toast('Published on GitHub', 'success', r.url ? { label: 'Open', run: () => openWeb(r.url!) } : undefined);
      pubSheet = null;
      repo.gh = undefined;
      await repo.load();
    } catch (e) { app.toast(plainError(e), 'warning'); if (pubSheet) pubSheet.busy = false; }
  }
  function clone() {
    const into = st?.root ? st.root.replace(/\/[^/]+$/, '') : dir!;
    app.ask({ title: 'Clone a repository', label: `Into ${tilde(into, conn.info?.home)}`, value: '', placeholder: 'https://github.com/owner/repo', yes: 'Clone', run: async (v) => {
      try {
        const r = await conn.call<{ path: string }>('git.clone', { cwd: into, url: v.trim() }, 118_000);
        app.toast(`Cloned into ${tilde(r.path, conn.info?.home)}`, 'success');
        chosen = r.path;
        return null;
      } catch (e) { return plainError(e); }
    } });
  }
  async function init() {
    if (!dir) return;
    if (await app.act(() => conn.call('git.init', { cwd: dir }), 'Made a repository')) void repo?.load();
  }
</script>

<div class="head">
  {#if st}
    <button class="branch" disabled={!conn.online} onclick={(e) => openBranches(e.currentTarget as HTMLElement)} {@attach tip('Current branch')}>
      <Icon name="branch" size={16} /><span class="mono cut">{st.branch ?? (st.head ? `${st.head.slice(0, 7)} (detached)` : 'no commits')}</span><Icon name="chevd" size={14} />
    </button>
  {:else}
    <button class="branch" disabled={!conn.online} onclick={() => { pickValue = dir ?? ''; picking = true; }}><Icon name="folder" size={16} /><span class="cut">{dir ? baseName(dir) : 'Choose a folder'}</span><Icon name="chevd" size={14} /></button>
  {/if}
  <span class="sp"></span>
  {#if st && sync}
    <span {@attach tip(can ? sync.tip : why)}>
      <Button size="sm" variant="quiet" icon={sync.icon} disabled={!can || !!repo?.busy} busy={repo?.busy === 'sync'} onclick={() => doSync(sync.id)}>{sync.label}{#if sync.count}<span class="count">{sync.count}</span>{/if}</Button>
    </span>
  {/if}
  <Button icon="more" variant="icon" size="sm" tip="More" on={!!more} onclick={(e) => (more = more ? null : (e.currentTarget as HTMLElement))} />
</div>

{#if !conn.online}<div class="body"><EmptyState compact icon="diff" text="The computer is offline" /></div>
{:else if !dir}
  <div class="body"><EmptyState compact icon="diff" text="Open a session, or choose a folder" action={{ label: 'Choose a folder', primary: false, run: () => { pickValue = ''; picking = true; } }} /></div>
{:else if !repo || st === undefined}<div class="body"><CardLoad error={repo?.error ?? null} retry={() => repo?.load()} /></div>
{:else if st === null}
  <div class="body">
    <EmptyState compact icon="branch" text="Not a git repository" tip={tilde(dir, conn.info?.home)}>
      <div class="twin">
        <Button size="sm" disabled={!can} onclick={init}>Create a repository here</Button>
        <Button size="sm" variant="quiet" disabled={!can} onclick={clone}>Clone one…</Button>
      </div>
    </EmptyState>
  </div>
{:else}
  <div class="tools">
    <SegmentedControl size="sm" label="View" value={tab} onchange={(v) => (tab = v as typeof tab)}
      options={[{ id: 'changes', label: 'Changes', count: st.files.length || undefined }, { id: 'history', label: 'History' }, ...(st.remote?.github ? [{ id: 'pulls', label: 'Pull requests' }] : [])]} />
    <span class="sp"></span>
    {#if repo.hideSpace}<span class="flag" {@attach tip('Whitespace changes are hidden')}>¶</span>{/if}
    <SegmentedControl size="sm" label="Layout" value={mode} onchange={(v) => (mode = v as typeof mode)} options={[{ id: 'unified', label: '', icon: 'panel', tip: 'Unified' }, { id: 'split', label: '', icon: 'splitcols', tip: 'Split' }]} />
    <Button icon="wave" variant="icon" size="sm" on={wrap} tip={wrap ? 'Don’t wrap lines' : 'Wrap lines'} onclick={() => (wrap = !wrap)} />
  </div>
  {#if tab === 'changes'}<ChangesTab {repo} {mode} {wrap} oncreatepr={openPr} onsync={() => sync && doSync(sync.id)} />
  {:else if tab === 'history'}<HistoryTab {repo} {mode} {wrap} onchanges={() => (tab = 'changes')} />
  {:else}<PullsTab {repo} {mode} {wrap} onchanges={() => (tab = 'changes')} />{/if}
{/if}

{#if branchMenu}<Menu anchor={branchMenu} width={300} items={branchItems} search={((repo?.branches?.local.length ?? 0) + (repo?.branches?.remote.length ?? 0) > 8) ? 'Filter branches' : false} onpick={pickBranch} onclose={() => (branchMenu = null)} label="Branches" />{/if}
{#if chooser}
  <Menu anchor={chooser.anchor} width={300} items={chooserItems} search="Filter branches" empty="No other branches" onpick={choose} onclose={() => (chooser = null)}
    label={chooser.kind === 'merge' ? `Merge into ${st?.branch}` : chooser.kind === 'squash' ? `Squash and merge into ${st?.branch}` : chooser.kind === 'rebase' ? `Rebase ${st?.branch} onto` : 'Delete a branch'} />
{/if}
{#if more}<Menu anchor={more} end width={260} items={moreItems} onpick={pickMore} onclose={() => (more = null)} label="Git" />{/if}

{#if switching}
  <Sheet title="Switch to {switching.branch}" width={460} onclose={() => (switching = null)}>
    <p class="lead">You have changes on {st?.branch ?? 'this branch'}.</p>
    <div class="choices">
      <button class="choice" onclick={() => switchWith('stash')}><Icon name="download" size={18} /><span><b>Leave my changes on {st?.branch}</b><span>They’re stashed, and wait for you there.</span></span></button>
      <button class="choice" onclick={() => switchWith('bring')}><Icon name="arrowr" size={18} /><span><b>Bring my changes to {switching.branch}</b><span>They come along, if they don’t clash with it.</span></span></button>
    </div>
    {#snippet footer()}<span class="sp"></span><Button onclick={() => (switching = null)}>Cancel</Button>{/snippet}
  </Sheet>
{/if}

{#if prSheet}
  <Sheet title="Create a pull request" width={560} onclose={() => (prSheet = null)}>
    <div class="form">
      <label class="lab">Title<input class="field" bind:value={prSheet.title} placeholder="What it does" /></label>
      <label class="lab">Description<textarea class="field ta" rows="6" bind:value={prSheet.body} placeholder="Why, and how to try it"></textarea></label>
      <div class="row2">
        <label class="lab grow">Into<input class="field mono" bind:value={prSheet.base} /></label>
        <label class="lab sw"><span>Draft</span><Switch on={prSheet.draft} label="Draft" onchange={(v) => (prSheet!.draft = v)} /></label>
      </div>
      <p class="hint">From <span class="mono">{st?.branch}</span>{#if !st?.upstream || st?.ahead} (pushed first){/if}, on GitHub with the computer’s gh sign-in.</p>
    </div>
    {#snippet footer()}
      <span class="sp"></span>
      <Button onclick={() => (prSheet = null)}>Cancel</Button>
      <Button variant="primary" disabled={!prSheet?.title.trim() || prSheet?.busy} busy={prSheet?.busy} onclick={createPr}>Create pull request</Button>
    {/snippet}
  </Sheet>
{/if}

{#if pubSheet}
  <Sheet title="Publish to GitHub" width={500} onclose={() => (pubSheet = null)}>
    <div class="form">
      <label class="lab">Name<input class="field mono" bind:value={pubSheet.name} placeholder="repository or org/repository" /></label>
      <label class="lab">Description<input class="field" bind:value={pubSheet.description} placeholder="Optional" /></label>
      <label class="lab sw"><span>Keep it private</span><Switch on={pubSheet.private} label="Private" onchange={(v) => (pubSheet!.private = v)} /></label>
      <p class="hint">A new repository under the computer’s gh account, with this one pushed to it as origin.</p>
    </div>
    {#snippet footer()}
      <span class="sp"></span>
      <Button onclick={() => (pubSheet = null)}>Cancel</Button>
      <Button variant="primary" disabled={!pubSheet?.name.trim() || pubSheet?.busy} busy={pubSheet?.busy} onclick={publish}>Publish</Button>
    {/snippet}
  </Sheet>
{/if}

{#if picking}
  <Sheet title="Choose a folder" width={520} onclose={() => (picking = false)}>
    <FolderPicker {conn} bind:value={pickValue} height={300} />
    {#snippet footer()}
      <span class="sp"></span>
      <Button onclick={() => (picking = false)}>Cancel</Button>
      <Button variant="primary" disabled={!pickValue} onclick={() => { chosen = pickValue; picking = false; }}>Open</Button>
    {/snippet}
  </Sheet>
{/if}

<style>
  .head { display: flex; align-items: center; gap: var(--sp-1); height: var(--card-head); padding: 0 calc(var(--gutter) - var(--sp-1h)); flex: none; box-shadow: inset 0 calc(-1 * var(--hairline)) 0 var(--hair); }
  .branch { display: inline-flex; align-items: center; gap: var(--sp-1h); height: 28px; padding: 0 var(--sp-2); border-radius: var(--r-md); color: var(--ink); font-weight: var(--w-control); min-width: 0; max-width: 50%; }
  .branch:hover { background: var(--hover); }
  .branch :global(svg) { color: var(--muted); flex: none; }
  .branch span { white-space: nowrap; overflow: hidden; font-size: 13px; }
  .count { margin-left: var(--sp-1); color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12px; }
  .sp { flex: 1; }
  .body { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: var(--sp-2) var(--gutter) var(--gutter); }
  .tools { display: flex; align-items: center; gap: var(--sp-1); padding: var(--sp-2) var(--gutter) 0; flex: none; }
  .flag { color: var(--muted); font-size: 13px; padding: 0 var(--sp-1); }
  .twin { display: flex; gap: var(--sp-1); justify-content: center; }
  .lead { margin: 0 0 var(--sp-3); color: var(--ink2); font-size: var(--fs-quiet); }
  .choices { display: flex; flex-direction: column; gap: var(--sp-2); }
  .choice { display: flex; align-items: flex-start; gap: var(--sp-3); padding: var(--sp-3); border-radius: var(--r-md); background: var(--tint); box-shadow: inset 0 0 0 var(--hairline) var(--hair); text-align: left; }
  .choice:hover { background: var(--hover); box-shadow: inset 0 0 0 1px var(--accent); }
  .choice :global(svg) { color: var(--muted); flex: none; margin-top: 1px; }
  .choice > span { display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-small); color: var(--muted); }
  .choice b { color: var(--ink); font-weight: var(--w-control); font-size: var(--fs-quiet); }
  .form { display: flex; flex-direction: column; gap: var(--sp-3); }
  .lab { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-small); color: var(--muted); }
  .lab.sw { flex-direction: row; align-items: center; justify-content: space-between; gap: var(--sp-3); color: var(--ink2); font-size: var(--fs-quiet); }
  .row2 { display: flex; align-items: flex-end; gap: var(--sp-3); }
  .grow { flex: 1; min-width: 0; }
  .ta { height: auto; padding-top: var(--sp-2); resize: vertical; min-height: 96px; }
  .hint { margin: 0; color: var(--muted); font-size: var(--fs-small); }
</style>
