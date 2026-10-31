// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Diffs as DiffView draws them (lines: add / del / ctx / gap, with old and new numbers): from git's unified output
// (`git.diff`), or from two texts (an agent's edit: ACP `{type:'diff', path, oldText, newText}`).
import { structuredPatch } from 'diff';
import type { DiffLine } from '../components/DiffView.svelte';

export interface FileDiff { path: string; oldPath?: string; lines: DiffLine[]; added: number; removed: number; binary: boolean }

/** A unified diff (one file or many) into files and their lines. */
export function parseUnified(text: string): FileDiff[] {
  const out: FileDiff[] = [];
  let cur: FileDiff | null = null;
  let o = 0, n = 0, inHunk = false;
  const start = (path: string) => { cur = { path, lines: [], added: 0, removed: 0, binary: false }; out.push(cur); inHunk = false; };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^diff --git a\/(.*) b\/(.*)$/))) { start(m[2]); continue; }
    if (!cur) { if (line.startsWith('--- ') || line.startsWith('@@')) start(''); else continue; }
    const f = cur as unknown as FileDiff;
    if (line.startsWith('Binary files')) { f.binary = true; continue; }
    if (!inHunk && line.startsWith('--- ')) { const p = line.slice(4).replace(/^a\//, ''); if (p !== '/dev/null') f.oldPath = p; continue; }
    if (!inHunk && line.startsWith('+++ ')) { const p = line.slice(4).replace(/^b\//, ''); if (p !== '/dev/null' && !f.path) f.path = p; if (p === '/dev/null' && !f.path) f.path = f.oldPath ?? ''; continue; }
    if ((m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/))) {
      const no = Number(m[1]), nn = Number(m[2]);
      if (f.lines.length || no > 1 || nn > 1) f.lines.push({ kind: 'gap', text: '' });
      o = no; n = nn; inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+')) { f.lines.push({ kind: 'add', text: line.slice(1), new: n++ }); f.added++; }
    else if (line.startsWith('-')) { f.lines.push({ kind: 'del', text: line.slice(1), old: o++ }); f.removed++; }
    else if (line.startsWith(' ')) f.lines.push({ kind: 'ctx', text: line.slice(1), old: o++, new: n++ });
    else if (line.startsWith('\\')) continue;
    else if (line === '') continue;
  }
  return out;
}

/** Two texts into diff lines (3 lines of context around each change). */
export function textDiff(oldText: string | null | undefined, newText: string, path = 'file'): FileDiff {
  const p = structuredPatch(path, path, oldText ?? '', newText ?? '', '', '', { context: 3 });
  const lines: DiffLine[] = [];
  let added = 0, removed = 0;
  p.hunks.forEach((h, i) => {
    if (i > 0 || h.oldStart > 1 || h.newStart > 1) lines.push({ kind: 'gap', text: '' });
    let o = h.oldStart, n = h.newStart;
    for (const l of h.lines) {
      if (l.startsWith('+')) { lines.push({ kind: 'add', text: l.slice(1), new: n++ }); added++; }
      else if (l.startsWith('-')) { lines.push({ kind: 'del', text: l.slice(1), old: o++ }); removed++; }
      else if (l.startsWith(' ')) lines.push({ kind: 'ctx', text: l.slice(1), old: o++, new: n++ });
    }
  });
  return { path, lines, added, removed, binary: false };
}

/** A new file's text as added lines. */
export function allAdded(text: string, path: string): FileDiff {
  const ls = text.replace(/\n$/, '').split('\n');
  return { path, lines: ls.map((t, i) => ({ kind: 'add', text: t, new: i + 1 })), added: ls.length, removed: 0, binary: false };
}

export const extOf = (path: string) => path.split('.').pop()?.toLowerCase() ?? '';
