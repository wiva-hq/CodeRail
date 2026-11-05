// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

// Claude Code's transcripts on this machine. Another client (the Claude app, a terminal `claude --resume`) can go
// on with a session CodeRail has open: it appends to the same file, and these tell the bridge what it appended.

/** Where Claude Code keeps a session's transcript: <config>/projects/<cwd, each non-alphanumeric as '-'>/<id>.jsonl,
 *  or null while it has none (a new session before its first prompt). */
export function transcriptPath(configDir: string, cwd: string, sessionId: string): string | null {
  const root = join(configDir, 'projects');
  const direct = join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId + '.jsonl');
  if (existsSync(direct)) return direct;
  // (A long cwd's folder name is shortened with a hash: look for the file instead.)
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, sessionId + '.jsonl');
      if (existsSync(f)) return f;
    }
  } catch {}
  return null;
}

/** The file's size, or -1 when it can't be read. */
export function sizeOf(file: string): number {
  try { return statSync(file).size; } catch { return -1; }
}

export interface Appended {
  /** Where the last whole line ends: a line still being written is left for the next look. */
  end: number;
  /** The ids ACP's replay stamps on these messages' chunks: a user message's uuid, an assistant message's API id. */
  ids: Set<string>;
  /** Whether the last message is an assistant's that ends the turn (not one waiting on a tool). */
  turnDone: boolean;
}

/** The conversation messages appended to a transcript from byte `from` on. */
export function appended(file: string, from: number): Appended {
  const ids = new Set<string>();
  let turnDone = false;
  const size = sizeOf(file);
  if (size <= from) return { end: Math.max(size, 0), ids, turnDone };
  const buf = Buffer.alloc(size - from);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, buf.length, from); } finally { closeSync(fd); }
  const last = buf.lastIndexOf(0x0a);
  if (last < 0) return { end: from, ids, turnDone };
  for (const line of buf.subarray(0, last).toString('utf8').split('\n')) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (o?.type !== 'user' && o?.type !== 'assistant') continue;
    if (typeof o.uuid === 'string') ids.add(o.uuid);
    if (o.type === 'assistant' && typeof o.message?.id === 'string') ids.add(o.message.id);
    turnDone = o.type === 'assistant' && !!o.message?.stop_reason && o.message.stop_reason !== 'tool_use';
  }
  return { end: from + last + 1, ids, turnDone };
}

// ---- Forks
// The Claude app resumes a session by forking it: it copies the transcript, uuids and all, to a new session id and
// goes on there. What it adds hangs off the session's own messages, so it can be put back in the session's transcript.

/** The forks of a session changed since `since` (ms): the other transcripts in its folder that begin with its lines. */
export function forksOf(file: string, sessionId: string, since: number): string[] {
  const dir = dirname(file);
  const mark = `"sessionId":"${sessionId}"`;
  const out: string[] = [];
  let names: string[];
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.jsonl') || name === basename(file)) continue;
    const f = join(dir, name);
    let st;
    try { st = statSync(f); } catch { continue; }
    if (!st.isFile() || st.mtimeMs <= since) continue;
    const head = Buffer.alloc(Math.min(8192, st.size));
    const fd = openSync(f, 'r');
    try { readSync(fd, head, 0, head.length, 0); } finally { closeSync(fd); }
    if (head.toString('utf8').includes(mark)) out.push(f);
  }
  return out;
}

/** The uuids of a transcript's messages. */
export function uuidsOf(file: string): Set<string> {
  const out = new Set<string>();
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return out; }
  for (const line of text.split('\n')) {
    let o: any;
    try { o = JSON.parse(line); } catch { continue; }
    if (typeof o?.uuid === 'string') out.add(o.uuid);
  }
  return out;
}

/** The uuid of a transcript's last message: where the next one hangs. */
export function tipOf(file: string): string | null {
  let text: string;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let o: any;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (typeof o?.uuid === 'string') return o.uuid;
  }
  return null;
}

export interface ForkTail {
  /** The fork's messages the session does not have, as lines for the session's transcript. */
  lines: string[];
  uuids: string[];
  /** The message the first of them hangs off: the fork goes on from the session only if that is the session's tip. */
  parent: string | null;
  /** A `last-prompt` line for the end of them. Claude Code resumes from the leafUuid of a transcript's last such line
   *  (and on from it): without one, it would resume from where the session's own last prompt was and leave these out. */
  lastPrompt: string | null;
  /** Whether the last of them ends a turn (see Appended.turnDone). */
  turnDone: boolean;
}

/** What a fork has that the session's transcript (its uuids: `have`) does not: whole lines with a uuid, in order,
 *  each with the session's id. (The fork's own bookkeeping, titles and such, has no uuid and stays there.) */
export function forkTail(fork: string, have: Set<string>, sessionId: string): ForkTail {
  const lines: string[] = [];
  const uuids: string[] = [];
  let parent: string | null = null;
  let turnDone = false;
  let lastPrompt: any = null;
  let prompt: { uuid: string; text: string } | null = null;
  let text: string;
  try { text = readFileSync(fork, 'utf8'); } catch { return { lines, uuids, parent, lastPrompt: null, turnDone }; }
  const whole = text.slice(0, text.lastIndexOf('\n') + 1);
  const parsed: any[] = whole.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } });
  // (Only the conversation as it ends: back from the last message to one `have` has. Branches left behind in the
  // file, a reply cut off by a resume from elsewhere and the like, are not part of it.)
  const byUuid = new Map<string, any>();
  for (const o of parsed) if (typeof o?.uuid === 'string') byUuid.set(o.uuid, o);
  const onChain = new Set<string>();
  for (let o = parsed.findLast((x) => typeof x?.uuid === 'string'); o && !have.has(o.uuid) && !onChain.has(o.uuid); o = byUuid.get(o.parentUuid)) onChain.add(o.uuid);
  for (const o of parsed) {
    if (o?.type === 'last-prompt' && typeof o.leafUuid === 'string') { lastPrompt = o; continue; }
    if (typeof o?.uuid !== 'string' || !onChain.has(o.uuid)) continue;
    if (!lines.length) parent = typeof o.parentUuid === 'string' ? o.parentUuid : null;
    o.sessionId = sessionId;
    lines.push(JSON.stringify(o));
    uuids.push(o.uuid);
    if (o.type === 'user' && !o.isMeta && !o.isSidechain) {
      const c = o.message?.content;
      const said = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b: any) => b?.type === 'text')?.text : undefined;
      if (typeof said === 'string' && !(Array.isArray(c) && c.some((b: any) => b?.type === 'tool_result'))) prompt = { uuid: o.uuid, text: said };
    }
    if (o.type === 'user' || o.type === 'assistant') {
      turnDone = o.type === 'assistant' && !!o.message?.stop_reason && o.message.stop_reason !== 'tool_use';
    }
  }
  // (The source's own line when it points into what is taken, else one for the last prompt taken.)
  const taken = new Set(uuids);
  let last: string | null = null;
  if (lastPrompt && taken.has(lastPrompt.leafUuid)) last = JSON.stringify({ ...lastPrompt, sessionId });
  else if (prompt) last = JSON.stringify({ type: 'last-prompt', lastPrompt: prompt.text, leafUuid: prompt.uuid, sessionId });
  return { lines, uuids, parent, lastPrompt: last, turnDone };
}

/** The tail's lines hung off `tip` instead of where they went on from: the other client went on from an earlier
 *  message than the session's last, and what it said goes after the session's own turns rather than beside them. */
export function hungOff(t: ForkTail, tip: string | null): string[] {
  if (!t.lines.length || t.parent === tip) return t.lines;
  const first = JSON.parse(t.lines[0]);
  first.parentUuid = tip;
  return [JSON.stringify(first), ...t.lines.slice(1)];
}

const parseLines = (text: string): any[] => text.split('\n').filter((l) => l.length).map((l) => { try { return JSON.parse(l); } catch { return { __raw: l }; } });

/** The conversation as a transcript ends: back from its last message along the parents, in order. */
function chainOf(parsed: any[]): any[] {
  const byUuid = new Map<string, any>();
  for (const o of parsed) if (typeof o?.uuid === 'string') byUuid.set(o.uuid, o);
  const out: any[] = [];
  const seen = new Set<string>();
  for (let o = parsed.findLast((x) => typeof x?.uuid === 'string'); o && !seen.has(o.uuid); o = byUuid.get(o.parentUuid)) { seen.add(o.uuid); out.push(o); }
  return out.reverse();
}

/** `target` (another client's fork) rewritten so its conversation is `canonical`'s: the same messages, hung the same
 *  way, the last of them at the file's end and a `last-prompt` line pointing into them, so that client resumes with
 *  all of it. Its other lines (titles, branches left behind) are kept, before. Null when it already is. */
export function mirrored(target: string, canonical: string, targetId: string): string | null {
  let t: any[], c: any[];
  try { t = parseLines(readFileSync(target, 'utf8')); c = parseLines(readFileSync(canonical, 'utf8')); } catch { return null; }
  const want = chainOf(c);
  if (!want.length) return null;
  const have = chainOf(t);
  const leaf = t.findLast((o) => o?.type === 'last-prompt')?.leafUuid;
  const onChain = new Set(want.map((o) => o.uuid));
  if (have.length === want.length && have.every((o, i) => o.uuid === want[i].uuid) && onChain.has(leaf)) return null;
  const own = new Map<string, any>();
  for (const o of t) if (typeof o?.uuid === 'string') own.set(o.uuid, o);
  let prompt: any = null;
  const chain = want.map((w) => {
    const o = { ...(own.get(w.uuid) ?? w), parentUuid: w.parentUuid, sessionId: targetId };
    if (o.type === 'user' && !o.isMeta && !o.isSidechain) {
      const k = o.message?.content;
      const said = typeof k === 'string' ? k : Array.isArray(k) ? k.find((b: any) => b?.type === 'text')?.text : undefined;
      if (typeof said === 'string' && !(Array.isArray(k) && k.some((b: any) => b?.type === 'tool_result'))) prompt = { uuid: o.uuid, text: said };
    }
    return o;
  });
  const rest = t.filter((o) => !(typeof o?.uuid === 'string' && onChain.has(o.uuid)) && o?.type !== 'last-prompt');
  const tail = prompt ? [{ type: 'last-prompt', lastPrompt: prompt.text, leafUuid: prompt.uuid, sessionId: targetId }] : [];
  return [...rest, ...chain, ...tail].map((o) => o.__raw ?? JSON.stringify(o)).join('\n') + '\n';
}
