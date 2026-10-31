// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// An audit row as a sentence: what was done ("opened a terminal"), to what (a folder, a file, a site, a person:
// the part shown in mono), and a quote under it when there is one (the prompt, the commit message).
import type { AuditRow } from './api';
import { HARNESSES } from '@coderail/protocol';

export interface Said {
  icon: string;
  /** What was done, after the person's name. */
  did: string;
  /** To what: a path, a site, a name. */
  what?: string;
  /** Under it, quoted. */
  quote?: string;
  /** A change to a person or to access (shown in the Access colour). */
  people?: boolean;
}

const harness = (id: unknown) => HARNESSES.find((h) => h.id === id)?.name ?? (typeof id === 'string' ? id : 'an agent');
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** `name` turns a user id into a name (the people in the Users list), or null when it isn't one we know. */
export function describe(r: AuditRow, name: (id: string) => string | null, home?: (path: string) => string): Said {
  const d: Record<string, any> = r.detail ?? {};
  const at = (p: unknown) => (typeof p === 'string' && p ? (home ? home(p) : p) : undefined);
  const who = (id: unknown) => (typeof id === 'string' ? name(id) ?? 'a user' : 'a user');
  const files = Array.isArray(d.paths) ? d.paths.length : 0;
  switch (r.action) {
    case 'setup': return { icon: 'crown', did: 'set up CodeRail', people: true };
    case 'signup': return { icon: 'personplus', did: 'joined with an invite', people: true };
    case 'password': return { icon: 'key', did: 'changed their password', people: true };
    case 'settings.update': return { icon: 'history', did: d.auditDays ? `set the audit log to keep ${d.auditDays === 365 ? 'a year' : `${d.auditDays} days`}` : 'set the audit log to keep everything', people: true };
    case 'invite.create': return { icon: 'link', did: `made ${d.isAdmin ? 'an admin' : 'a member'} invite link`, people: true };
    case 'user.update': {
      const changes = [
        typeof d.isAdmin === 'boolean' ? (d.isAdmin ? 'made admin' : 'removed admin from') : null,
        typeof d.disabled === 'boolean' ? (d.disabled ? 'turned off' : 'turned back on') : null,
      ].filter(Boolean);
      return { icon: 'person', did: changes.join(' and ') || 'changed', what: who(d.target), people: true };
    }
    case 'user.delete': return { icon: 'trash', did: 'deleted the user', what: who(d.target), people: true };
    case 'machine.link': return { icon: 'plug', did: 'linked a computer', what: d.name };
    case 'machine.rename': return { icon: 'rename', did: 'renamed the computer to', what: d.name };
    case 'machine.remove': return { icon: 'trash', did: 'removed the computer' };
    case 'grant.set': return { icon: 'lock', did: `let ${who(d.userId)} use it as`, what: d.role, people: true };
    case 'grant.remove': return { icon: 'unlock', did: 'took away access for', what: who(d.userId), people: true };
    case 'browser.open': return { icon: 'globe', did: 'opened in the browser', what: d.url };
    case 'browser.navigate': return { icon: 'globe', did: 'went to', what: d.url };
    // (From before the preview proxy was removed.)
    case 'preview.open': return { icon: 'globe', did: 'opened in the browser', what: d.target };
    case 'term.open': return { icon: 'terminal', did: 'opened a terminal in', what: at(d.cwd) ?? '~' };
    case 'harness.login': return { icon: 'key', did: `signed in ${harness(d.harness)}` };
    case 'harness.logout': return { icon: 'signout', did: `signed out ${harness(d.harness)}` };
    case 'agent.new': return { icon: 'plus', did: `started a ${harness(d.harness)} session in`, what: at(d.cwd) };
    case 'agent.open': return { icon: 'agents', did: `opened a ${harness(d.harness)} session`, what: at(d.cwd) };
    case 'agent.prompt': return { icon: 'send', did: 'sent a prompt', quote: d.text || undefined };
    case 'agent.answer': return { icon: 'hand', did: 'answered an approval' };
    case 'agent.cancel': return { icon: 'stop', did: 'stopped an agent' };
    case 'agent.close': return { icon: 'close', did: 'closed a session' };
    case 'agent.retitle': return { icon: 'sparkle', did: 'asked the agent to name a session' };
    case 'agent.rename': return { icon: 'rename', did: 'renamed a session to', what: d.title ?? 'its own title' };
    case 'agent.forget': return { icon: 'trash', did: 'removed a session from the list' };
    case 'fs.write': return { icon: 'edit', did: 'saved', what: at(d.path) };
    case 'fs.mkdir': return { icon: 'folder', did: 'made the folder', what: at(d.path) };
    case 'fs.rename': return { icon: 'rename', did: 'renamed', what: [at(d.from), at(d.to)].filter(Boolean).join(' → ') || undefined };
    case 'fs.trash': return { icon: 'trash', did: 'moved to the Trash', what: at(d.path) };
    case 'git.stage': return { icon: 'plus', did: files ? `staged ${plural(files, 'file')} in` : 'staged changes in', what: at(d.cwd) };
    case 'git.unstage': return { icon: 'restore', did: files ? `unstaged ${plural(files, 'file')} in` : 'unstaged changes in', what: at(d.cwd) };
    case 'git.discard': return { icon: 'restore', did: files ? `discarded changes to ${plural(files, 'file')} in` : 'discarded changes in', what: at(d.cwd) };
    case 'git.commit': return { icon: 'check', did: 'committed in', what: at(d.cwd), quote: d.message || undefined };
    case 'git.checkout': return d.rev ? { icon: 'branch', did: 'checked out the commit', what: String(d.rev).slice(0, 7) } : { icon: 'branch', did: d.create ? 'made and switched to the branch' : 'switched to the branch', what: d.branch };
    case 'git.fetch': return { icon: 'sync', did: 'fetched in', what: at(d.cwd) };
    case 'git.pull': return { icon: 'sync', did: 'pulled in', what: at(d.cwd) };
    case 'git.push': return { icon: 'upload', did: d.force ? 'force pushed from' : 'pushed from', what: at(d.cwd) };
    case 'git.discard_lines': return { icon: 'restore', did: 'discarded some lines of', what: d.lines?.path };
    case 'git.ignore': return { icon: 'eyeoff', did: 'ignored', what: d.pattern };
    case 'git.undo': return { icon: 'restore', did: 'undid the last commit in', what: at(d.cwd) };
    case 'git.branch_rename': return { icon: 'rename', did: 'renamed the branch', what: `${d.from} → ${d.to}` };
    case 'git.branch_delete': return { icon: 'trash', did: 'deleted the branch', what: d.branch };
    case 'git.merge': return { icon: 'branch', did: d.squash ? 'squash merged' : 'merged', what: d.branch };
    case 'git.rebase': return { icon: 'branch', did: 'rebased onto', what: d.onto };
    case 'git.continue': return { icon: 'play', did: 'continued a merge or rebase in', what: at(d.cwd) };
    case 'git.abort': return { icon: 'stop', did: 'aborted a merge or rebase in', what: at(d.cwd) };
    case 'git.resolve': return { icon: 'check', did: d.side === 'mark' ? 'marked as resolved' : `resolved with ${d.side === 'ours' ? 'our' : 'their'} version`, what: d.path };
    case 'git.revert': return { icon: 'restore', did: 'reverted the commit', what: String(d.rev ?? '').slice(0, 7) };
    case 'git.cherry_pick': return { icon: 'plus', did: 'cherry-picked', what: (d.revs ?? []).map((r: string) => r.slice(0, 7)).join(', ') };
    case 'git.reset': return { icon: 'history', did: 'reset the branch to', what: String(d.rev ?? '').slice(0, 7) };
    case 'git.tag': return { icon: 'hash', did: d.delete ? 'deleted the tag' : 'tagged', what: d.name };
    case 'git.stash': return { icon: 'download', did: 'stashed changes in', what: at(d.cwd) };
    case 'git.stash_apply': return { icon: 'download', did: 'restored stashed changes in', what: at(d.cwd) };
    case 'git.stash_drop': return { icon: 'trash', did: 'discarded stashed changes in', what: at(d.cwd) };
    case 'git.init': return { icon: 'branch', did: 'made a repository in', what: at(d.cwd) };
    case 'git.clone': return { icon: 'download', did: 'cloned', what: d.url };
    case 'gh.checkout': return { icon: 'branch', did: 'checked out pull request', what: `#${d.number}` };
    case 'gh.create': return { icon: 'branch', did: 'opened a pull request', quote: d.title || undefined };
    case 'gh.merge': return { icon: 'branch', did: `merged pull request (${d.method})`, what: `#${d.number}` };
    case 'gh.rerun': return { icon: 'refresh', did: 'ran checks again', what: d.runId };
    case 'gh.publish': return { icon: 'upload', did: 'published to GitHub', what: d.name };
    default: return { icon: 'activity', did: r.action };
  }
}
