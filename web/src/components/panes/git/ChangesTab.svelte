<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The Changes tab, GitHub Desktop's: every changed file with its checkbox (all of it in the next commit to start
  // with), opening to its diff since the last commit, where lines are picked one by one; a merge, rebase or pick
  // stopped for conflicts on top, with each conflicted file's way out; changes stashed on this branch; the branch's
  // pull request; then the commit box: a summary and a description, Commit N files to the branch, the last commit
  // with Undo while it isn't pushed.
  import { untrack } from 'svelte';
  import type { GitFile, GitStash } from '@coderail/protocol';
  import type { GitRepo } from '../../../lib/git.svelte';
  import { kindOf, openWeb } from '../../../lib/git.svelte';
  import { app, copyText } from '../../../lib/app.svelte';
  import { plainError } from '../../../lib/api';
  import { edges } from '../../../lib/edges';
  import { ago } from '../../../lib/format';
  import { baseName } from '../../../lib/machineText';
  import { parseUnified, extOf, type FileDiff } from '../../../lib/diffs';
  import { slideOpen } from '../../../lib/slide';
  import { tip } from '../../../lib/tip';
  import Icon from '../../Icon.svelte';
  import PathLabel from '../../PathLabel.svelte';
  import DiffView from '../../DiffView.svelte';
  import Button from '../../ui/Button.svelte';
  import Check from '../../ui/Check.svelte';
  import Menu, { type Item } from '../../ui/Menu.svelte';
  import EmptyState from '../../ui/EmptyState.svelte';
  import ChecksBadge from './ChecksBadge.svelte';
  let { repo, mode, wrap, oncreatepr, onsync }: { repo: GitRepo; mode: 'unified' | 'split'; wrap: boolean; oncreatepr: () => void; onsync: () => void } = $props();
  const st = $derived(repo.st!);
  const files = $derived(st.files);
  let open = $state<Record<string, boolean>>({});
  let menu = $state<{ f: GitFile; anchor?: HTMLElement; x?: number; y?: number } | null>(null);
  let summary = $state('');
  let description = $state('');
  let amend = $state(false);
  let noVerify = $state(false);
  let opts = $state<HTMLElement | null>(null);

  // (Read again after any change: the open files' diffs come again too.)
  $effect(() => { void repo.st; untrack(() => { for (const f of files) if (open[f.path]) void repo.loadDiff(f); }); });
  // (Whitespace hidden or shown: the diffs are other diffs.)
  let spaced: boolean | null = null;
  $effect(() => { const h = repo.hideSpace; if (spaced === null) spaced = h; else if (h !== spaced) { spaced = h; untrack(() => { repo.diffs = {}; for (const f of files) if (open[f.path]) void repo.loadDiff(f); }); } });
  $effect(() => { if (repo.restored !== null) { const [s, ...rest] = repo.restored.split('\n'); summary = s; description = rest.join('\n').trim(); repo.restored = null; } });

  function toggle(f: GitFile) {
    const o = { ...open };
    if (o[f.path]) delete o[f.path]; else { o[f.path] = true; if (!repo.diffs[f.path]) void repo.loadDiff(f); }
    open = o;
  }
  const allState = $derived(files.every((f) => repo.state(f.path) === 'all') ? 'all' : files.every((f) => repo.state(f.path) === 'none') ? 'none' : 'some');
  const conflicted = $derived(files.filter((f) => f.conflicted));
  const left = $derived(conflicted.reduce((n, f) => n + Math.ceil((f.markers ?? 0) / 3), 0));
  const op = $derived(st.operation ?? null);
  const OP: Record<string, string> = { merge: 'Merging', rebase: 'Rebasing', 'cherry-pick': 'Cherry-picking', revert: 'Reverting', squash: 'Squash merge' };
  /** Whose version "ours" and "theirs" are, named. (In a rebase they're the other way round.) */
  const sides = $derived(op?.kind === 'rebase' ? { ours: 'the base', theirs: op.target ?? 'yours' } : { ours: st.branch ?? 'yours', theirs: op?.target ?? 'theirs' });
  const myStashes = $derived(repo.stashes.filter((s) => s.branch === st.branch));

  // ---- one file's menu
  function items(f: GitFile): Item[] {
    const ext = extOf(f.path);
    const out: Item[] = [];
    if (f.conflicted) {
      out.push({ id: 'ours', label: `Use ${sides.ours}’s version`, icon: 'branch', disabled: !repo.can }, { id: 'theirs', label: `Use ${sides.theirs}’s version`, icon: 'branch', disabled: !repo.can },
        { id: 'mark', label: 'Mark as resolved', icon: 'success', disabled: !repo.can || (f.markers ?? 0) > 0, tip: (f.markers ?? 0) > 0 ? 'It still has conflict markers' : undefined }, { id: 's0', sep: true });
    }
    out.push({ id: 'discard', label: 'Discard changes…', icon: 'restore', danger: true, disabled: !repo.can });
    if (f.untracked) {
      out.push({ id: 'ignore', label: 'Ignore file', icon: 'eyeoff', disabled: !repo.can });
      if (ext && ext !== f.path.toLowerCase()) out.push({ id: 'ignoreext', label: `Ignore all .${ext} files`, icon: 'eyeoff', disabled: !repo.can });
    }
    out.push({ id: 's1', sep: true }, { id: 'stash', label: 'Stash this file', icon: 'download', disabled: !repo.can || !!op }, { id: 'copy', label: 'Copy path', icon: 'copy' });
    if (st.remote?.web && st.branch && !f.untracked) out.push({ id: 'web', label: 'View on the web', icon: 'ext' });
    return out;
  }
  function pick(id: string, f: GitFile) {
    if (id === 'discard') discard([f]);
    else if (id === 'ignore') void repo.run('ignore', 'git.ignore', { pattern: '/' + f.path }, `Ignoring ${baseName(f.path)}`);
    else if (id === 'ignoreext') void repo.run('ignore', 'git.ignore', { pattern: '*.' + extOf(f.path) }, `Ignoring .${extOf(f.path)} files`);
    else if (id === 'stash') void repo.run('stash', 'git.stash', { paths: [f.path], message: `${baseName(f.path)} on ${st.branch ?? 'HEAD'}` }, 'Stashed');
    else if (id === 'copy') copyText(f.path, 'Path copied');
    else if (id === 'web' && st.remote?.web) openWeb(`${st.remote.web}/blob/${encodeURIComponent(st.branch!)}/${f.path.split('/').map(encodeURIComponent).join('/')}`);
    else if (id === 'ours' || id === 'theirs' || id === 'mark') void repo.run('resolve', 'git.resolve', { path: f.path, side: id }, id === 'mark' ? 'Marked as resolved' : `Took ${id === 'ours' ? sides.ours : sides.theirs}’s version`);
  }
  function discard(fs: GitFile[]) {
    const n = fs.length;
    app.confirmIt({
      title: n === 1 ? `Discard changes to ${baseName(fs[0].path)}?` : `Discard changes to ${n} files?`,
      body: fs.some((f) => f.untracked || f.index === 'A') ? 'New files are deleted. This can’t be undone.' : 'They go back to the last commit. This can’t be undone.',
      yes: 'Discard', danger: true,
      run: () => { void repo.run('discard', 'git.discard', { paths: fs.map((f) => f.path) }, n === 1 ? 'Discarded' : `Discarded ${n} files`); },
    });
  }
  /** Takes back the lines picked in a file (only those). */
  function discardPicked(f: GitFile) {
    const d = repo.diffs[f.path];
    const l = repo.lines[f.path];
    if (!d || d === 'loading' || 'error' in d || !l) return;
    const n = l.on.size;
    app.confirmIt({ title: `Discard ${n} picked line${n === 1 ? '' : 's'}?`, body: `In ${baseName(f.path)}. The rest of its changes stay. This can’t be undone.`, yes: 'Discard lines', danger: true,
      run: () => { const keys = [...l.on]; void repo.run('discard', 'git.discard_lines', { lines: { path: f.path, hash: l.hash, dels: keys.filter((k) => k[0] === 'd').map((k) => +k.slice(1)), adds: keys.filter((k) => k[0] === 'a').map((k) => +k.slice(1)) } }, 'Discarded those lines').then(() => repo.setFile(f.path, true)); } });
  }

  // ---- the commit box
  const picked = $derived(repo.picked);
  const one = $derived(picked === 1 ? files.find((f) => repo.state(f.path) !== 'none') : null);
  const placeholder = $derived(one ? `${kindOf(one).letter === 'A' ? 'Create' : kindOf(one).letter === 'D' ? 'Delete' : 'Update'} ${baseName(one.path)}` : 'Summary (required)');
  const message = $derived([(summary.trim() || (one ? placeholder : '')), description.trim()].filter(Boolean).join('\n\n'));
  const midMerge = $derived(op && (op.kind === 'merge' || op.kind === 'squash'));
  const goOn = $derived(op && !midMerge);
  const ready = $derived(repo.can && !repo.busy && (goOn ? left === 0 : midMerge ? left === 0 : (amend || (picked > 0 && !!message.trim()))));
  const label = $derived(goOn ? `Continue ${op!.kind === 'rebase' ? 'rebase' : op!.kind}` : midMerge ? 'Commit merge' : amend ? 'Amend last commit' : `Commit ${picked ? `${picked} file${picked === 1 ? '' : 's'} ` : ''}to ${st.branch ?? 'HEAD'}`);
  $effect(() => { if (midMerge && op?.message && !summary && !description) { const [s, ...rest] = op.message.split('\n'); summary = s; description = rest.join('\n').trim(); } });

  async function commit() {
    if (!ready) return;
    if (goOn) { await repo.run('commit', 'git.continue', {}, (r: any) => (r?.conflicts ? null : 'Continued')); return; }
    const r = await repo.run<{ hash: string }>('commit', 'git.commit', { message, amend, picks: repo.picks(), noVerify }, (r) => `${amend ? 'Amended' : 'Committed'} ${r?.hash?.slice(0, 7) ?? ''}`, 120_000);
    if (r) { summary = ''; description = ''; amend = false; repo.clearPicks(); open = {}; }
  }
  function setAmend(on: boolean) {
    amend = on;
    if (on && !summary && !description && repo.head) { summary = repo.head.subject; description = repo.head.body ?? ''; }
  }
  $effect(() => { if (repo.amendNow && repo.head) untrack(() => { repo.amendNow = false; setAmend(true); }); });
  async function undo() {
    const r = await repo.run<{ message: string }>('undo', 'git.undo', {}, 'Undone: its changes are back');
    if (r) { repo.restored = r.message; }
  }

  // ---- stashes
  let stashOpen = $state<string | null>(null);
  let stashFiles = $state<FileDiff[] | 'loading'>('loading');
  let stashFile = $state<Record<string, boolean>>({});
  async function viewStash(s: GitStash) {
    if (stashOpen === s.ref) { stashOpen = null; return; }
    stashOpen = s.ref; stashFiles = 'loading'; stashFile = {};
    try { stashFiles = parseUnified((await repo.call<{ diff: string }>('git.diff', { stash: s.ref })).diff); } catch (e) { app.toast(plainError(e), 'warning'); stashFiles = []; }
  }
  function dropStash(s: GitStash) {
    app.confirmIt({ title: 'Discard the stashed changes?', body: s.message + '. This can’t be undone.', yes: 'Discard', danger: true, run: () => { void repo.run('stash', 'git.stash_drop', { ref: s.ref }, 'Stash discarded'); } });
  }

  // ---- pictures: before and after, side by side
  const IMG = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
  let pics = $state<Record<string, { before: string | null; after: string | null } | 'loading'>>({});
  async function loadPics(f: GitFile) {
    if (pics[f.path]) return;
    pics = { ...pics, [f.path]: 'loading' };
    const mime = f.path.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : 'image/' + extOf(f.path).replace('jpg', 'jpeg');
    const before = f.untracked || f.index === 'A' || st.unborn ? null : await repo.call<{ content: string }>('git.file', { path: f.orig ?? f.path, rev: 'HEAD', encoding: 'base64' }).then((r) => (r.content ? `data:${mime};base64,${r.content}` : null)).catch(() => null);
    const after = kindOf(f).letter === 'D' ? null : await repo.conn.call<{ content: string; encoding: string }>('fs.read', { path: `${st.root}/${f.path}` })
      .then((r) => (r.encoding === 'base64' ? `data:${mime};base64,${r.content}` : `data:${mime};charset=utf-8,${encodeURIComponent(r.content)}`)).catch(() => null);
    pics = { ...pics, [f.path]: { before, after } };
  }
  $effect(() => {
    for (const f of files) {
      const d = repo.diffs[f.path];
      if (open[f.path] && d && d !== 'loading' && !('error' in d) && d.binary && IMG.test(f.path)) untrack(() => loadPics(f));
    }
  });
  // (The pictures are read again after a change.)
  $effect(() => { void repo.st; untrack(() => { pics = {}; }); });
</script>

{#snippet diffBody(f: GitFile)}
  {@const d = repo.diffs[f.path]}
  {@const canPick = repo.canPick(f)}
  <div class="dbody" transition:slideOpen>
    {#if !d || d === 'loading'}<div class="reading"><span class="spinner"></span>Reading…</div>
    {:else if 'error' in d}<div class="note">{d.error}</div>
    {:else}
      {#if d.binary && IMG.test(f.path)}
        {@const p = pics[f.path]}
        {#if !p || p === 'loading'}<div class="reading"><span class="spinner"></span>Reading…</div>
        {:else}
          <div class="pics">
            <figure><figcaption>Before</figcaption>{#if p.before}<img src={p.before} alt="Before" />{:else}<span class="none">None</span>{/if}</figure>
            <figure><figcaption>After</figcaption>{#if p.after}<img src={p.after} alt="After" />{:else}<span class="none">Deleted</span>{/if}</figure>
          </div>
        {/if}
      {:else if d.binary}<div class="note">Binary file.</div>
      {:else if !d.lines.length}<div class="note">{repo.hideSpace ? 'Only whitespace changed.' : f.orig ? 'Renamed, with no other change.' : 'No lines changed.'}</div>{/if}
      {#if d.truncated}<div class="note">Long diff: first part only, and its lines can’t be picked one by one.</div>{/if}
      {#if d.lines.length}
        {#if canPick}
          {@const s = repo.state(f.path)}
          <!-- (Always there, so picking the first line moves nothing under the pointer.) -->
          <div class="pickbar">
            <span class="cut">{s === 'some' ? `${repo.lines[f.path]?.on.size} of ${repo.lines[f.path]?.total} changed lines picked` : s === 'none' ? 'Left out of the commit' : 'Click a line number to leave that line out'}</span><span class="sp"></span>
            {#if s !== 'all'}<Button size="xs" variant="quiet" onclick={() => repo.setFile(f.path, true)}>Pick all</Button>{/if}
            {#if s === 'some'}<Button size="xs" variant="quiet" disabled={!repo.can} onclick={() => discardPicked(f)}>Discard picked…</Button>{/if}
          </div>
        {/if}
        <DiffView lines={d.lines} lang={extOf(f.path)} {mode} {wrap}
          pick={canPick ? { has: (l) => repo.has(f.path, l), set: (ls, on) => repo.pick(f.path, ls, on) } : undefined} />
      {/if}
    {/if}
  </div>
{/snippet}

<div class="body scroll" {@attach edges()}>
  {#if op}
    <div class="banner" class:warn={left > 0}>
      <Icon name={left ? 'warning' : 'success'} size={16} />
      <div class="bt">
        <b>{OP[op.kind]}{op.target ? ` ${op.target}` : ''}{op.step && op.total ? ` (${op.step} of ${op.total})` : ''}</b>
        <span>{left ? `${left} conflict${left === 1 ? '' : 's'} in ${conflicted.length} file${conflicted.length === 1 ? '' : 's'}: resolve them, then continue.` : conflicted.length ? 'All conflicts resolved. Continue when ready.' : op.kind === 'squash' ? 'The squashed changes are ready to commit.' : 'Continue when ready.'}</span>
      </div>
      <Button size="sm" variant="quiet" disabled={!repo.can || !!repo.busy} onclick={() => app.confirmIt({ title: `Abort the ${op.kind}?`, body: 'Everything goes back to how it was before it started.', yes: 'Abort', danger: true, run: () => { void repo.run('abort', 'git.abort', {}, 'Aborted'); } })}>Abort</Button>
    </div>
  {/if}

  {#if repo.pull}
    {@const pr = repo.pull}
    <button class="pr" onclick={() => openWeb(pr.url)} {@attach tip('Open on GitHub')}>
      <Icon name="branch" size={15} /><span class="cut"><span class="num">#{pr.number}</span> {pr.title}</span><span class="sp"></span>
      {#if pr.draft}<span class="chip">Draft</span>{/if}<ChecksBadge checks={pr.checks} /><Icon name="ext" size={14} />
    </button>
  {:else if repo.gh?.gh === 'ok' && st.branch && st.upstream && !st.upstreamGone && st.branch !== (repo.gh.defaultBranch ?? st.defaultBranch) && repo.pull === null}
    <div class="pr quiet"><Icon name="branch" size={15} /><span class="cut">No pull request for {st.branch}</span><span class="sp"></span>
      <Button size="xs" variant="quiet" disabled={!repo.can} onclick={oncreatepr}>Create pull request</Button></div>
  {/if}

  {#each myStashes as s (s.ref)}
    <div class="stash">
      <button class="file" onclick={() => viewStash(s)} aria-expanded={stashOpen === s.ref}>
        <span class="chev" class:on={stashOpen === s.ref}><Icon name="chevr" size={12} /></span><Icon name="download" size={15} />
        <span class="cut">Stashed changes <span class="faint">· {ago(s.at, app.now)}</span></span>
      </button>
      <Button size="xs" variant="quiet" disabled={!repo.can || !!repo.busy || files.length > 0} tip={files.length ? 'Commit or discard your changes first' : 'Bring them back'} onclick={() => repo.run('stash', 'git.stash_apply', { ref: s.ref, drop: true }, 'Restored')}>Restore</Button>
      <Button icon="trash" variant="icon" size="xs" tip="Discard" disabled={!repo.can || !!repo.busy} onclick={() => dropStash(s)} />
    </div>
    {#if stashOpen === s.ref}
      <div class="cfiles" transition:slideOpen>
        {#if stashFiles === 'loading'}<div class="reading"><span class="spinner"></span>Reading…</div>
        {:else}{#each stashFiles as d (d.path)}
          <button class="file sub" onclick={() => (stashFile = { ...stashFile, [d.path]: !stashFile[d.path] })}><span class="chev" class:on={stashFile[d.path]}><Icon name="chevr" size={12} /></span><span class="path"><PathLabel path={d.path} split /></span><span class="counts"><span class="add">+{d.added}</span><span class="del">−{d.removed}</span></span></button>
          {#if stashFile[d.path]}<div class="dbody" transition:slideOpen><DiffView lines={d.lines} lang={extOf(d.path)} {mode} {wrap} /></div>{/if}
        {/each}{/if}
      </div>
    {/if}
  {/each}

  {#if !files.length}
    <div class="clean">
      <EmptyState compact icon="success" text="No local changes" fill={false} tip="Nothing has changed since the last commit" />
      {#if st.remote && (st.ahead || !st.upstream || st.upstreamGone || st.behind)}
        <button class="suggest" disabled={!repo.can} onclick={onsync}>
          <Icon name={st.behind ? 'arrowr' : 'upload'} size={16} />
          <span><b>{!st.upstream || st.upstreamGone ? 'Publish your branch' : st.behind ? `Pull ${st.behind} commit${st.behind === 1 ? '' : 's'}` : `Push ${st.ahead} commit${st.ahead === 1 ? '' : 's'}`}</b>
            <span>{!st.upstream || st.upstreamGone ? `${st.branch} isn’t on ${st.remote.name} yet` : st.behind ? `${st.remote.name} has commits you don’t have` : `to ${st.upstream}`}</span></span>
        </button>
      {/if}
      {#if repo.gh?.gh === 'ok' && st.branch && st.branch !== (repo.gh.defaultBranch ?? st.defaultBranch) && repo.pull === null && !st.unborn}
        <button class="suggest" disabled={!repo.can} onclick={oncreatepr}><Icon name="branch" size={16} /><span><b>Create a pull request</b><span>from {st.branch} on GitHub</span></span></button>
      {/if}
    </div>
  {:else}
    <div class="sec">
      <Check state={allState} label="Pick all files" disabled={!repo.can || !!op} onchange={(on) => repo.setAll(on)} />
      <span>{files.length} changed file{files.length === 1 ? '' : 's'}{#if picked !== files.length}<span class="faint"> · {picked} picked</span>{/if}</span>
      <span class="sp"></span>
      <Button size="xs" variant="quiet" disabled={!repo.can || !!repo.busy} onclick={() => discard(files)}>Discard all…</Button>
      <Button size="xs" variant="quiet" disabled={!repo.can || !!repo.busy || !!op} tip="Put them away for later" onclick={() => repo.run('stash', 'git.stash', {}, 'Stashed')}>Stash all</Button>
    </div>
    <div class="list">
      {#each files as f (f.path)}
        {@const k = kindOf(f)}
        <div class="frow" class:open={open[f.path]} class:menu={menu?.f === f} oncontextmenu={(e) => { e.preventDefault(); menu = { f, x: e.clientX, y: e.clientY }; }} role="group">
          <span class="ck"><Check state={repo.state(f.path)} label="Commit {f.path}" disabled={!repo.can || (!!op && !midMerge)} onchange={(on) => repo.setFile(f.path, on)} /></span>
          <button class="file" onclick={() => toggle(f)} aria-expanded={!!open[f.path]}>
            <span class="chev" class:on={open[f.path]}><Icon name="chevr" size={12} /></span>
            <span class="path">{#if f.orig}<PathLabel path={f.orig} split /><span class="faint"> → </span>{/if}<PathLabel path={f.path} split /></span>
            {#if f.conflicted}<span class="chip warn">{(f.markers ?? 0) > 0 ? `${Math.ceil((f.markers ?? 0) / 3)} conflict${Math.ceil((f.markers ?? 0) / 3) === 1 ? '' : 's'}` : 'Resolved'}</span>
            {:else if f.added != null && (f.added || f.removed)}<span class="counts"><span class="add">+{f.added}</span><span class="del">−{f.removed}</span></span>{/if}
            <span class="st st-{k.letter}" {@attach tip(k.word, { placement: 'left' })}>{k.letter === '!' ? '!' : k.letter}</span>
          </button>
          <span class="acts">
            {#if f.conflicted && (f.markers ?? 0) === 0}<Button icon="check" variant="icon" size="xs" tip="Mark as resolved" disabled={!repo.can} onclick={() => pick('mark', f)} />{/if}
            <Button icon="more" variant="icon" size="xs" tip="More" on={menu?.f === f} onclick={(e) => (menu = { f, anchor: e.currentTarget as HTMLElement })} />
          </span>
        </div>
        {#if open[f.path]}{@render diffBody(f)}{/if}
      {/each}
    </div>
  {/if}
</div>

{#if repo.conn.online}
  <div class="foot" data-card-foot>
    {#if !goOn}
      <input class="field sum" placeholder={midMerge ? 'Merge message' : placeholder} bind:value={summary} disabled={!repo.can} aria-label="Summary"
        onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void commit(); } }} />
      <textarea class="field desc" rows="2" placeholder="Description" bind:value={description} disabled={!repo.can} aria-label="Description"
        onkeydown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void commit(); } }}></textarea>
    {/if}
    <div class="crow">
      <span class="cbtn" {@attach tip(!repo.can ? repo.why : goOn && left ? 'Resolve the conflicts first' : !amend && !goOn && !midMerge && !picked ? 'Pick files to commit' : !amend && !goOn && !message.trim() ? 'Write a summary' : '⌘⏎')}>
        <Button size="sm" variant="primary" block disabled={!ready} busy={repo.busy === 'commit'} onclick={commit}>{label}</Button>
      </span>
      {#if !op}<Button icon="more" variant="icon" size="sm" tip="Commit options" on={!!opts || amend || noVerify} onclick={(e) => (opts = opts ? null : (e.currentTarget as HTMLElement))} />{/if}
    </div>
    {#if amend || noVerify}<div class="flags">{#if amend}<span class="chip">Amending {repo.head?.short}</span>{/if}{#if noVerify}<span class="chip">Skipping hooks</span>{/if}</div>{/if}
    {#if repo.head?.local && !op && !amend}
      <div class="last">
        <span class="cut">Committed {ago(repo.head.at, app.now)}: <span class="ink">{repo.head.subject}</span></span>
        <Button size="xs" variant="quiet" disabled={!repo.can || !!repo.busy || (repo.head.parents?.length ?? 0) > 1} onclick={undo}>Undo</Button>
      </div>
    {/if}
  </div>
{/if}

{#each menu ? [menu] : [] as m (m)}
  <Menu anchor={m.anchor} x={m.x} y={m.y} end={!!m.anchor} width={250} items={items(m.f)} onpick={(id) => pick(id, m.f)} onclose={() => (menu = null)} />
{/each}
{#if opts}
  <Menu anchor={opts} end up width={240} onpick={(id) => { if (id === 'amend') setAmend(!amend); else if (id === 'hooks') noVerify = !noVerify; }} onclose={() => (opts = null)}
    items={[{ id: 'amend', label: 'Amend last commit', on: amend, disabled: !repo.head || st.unborn, desc: repo.head && !repo.head.local ? 'It’s pushed: you’ll need to force push' : undefined },
      { id: 'hooks', label: 'Skip commit hooks', on: noVerify, disabled: !repo.everywhere, desc: 'git commit --no-verify' }]} />
{/if}

<style>
  .sp { flex: 1; }
  .faint { color: var(--faint); }
  .ink { color: var(--ink2); }
  .body { flex: 1; min-height: 0; padding: var(--sp-2) var(--gutter) var(--gutter); display: flex; flex-direction: column; gap: var(--sp-2); }
  .body > :global(*) { flex-shrink: 0; }
  .banner { display: flex; align-items: flex-start; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); background: var(--accent-tint); box-shadow: inset 0 0 0 var(--hairline) var(--hair); color: var(--ink); }
  .banner.warn { background: var(--warn-soft); }
  .banner > :global(svg) { margin-top: 2px; flex: none; color: var(--muted); }
  .banner.warn > :global(svg) { color: var(--warn); }
  .bt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--fs-small); color: var(--ink2); }
  .bt b { font-size: var(--fs-quiet); color: var(--ink); font-weight: var(--w-control); }
  .pr { display: flex; align-items: center; gap: var(--sp-2); height: 36px; padding: 0 var(--sp-3); border-radius: var(--r-md); background: var(--tint); box-shadow: inset 0 0 0 var(--hairline) var(--hair); font-size: var(--fs-small); color: var(--ink); text-align: left; }
  button.pr:hover { background: var(--hover); }
  .pr.quiet { color: var(--muted); }
  .pr > :global(svg) { color: var(--muted); flex: none; }
  .num { color: var(--muted); font-variant-numeric: tabular-nums; }
  .chip { flex: none; display: inline-flex; align-items: center; height: 20px; padding: 0 var(--sp-1h); border-radius: 999px; background: var(--tint); box-shadow: inset 0 0 0 var(--hairline) var(--hair); color: var(--muted); font-size: var(--fs-meta); }
  .chip.warn { background: var(--warn-soft); color: var(--ink2); box-shadow: none; }
  .stash { display: flex; align-items: center; gap: var(--sp-1); margin: 0 calc(-1 * var(--row-x)); padding-right: var(--sp-1); border-radius: var(--r-sm); }
  .stash:hover { background: var(--hover); }
  .stash :global(svg) { color: var(--muted); flex: none; }
  .sec { display: flex; align-items: center; gap: var(--sp-2); height: 32px; padding-left: var(--sp-0h); color: var(--muted); font-size: var(--fs-quiet); }
  .list { display: flex; flex-direction: column; gap: var(--row-gap); }
  .frow { position: relative; display: flex; align-items: center; margin: 0 calc(-1 * var(--row-x)); padding-left: var(--row-x); border-radius: var(--r-sm); transition: background var(--t-fast) ease-out; }
  .frow:hover, .frow.menu { background: var(--hover); }
  .ck { display: inline-flex; padding-left: var(--sp-0h); }
  .file { flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--row-x); height: var(--row); padding: 0 var(--sp-1) 0 var(--sp-2); text-align: left; }
  .file.sub { width: 100%; padding-left: 0; }
  .stash .file { padding-left: var(--row-x); font-size: var(--fs-small); color: var(--ink); }
  .chev { color: var(--muted); display: inline-flex; transition: transform var(--t-base) var(--ease-base); flex: none; }
  .chev.on { transform: rotate(90deg); }
  .st { font-family: var(--mono); font-size: var(--fs-small); font-weight: var(--w-control); width: 14px; text-align: center; color: var(--muted); flex: none; }
  .st-A { color: var(--diff-added-ink); } .st-D, .st-\! { color: var(--diff-removed-ink); } .st-R { color: var(--accent); }
  .path { flex: 1; min-width: 0; font-size: var(--fs-small); display: flex; align-items: center; overflow: hidden; }
  .counts { flex: none; display: inline-flex; gap: var(--sp-1h); font-family: var(--mono); font-size: var(--fs-small); }
  .add { color: var(--diff-added-ink); } .del { color: var(--diff-removed-ink); }
  .acts { flex: none; display: inline-flex; padding-right: var(--sp-1h); opacity: 0; transition: opacity var(--t-fast) ease-out; }
  .frow:hover .acts, .frow.menu .acts, .acts:focus-within { opacity: 1; }
  :global(:root[data-phone]) .acts { opacity: 1; }
  .dbody { margin: 0 0 var(--sp-2); border-radius: var(--r-md); background: var(--tint); overflow: hidden; }
  .pickbar { display: flex; align-items: center; gap: var(--sp-1); height: 32px; padding: var(--sp-1) var(--sp-2) 0 var(--sp-3); color: var(--muted); font-size: var(--fs-small); }
  .pickbar .cut { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .reading { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); color: var(--muted); font-size: var(--fs-quiet); }
  .note { padding: var(--sp-2) var(--sp-3); color: var(--muted); font-size: var(--fs-small); }
  .cfiles { padding: 0 0 var(--sp-2) var(--sp-4); }
  .pics { display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2); padding: var(--sp-2); }
  .pics figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: var(--sp-1); min-width: 0; }
  .pics figcaption { font-size: var(--fs-meta); color: var(--muted); }
  .pics img { max-width: 100%; max-height: 280px; border-radius: var(--r-sm); box-shadow: 0 0 0 var(--hairline) var(--hair); background: repeating-conic-gradient(var(--tint) 0 25%, transparent 0 50%) 0 0 / 16px 16px; }
  .pics .none { color: var(--faint); font-size: var(--fs-small); padding: var(--sp-6) 0; }
  .clean { display: flex; flex-direction: column; gap: var(--sp-2); padding-top: var(--sp-6); }
  .suggest { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-2h, 10px) var(--sp-3); border-radius: var(--r-md); background: var(--tint); box-shadow: inset 0 0 0 var(--hairline) var(--hair); text-align: left; }
  .suggest:hover:not(:disabled) { background: var(--hover); }
  .suggest :global(svg) { color: var(--muted); flex: none; }
  .suggest > span { display: flex; flex-direction: column; gap: 1px; font-size: var(--fs-small); color: var(--muted); }
  .suggest b { color: var(--ink); font-weight: var(--w-control); font-size: var(--fs-quiet); }
  .foot { flex: none; display: flex; flex-direction: column; gap: var(--sp-1h); padding: var(--sp-2) var(--gutter) var(--gutter); box-shadow: inset 0 var(--hairline) 0 var(--hair); }
  .sum { font-size: var(--fs-quiet); height: 32px; }
  .desc { font-size: var(--fs-quiet); min-height: 44px; resize: vertical; padding-top: var(--sp-1h); }
  .crow { display: flex; align-items: center; gap: var(--sp-1); }
  .cbtn { flex: 1; min-width: 0; display: flex; }
  .cbtn :global(.btn) { width: 100%; }
  .flags { display: flex; gap: var(--sp-1); }
  .last { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-small); color: var(--muted); min-height: 24px; }
  .last .cut { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* (A short card: the list keeps the room; the commit box comes back when it is taller.) */
  @container card (max-height: 340px) { .foot { display: none; } }
</style>
