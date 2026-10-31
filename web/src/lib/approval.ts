// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// What an approval asks (ACP `session/request_permission`: the tool call and the options), in words: its title, the
// command or path it is about, the glyph of its kind.
import type { Approval } from '@coderail/protocol';
import { textOf } from './transcript';

export function approvalText(a: Approval): { title: string; target: string; icon: string } {
  const t = a.toolCall ?? {};
  const raw = t.rawInput ?? {};
  const cmd = Array.isArray(raw.command) ? raw.command.join(' ') : raw.command;
  const path = raw.file_path ?? raw.path ?? raw.notebook_path ?? t.locations?.[0]?.path;
  const kind: string = t.kind ?? (cmd ? 'execute' : path ? 'edit' : 'other');
  const icon = kind === 'execute' ? 'terminal' : kind === 'edit' || kind === 'delete' || kind === 'move' ? 'edit' : kind === 'read' ? 'read' : kind === 'fetch' ? 'globe' : 'key';
  const target = cmd ?? path ?? raw.url ?? raw.query ?? textOf(t.content?.find?.((c: any) => c?.type === 'content')?.content) ?? '';
  return { title: String(t.title ?? 'Allow this?').replace(/`/g, ''), target: String(target ?? ''), icon };
}

export const OPTION_ORDER: Record<string, number> = { reject_always: 0, reject_once: 1, allow_always: 2, allow_once: 3 };
export function sortedOptions(a: Approval) {
  return [...(a.options ?? [])].sort((x, y) => (OPTION_ORDER[x.kind] ?? 9) - (OPTION_ORDER[y.kind] ?? 9));
}
