// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// What the app's xterm terminals share (TerminalCard, TermView): the font and the tokens' terminal colours,
// following the appearance.
import type { ITheme, Terminal } from '@xterm/xterm';

export const FONT = '"SF Mono", ui-monospace, Menlo, monospace';

/** The tokens' terminal colours (`--terminal-*`) as an xterm theme. */
export function termTheme(): ITheme {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim() || undefined;
  return { background: v('--terminal-bg'), foreground: v('--terminal-fg'), cursor: v('--terminal-cursor'), selectionBackground: v('--terminal-selection') };
}

/** Keeps a terminal's colours on the scheme shown (data-scheme on <html>: lib/theme.ts). → stop following. */
export function followTheme(term: Terminal) {
  const mo = new MutationObserver(() => { term.options.theme = termTheme(); });
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme'] });
  return () => mo.disconnect();
}
