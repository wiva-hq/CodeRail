// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A tool tab's name: a shell is "Terminal 2" (its number), a harness login tab the harness's name, a browser tab
// its page's title, a tool its own name.
import { HARNESSES } from '@coderail/protocol';
import { TITLE, type Tab } from './panes.svelte';

export function tabTitle(t: Tab): string {
  if (t.kind === 'browser') return t.title || 'Browser';
  if (t.kind === 'terminal') {
    if (t.title) return t.title;
    if (t.sub && t.sub !== 'shell') return HARNESSES.find((h) => h.id === t.sub)?.name ?? t.sub;
    return `Terminal ${t.num ?? 1}`;
  }
  return TITLE[t.kind];
}
