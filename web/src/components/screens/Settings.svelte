<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Settings (/settings/:section), as Forest draws it: the sections at the left on the content ground, the section's
  // groups of rows at the right (a title, what it does, its control). Account (password, appearance, sign out),
  // Notifications (web push), Machine access (each machine you own: rename, remove, who may use it and how), Users and
  // invites (admins), Audit log. On the phone the sections are a row of tabs over the page.
  import { onMount, untrack } from 'svelte';
  import WivaBadge from '../WivaBadge.svelte';
  import { HARNESSES, type Role } from '@coderail/protocol';
  import { api, plainError, type AuditRow, type Grant, type Invite, type UserRow } from '../../lib/api';
  import { app, copyText } from '../../lib/app.svelte';
  import { router, paths } from '../../lib/router.svelte';
  import { savedTheme, setTheme, type Theme } from '../../lib/theme';
  import { pushSupported, currentSubscription, enablePush, disablePush } from '../../lib/push';
  import { ago, dateTime, dayLine, hm } from '../../lib/format';
  import { describe } from '../../lib/audit';
  import { tilde } from '../../lib/machineText';
  import { layout } from '../../lib/layout.svelte';
  import { tip } from '../../lib/tip';
  import TopBar from '../TopBar.svelte';
  import Icon from '../Icon.svelte';
  import Button from '../ui/Button.svelte';
  import Select from '../ui/Select.svelte';
  import SegmentedControl from '../ui/SegmentedControl.svelte';
  import SettingRow from '../ui/SettingRow.svelte';
  import Switch from '../ui/Switch.svelte';
  import EmptyState from '../ui/EmptyState.svelte';
  import CardLoad from '../CardLoad.svelte';
  import Sheet from '../ui/Sheet.svelte';
  import GrantSheet from '../GrantSheet.svelte';
  let { tab: asked }: { tab: string | null } = $props();
  const me = $derived(app.user || null);
  const SECTIONS = $derived<[string, string, string][]>([
    ['account', 'person', 'Account'],
    ['notifications', 'bolt', 'Notifications'],
    ['access', 'lock', 'Machine access'],
    ...(me?.isAdmin ? [['users', 'contacts', 'Users and invites'] as [string, string, string]] : []),
    ['audit', 'history', 'Audit log'],
  ]);
  const tab = $derived(SECTIONS.some(([id]) => id === asked) ? asked! : 'account');
  function go(id: string) { router.go(id === 'account' ? '/settings' : `/settings/${id}`, true); }

  // ---- account
  // (Password: a row with Change password, which opens a dialog: the current one, the new one twice, a check for
  // each rule as you type, Show to see what you typed.)
  let pwOpen = $state(false), pwShow = $state(false);
  let cur = $state(''), next = $state(''), next2 = $state('');
  let pwBusy = $state(false), pwErr = $state<string | null>(null);
  const longEnough = $derived(next.length >= 8);
  const same = $derived(!!next && next === next2);
  function closePassword() { pwOpen = pwShow = false; cur = next = next2 = ''; pwErr = null; }
  async function changePassword(e: Event) {
    e.preventDefault();
    if (!cur || !longEnough || !same) return;
    pwBusy = true; pwErr = null;
    try { await api.password(cur, next); closePassword(); app.toast('Password changed', 'success'); } catch (err) { pwErr = plainError(err); }
    pwBusy = false;
  }
  let theme = $state<Theme>(savedTheme());

  // ---- notifications
  let pushOn = $state<boolean | null>(null);
  let pushBusy = $state(false);
  let pushErr = $state<string | null>(null);
  $effect(() => { if (tab === 'notifications') untrack(() => currentSubscription().then((s) => (pushOn = !!s)).catch(() => (pushOn = false))); });
  async function setPush(on: boolean) {
    pushBusy = true; pushErr = null;
    try {
      if (on) { pushErr = await enablePush(); pushOn = !pushErr; }
      else { await disablePush(); pushOn = false; }
    } catch (e) { pushErr = plainError(e); }
    pushBusy = false;
  }

  // ---- users (also for granting access)
  let users = $state<UserRow[] | null>(null);
  let invites = $state<Invite[] | null>(null);
  /** The invite just made: its link shows until it's revoked or used. */
  let fresh = $state<{ code: string; url: string; isAdmin: boolean } | null>(null);
  async function loadUsers() {
    users = await api.users().catch((e) => { app.toast(plainError(e), 'warning'); return []; });
    if (me?.isAdmin) invites = await api.invites().catch(() => []);
  }
  $effect(() => { if ((tab === 'users' || tab === 'access') && users === null) untrack(loadUsers); });
  async function newInvite(isAdmin: boolean) {
    try { const r = await api.newInvite(isAdmin); fresh = { code: r.code, url: r.url, isAdmin }; invites = await api.invites(); } catch (e) { app.toast(plainError(e), 'warning'); }
  }
  const inviteUrl = (code: string) => `${location.origin}/invite/${code}`;
  async function patchUser(u: UserRow, body: { isAdmin?: boolean; disabled?: boolean }) {
    if (await app.act(() => api.patchUser(u.id, body))) Object.assign(u, body);
  }
  function deleteUser(u: UserRow) {
    app.confirmIt({ title: `Delete ${u.username}?`, body: 'Their account and every access they have go. Machines they own stay, with no owner until an admin grants one.', yes: 'Delete', danger: true,
      run: async () => { await api.deleteUser(u.id); users = (users ?? []).filter((x) => x.id !== u.id); } });
  }

  // ---- machine access
  const owned = $derived(app.machines.filter((m) => m.scope.role === 'owner'));
  let grants = $state<Record<string, Grant[] | null>>({});
  let names = $state<Record<string, string>>({});
  async function loadGrants(id: string) {
    grants = { ...grants, [id]: null };
    try { grants = { ...grants, [id]: await api.grants(id) }; } catch (e) { app.toast(plainError(e), 'warning'); grants = { ...grants, [id]: [] }; }
  }
  $effect(() => {
    if (tab !== 'access') return;
    for (const m of owned) untrack(() => { if (!(m.id in grants)) { names[m.id] = m.name; void loadGrants(m.id); } });
  });
  // (Linked from a machine's menu: /settings/access#id scrolls to it.)
  onMount(() => { const h = location.hash.slice(1); if (h) setTimeout(() => document.getElementById(`m-${h}`)?.scrollIntoView({ block: 'start' }), 300); });
  async function rename(id: string) {
    const n = names[id]?.trim();
    const m = app.machine(id);
    if (!n || !m || n === m.name) return;
    if (await app.act(() => api.renameMachine(id, n), 'Renamed')) m.name = n;
  }
  function removeMachine(id: string) {
    const m = app.machine(id);
    app.confirmIt({ title: `Remove ${m?.name ?? 'this computer'}?`, body: 'Its token is revoked and its bridge disconnected. Its sessions’ history here goes. Link it again to bring it back.', yes: 'Remove', danger: true,
      run: async () => { await api.removeMachine(id); app.dropConn(id); app.machines = app.machines.filter((x) => x.id !== id); } });
  }
  function removeGrant(id: string, g: Grant) {
    app.confirmIt({ title: `Remove ${g.username}’s access?`, yes: 'Remove', danger: true,
      run: async () => { await api.deleteGrant(id, g.userId); grants = { ...grants, [id]: (grants[id] ?? []).filter((x) => x.userId !== g.userId) }; } });
  }
  const ROLES: { id: Role; label: string; desc: string }[] = [
    { id: 'viewer', label: 'Viewer', desc: 'Sees sessions, files and diffs' },
    { id: 'operator', label: 'Operator', desc: 'Drives sessions, files and git' },
    { id: 'owner', label: 'Owner', desc: 'Everything, and who has access' },
  ];
  /** Someone's access in a line: "Operator · ~/code/webapp · Claude Code · no terminal". */
  function grantLine(g: Grant, home?: string) {
    const role = ROLES.find((r) => r.id === g.role)?.label ?? g.role;
    if (g.role !== 'operator') return role;
    const where = g.folders?.length ? (g.folders.length === 1 ? tilde(g.folders[0], home) : `${g.folders.length} folders`) : 'everywhere';
    const agents = g.harnesses ? (g.harnesses.length ? g.harnesses.map((h) => HARNESSES.find((x) => x.id === h)?.name ?? h).join(', ') : 'no agents') : 'all agents';
    return `${role} · ${where} · ${agents} · ${g.terminal ? 'terminal' : 'no terminal'}`;
  }
  /** The access dialog: someone's access to change, or the people who may be given some. */
  let editing = $state<{ machine: string; grant?: Grant; people?: { id: string; username: string }[] } | null>(null);
  async function saveGrant(id: string, g: Grant): Promise<boolean> {
    if (!(await app.act(() => api.putGrant(id, g.userId, { role: g.role, folders: g.folders, harnesses: g.harnesses, terminal: g.terminal })))) return false;
    const list = grants[id] ?? [];
    grants = { ...grants, [id]: list.some((x) => x.userId === g.userId) ? list.map((x) => (x.userId === g.userId ? g : x)) : [...list, g] };
    return true;
  }

  // ---- audit
  // (A page of 50, newest first; filtered by kind of action, person and computer, and a new filter starts at page 1.)
  let audit = $state<AuditRow[] | null>(null);
  let auditMachine = $state(''), auditUser = $state(''), auditKind = $state('');
  let auditPage = $state(0), auditMore = $state(false);
  async function loadAudit() {
    audit = null;
    try {
      const r = await api.audit({ machine: auditMachine, user: auditUser, kind: auditKind, page: auditPage, size: 50 });
      audit = r.rows; auditMore = r.more;
    } catch (e) { app.toast(plainError(e), 'warning'); audit = []; auditMore = false; }
  }
  $effect(() => { void auditMachine; void auditUser; void auditKind; untrack(() => { auditPage = 0; }); });
  $effect(() => { void auditMachine; void auditUser; void auditKind; void auditPage; if (tab === 'audit') untrack(loadAudit); });
  function turn(by: number) { auditPage = Math.max(0, auditPage + by); document.querySelector('.inner')?.scrollTo({ top: 0 }); }
  const KINDS = [{ id: '', label: 'All' }, { id: 'prompts', label: 'Prompts' }, { id: 'files', label: 'Files' }, { id: 'git', label: 'Git' }, { id: 'terminals', label: 'Terminals' }, { id: 'access', label: 'Access' }];
  // (How long the log keeps an entry: admins choose; the server trims it once a day.)
  let keepDays = $state<number | null>(null);
  $effect(() => { if (tab === 'audit' && me?.isAdmin && keepDays === null) untrack(() => api.settings().then((r) => (keepDays = r.auditDays)).catch(() => {})); });
  async function setKeep(d: number) {
    const was = keepDays;
    keepDays = d;
    try { keepDays = (await api.setSettings({ auditDays: d })).auditDays; app.toast(d ? `The audit log keeps ${d === 365 ? 'a year' : `${d} days`}` : 'The audit log keeps everything', 'success'); void loadAudit(); }
    catch (e) { keepDays = was; app.toast(plainError(e), 'warning'); }
  }
  // (Names for the people a row names by id, and the people to filter by: the Users list.)
  $effect(() => { if (tab === 'audit' && users === null) untrack(loadUsers); });
  const userName = (id: string) => users?.find((u) => u.id === id)?.username ?? null;
  const homeOf = (machineId: string | null) => app.machines.find((m) => m.id === machineId)?.info?.home;
  /** The rows by day, newest first: [label, rows]. */
  const auditDays = $derived.by(() => {
    const out: [string, AuditRow[]][] = [];
    for (const r of audit ?? []) {
      const d = dayLine(r.at, app.now);
      if (out.at(-1)?.[0] !== d) out.push([d, []]);
      out.at(-1)![1].push(r);
    }
    return out;
  });
</script>

<div class="page">
  <TopBar title="Settings" />
  <div class="set-wrap" class:phone={layout.phone}>
    {#if layout.phone}
      <div class="ptabs scroll">{#each SECTIONS as [id, , label] (id)}<button class="chip" class:on={tab === id} onclick={() => go(id)}>{label}</button>{/each}</div>
    {:else}
      <nav>
        {#each SECTIONS as [id, ic, label] (id)}
          <button class="row" class:sel={tab === id} aria-current={tab === id ? 'page' : undefined} onclick={() => go(id)}><span class="ico"><Icon name={ic} size={20} /></span><span class="l cut">{label}</span></button>
        {/each}
      </nav>
    {/if}
    <div class="inner scroll">
      <div class="col">
        {#if tab === 'account'}
          <h2 class="group-head">Account</h2>
          <SettingRow title={me?.username ?? ''} description={me?.isAdmin ? 'Admin' : 'Member'}>
            {#snippet lead()}<span class="av">{me?.username[0]?.toUpperCase()}</span>{/snippet}
            {#snippet control()}<Button onclick={() => app.signOut()}>Sign out</Button>{/snippet}
          </SettingRow>
          <SettingRow title="Password">
            {#snippet control()}<Button onclick={() => (pwOpen = true)}>Change password</Button>{/snippet}
          </SettingRow>
          {#if pwOpen}
            <Sheet title="Change password" width={440} onclose={closePassword}>
              <form id="pwform" class="pw" onsubmit={changePassword}>
                <label class="pf"><span>Current password</span>
                  <!-- svelte-ignore a11y_autofocus -->
                  <input class="field" type={pwShow ? 'text' : 'password'} bind:value={cur} autocomplete="current-password" autofocus /></label>
                <label class="pf"><span>New password</span>
                  <input class="field" type={pwShow ? 'text' : 'password'} bind:value={next} autocomplete="new-password" /></label>
                <label class="pf"><span>New password again</span>
                  <input class="field" type={pwShow ? 'text' : 'password'} bind:value={next2} autocomplete="new-password" /></label>
                <ul class="rules">
                  <li class:ok={longEnough}><Icon name={longEnough ? 'check' : 'info'} size={14} />At least 8 characters</li>
                  <li class:ok={same}><Icon name={same ? 'check' : 'info'} size={14} />Both new passwords match</li>
                </ul>
                {#if pwErr}<div class="err"><Icon name="warning" size={15} />{pwErr}</div>{/if}
              </form>
              {#snippet footer()}
                <Button variant="quiet" icon={pwShow ? 'eyeoff' : 'eye'} onclick={() => (pwShow = !pwShow)}>{pwShow ? 'Hide' : 'Show'}</Button>
                <span class="sp"></span>
                <Button onclick={closePassword}>Cancel</Button>
                <Button variant="primary" type="submit" form="pwform" busy={pwBusy} disabled={!cur || !longEnough || !same}>Change password</Button>
              {/snippet}
            </Sheet>
          {/if}
          <h2 class="group-head">Appearance</h2>
          <SettingRow title="Theme">
            {#snippet control()}
              <SegmentedControl label="Theme" value={theme} onchange={(v) => { theme = v as Theme; setTheme(theme); }}
                options={[{ id: 'system', label: '', icon: 'monitor', tip: 'System' }, { id: 'light', label: '', icon: 'sun', tip: 'Light' }, { id: 'dark', label: '', icon: 'moon', tip: 'Dark' }]} />
            {/snippet}
          </SettingRow>
          <div class="built"><WivaBadge /></div>

        {:else if tab === 'notifications'}
          <h2 class="group-head">Notifications</h2>
          <SettingRow title="Approvals on this device" description="When an agent waits for your approval. On iPhone, add CodeRail to the Home Screen first.">
            {#snippet control()}
              {#if !pushSupported()}<span class="quiet">Not supported here</span>
              {:else if pushOn === null || pushBusy}<span class="spinner"></span>
              {:else}<Switch on={pushOn} label="Notifications" onchange={setPush} />{/if}
            {/snippet}
          </SettingRow>
          {#if pushErr}<div class="err"><Icon name="warning" size={15} />{pushErr}</div>{/if}

        {:else if tab === 'access'}
          {#if !app.machinesLoaded}<CardLoad retry={() => app.loadMachines()} />
          {:else if !owned.length}<EmptyState icon="lock" text="You don’t own a machine" tip="The person who approves a computer’s link owns it" />{/if}
          {#each owned as m (m.id)}
            {@const gs = grants[m.id]}
            {@const free = (users ?? []).filter((u) => !u.disabled && !(gs ?? []).some((g) => g.userId === u.id))}
            <section class="mach" id="m-{m.id}">
              <h2 class="group-head"><span class="sdot" class:on={m.online}></span><a class="mlink" href={paths.machine(m.id)}>{m.name}</a><span class="n">{m.info?.hostname ?? ''}</span></h2>
              <SettingRow title="Name">
                {#snippet control()}<input class="field nm" bind:value={names[m.id]} onblur={() => rename(m.id)} onkeydown={(e) => { if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur(); }} />{/snippet}
              </SettingRow>
              <div class="grants">
                {#if gs === null || gs === undefined}<div class="wait"><span class="spinner"></span></div>
                {:else}
                  {#each gs as g (g.userId)}
                    {@const self = g.userId === (me ? me.id : '')}
                    <div class="grant">
                      <span class="av sm">{g.username[0]?.toUpperCase()}</span>
                      <span class="gt"><span class="gn cut">{g.username}{#if self}<span class="quiet"> (you)</span>{/if}</span><span class="gs cut">{grantLine(g, m.info?.home)}</span></span>
                      {#if !self}<Button size="sm" onclick={() => (editing = { machine: m.id, grant: g })}>Edit</Button>{/if}
                    </div>
                  {/each}
                  <div class="addg">
                    {#if users === null}<span class="spinner"></span>
                    {:else if free.length}
                      <Button size="sm" icon="personplus" onclick={() => (editing = { machine: m.id, people: free })}>Give someone access</Button>
                    {:else}<span class="quiet">Everyone has access. {me?.isAdmin ? 'Invite more people under Users.' : ''}</span>{/if}
                    <span class="sp"></span>
                    <Button variant="danger" size="sm" onclick={() => removeMachine(m.id)}>Remove machine…</Button>
                  </div>
                {/if}
              </div>
            </section>
          {/each}
          {#each editing ? [editing] : [] as e (e)}
            <GrantSheet machine={app.machine(e.machine)?.name ?? 'this computer'} grant={e.grant} people={e.people}
              onsave={(g) => saveGrant(e.machine, g)} onremove={e.grant ? () => removeGrant(e.machine, e.grant!) : undefined} onclose={() => (editing = null)} />
          {/each}

        {:else if tab === 'users'}
          <h2 class="group-head">Invite</h2>
          <SettingRow title="Invite link" description="One account, within 7 days.">
            {#snippet control()}<Button onclick={() => newInvite(false)}>New member link</Button><Button onclick={() => newInvite(true)}>New admin link</Button>{/snippet}
          </SettingRow>
          {#if fresh}
            <Sheet title={fresh.isAdmin ? 'Admin invite link' : 'Member invite link'} width={480} onclose={() => (fresh = null)}>
              <p class="quiet sheet-p">Works once, for 7 days.</p>
              <div class="fresh"><code class="selectable">{fresh.url}</code><Button size="sm" icon="copy" onclick={() => copyText(fresh!.url, 'Link copied')}>Copy</Button></div>
              {#snippet footer()}<span class="sp"></span><Button variant="primary" onclick={() => (fresh = null)}>Done</Button>{/snippet}
            </Sheet>
          {/if}
          {#if invites?.length}
            <h2 class="group-head">Open invites <span class="n">{invites.length}</span></h2>
            {#each invites as i (i.code)}
              <SettingRow title={i.isAdmin ? 'Admin invite' : 'Member invite'} description={`By ${i.createdBy} · expires ${dateTime(i.expiresAt)}`}>
                {#snippet control()}
                  <Button size="sm" icon="copy" onclick={() => copyText(inviteUrl(i.code), 'Link copied')}>Copy</Button>
                  <Button size="sm" variant="icon" icon="trash" tip="Revoke" onclick={async () => { if (await app.act(() => api.deleteInvite(i.code))) invites = (invites ?? []).filter((x) => x.code !== i.code); }} />
                {/snippet}
              </SettingRow>
            {/each}
          {/if}
          <h2 class="group-head">Users {#if users}<span class="n">{users.length}</span>{/if}</h2>
          {#if !users}<CardLoad retry={loadUsers} />{/if}
          {#each users ?? [] as u (u.id)}
            {@const self = u.id === (me ? me.id : '')}
            <SettingRow title={u.username + (self ? ' (you)' : '')} description={`${u.isAdmin ? 'Admin' : 'Member'}${u.disabled ? ' · disabled' : ''} · joined ${ago(u.createdAt, app.now)}`}>
              {#snippet lead()}<span class="av" class:off={u.disabled}>{u.username[0]?.toUpperCase()}</span>{/snippet}
              {#snippet control()}
                <span class="lab" {@attach tip(self ? 'You can’t change your own admin role' : '')}>Admin <Switch on={u.isAdmin} label="Admin" onchange={(v) => !self && patchUser(u, { isAdmin: v })} /></span>
                <span class="lab">Active <Switch on={!u.disabled} label="Active" onchange={(v) => !self && patchUser(u, { disabled: !v })} /></span>
                <Button size="sm" variant="icon" icon="trash" tip={self ? '' : 'Delete'} disabled={self} onclick={() => deleteUser(u)} />
              {/snippet}
            </SettingRow>
          {/each}

        {:else if tab === 'audit'}
          <h2 class="group-head">Audit log <span class="sp"></span>
            <Button variant="icon" size="sm" icon="refresh" tip="Refresh" onclick={loadAudit} />
          </h2>
          {#if me?.isAdmin}
            <SettingRow title="Keep entries for">
              {#snippet control()}
                <SegmentedControl label="Keep entries for" value={keepDays === null ? '' : String(keepDays)} onchange={(v) => setKeep(Number(v))}
                  options={[{ id: '30', label: '30 days' }, { id: '90', label: '90 days' }, { id: '365', label: '1 year' }, { id: '0', label: 'Forever' }]} />
              {/snippet}
            </SettingRow>
          {/if}
          <div class="afilters">
            <div class="kinds">{#each KINDS as k (k.id)}<button class="chip" class:on={auditKind === k.id} aria-pressed={auditKind === k.id} onclick={() => (auditKind = k.id)}>{k.label}</button>{/each}</div>
            <span class="sp"></span>
            <Select value={auditUser} placeholder="Everyone" width={200} label="Person" items={[{ id: '', label: 'Everyone' }, ...(users ?? []).map((u) => ({ id: u.username, label: u.username }))]} onpick={(v) => (auditUser = v)} />
            <Select value={auditMachine} placeholder="All machines" width={220} label="Machine" items={[{ id: '', label: 'All machines' }, ...app.machines.map((m) => ({ id: m.id, label: m.name }))]} onpick={(v) => (auditMachine = v)} />
          </div>
          {#if !audit}<CardLoad retry={loadAudit} />
          {:else if !audit.length}<EmptyState compact icon="history" text={auditKind || auditUser || auditMachine ? 'Nothing matches these filters' : auditPage ? 'No more entries' : 'Nothing yet'} fill={false} />
          {:else}
            {#each auditDays as [day, rows] (day)}
              <h3 class="aday">{day}</h3>
              <div class="audit">
                {#each rows as r, i (i)}
                  {@const said = describe(r, userName, (p) => tilde(p, homeOf(r.machineId)))}
                  <div class="ar">
                    <span class="ai" class:people={said.people}><Icon name={said.icon} size={15} /></span>
                    <div class="ab">
                      <div class="aline"><b>{r.username}</b> {said.did}{#if said.what}{' '}<code class="selectable">{said.what}</code>{/if}</div>
                      {#if said.quote}<div class="aq selectable">{said.quote}</div>{/if}
                      {#if r.machineName && !auditMachine}<div class="am">{r.machineName}</div>{/if}
                    </div>
                    <span class="at" {@attach tip(dateTime(r.at))}>{hm(r.at)}</span>
                  </div>
                {/each}
              </div>
            {/each}
            {#if auditPage || auditMore}
              <div class="pager">
                <Button size="sm" icon="chevl" disabled={!auditPage} onclick={() => turn(-1)}>Newer</Button>
                <span class="quiet">Page {auditPage + 1}</span>
                <Button size="sm" iconEnd="chevr" disabled={!auditMore} onclick={() => turn(1)}>Older</Button>
              </div>
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  </div>
</div>

<style>
  .set-wrap { flex: 1; min-height: 0; display: flex; }
  nav { width: 232px; flex: none; padding: var(--sp-3) var(--nav-inset); display: flex; flex-direction: column; gap: var(--row-gap); }
  nav .row { flex: none; }
  nav .row .l { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; }
  .inner { flex: 1; min-width: 0; background: var(--panel); border-radius: var(--r-sheet) 0 0 0; box-shadow: inset 0 0 0 var(--hairline) var(--hair); container: page / inline-size; }
  .col { max-width: calc(760px + 2 * var(--sp-7)); margin: 0 auto; padding: var(--sp-10) var(--sp-7) var(--sp-12); }
  @container page (max-width: 560px) { .col { padding-inline: var(--gutter); } .col :global(.set) { flex-wrap: wrap; row-gap: var(--sp-2); } .col :global(.set .set-ctl) { max-width: 100%; flex-wrap: wrap; } }
  .phone { flex-direction: column; }
  .phone .inner { border-radius: 0; }
  .phone .col { padding: var(--sp-5) var(--gutter) var(--sp-12); }
  .ptabs { display: flex; gap: var(--sp-1h); padding: 0 var(--gutter) var(--sp-3); overflow-x: auto; flex: none; scrollbar-width: none; }
  .ptabs .chip { flex: none; height: 32px; }
  .ptabs .chip.on { background: var(--primary); color: var(--onprimary); border-color: transparent; }
  .av { width: 36px; height: 36px; border-radius: 50%; background: var(--p4-bg); color: var(--p4-fg); display: inline-flex; align-items: center; justify-content: center; font-weight: var(--w-strong); flex: none; }
  .av.sm { width: 26px; height: 26px; font-size: 12px; }
  .av.off { opacity: 0.4; }
  .pw { display: flex; flex-direction: column; gap: var(--sp-3); }
  .pf { display: flex; flex-direction: column; gap: var(--sp-1); font-size: var(--fs-small); color: var(--ink2); }
  .rules { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: var(--sp-1h) var(--sp-4); font-size: var(--fs-small); color: var(--muted); }
  .rules li { display: inline-flex; align-items: center; gap: var(--sp-1); }
  .rules li.ok { color: var(--ok); }
  .quiet { color: var(--muted); font-size: var(--fs-quiet); }
  .mach { scroll-margin-top: var(--sp-4); }
  .mach .group-head .n { font-size: var(--fs-quiet); }
  .mlink { color: inherit; text-decoration: none; }
  .mlink:hover { text-decoration: underline; }
  .nm { width: 240px; }
  .grants { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-2); }
  .grant { padding: var(--sp-2) var(--sp-3); border-radius: var(--r-lg); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); display: flex; align-items: center; gap: var(--sp-3); }
  .gt { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .gs { font-size: var(--fs-small); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gn { min-width: 0; white-space: nowrap; overflow: hidden; font-weight: var(--w-control); }
  .sp { flex: 1; }
  .addg { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) 0; }
  .wait { padding: var(--sp-4); display: flex; justify-content: center; }
  .sheet-p { margin: 0 0 var(--sp-3); line-height: 1.5; }
  .fresh { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-2) var(--sp-2) var(--sp-3); border-radius: var(--r-md); background: var(--accent-tint); box-shadow: inset 0 0 0 var(--hairline) var(--accent-ring); }
  .fresh code { flex: 1; min-width: 0; font: 12.5px/18px var(--mono); overflow-wrap: anywhere; }
  .lab { display: inline-flex; align-items: center; gap: var(--sp-1h); color: var(--ink2); font-size: var(--fs-small); }
  .afilters { display: flex; align-items: center; flex-wrap: wrap; gap: var(--sp-2); margin: var(--sp-4) 0 var(--sp-1); }
  .kinds { display: flex; flex-wrap: wrap; gap: var(--sp-1h); }
  .kinds .chip { height: 30px; }
  .kinds .chip.on { background: var(--primary); color: var(--onprimary); border-color: transparent; }
  .pager { display: flex; align-items: center; justify-content: center; gap: var(--sp-3); margin-top: var(--sp-5); }
  .aday { margin: var(--sp-5) 0 var(--sp-1); font-size: var(--fs-small); font-weight: var(--w-control); color: var(--muted); }
  .audit { display: flex; flex-direction: column; border-radius: var(--r-lg); box-shadow: inset 0 0 0 var(--hairline) var(--hair2); overflow: hidden; }
  .ar { display: flex; gap: var(--sp-3); align-items: flex-start; padding: var(--sp-3) var(--sp-4); }
  .ar + .ar { box-shadow: inset 0 var(--hairline) 0 var(--hair); }
  .ai { width: 28px; height: 28px; border-radius: 50%; flex: none; display: inline-flex; align-items: center; justify-content: center; background: var(--sel); color: var(--ink2); }
  .ai.people { background: var(--p4-bg); color: var(--p4-fg); }
  .ab { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .aline { font-size: var(--fs-quiet); line-height: 20px; color: var(--ink2); overflow-wrap: anywhere; }
  .aline b { color: var(--ink); font-weight: var(--w-control); }
  .aline code { font: 12.5px/18px var(--mono); color: var(--ink); background: var(--sel); padding: 1px 5px; border-radius: 5px; }
  .aq { font-size: var(--fs-small); line-height: 18px; color: var(--muted); padding-left: var(--sp-2); box-shadow: inset 2px 0 0 var(--hair2); margin-top: 2px; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .am { font-size: var(--fs-small); color: var(--muted); }
  .at { flex: none; color: var(--muted); font-size: var(--fs-small); line-height: 20px; font-variant-numeric: tabular-nums; }
  .built { margin-top: var(--sp-12); }
</style>
