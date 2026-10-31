// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The appearance (Settings › Appearance, the phone's Settings): the system's, or always light or dark. Kept in
// `coderail.theme` (no key: the system's) and shown as data-theme on <html>; every window reads it as it opens. The
// scheme it comes to, light or dark, is data-scheme on <html> (from the first frame: public/first.js), and the CSS
// draws each scheme's colours once, from it.
import { kept, keep } from './kept';
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'coderail.theme';

/** The appearance chosen. */
export function savedTheme(): Theme {
  const t = kept<string | null>(KEY, null);
  return t === 'light' || t === 'dark' ? t : 'system';
}
/** Shows an appearance on this window. */
export function showTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
}
/** A window opening: the chosen light or dark shown (the system's needs nothing). → the appearance chosen. */
export function loadTheme(): Theme {
  const t = savedTheme();
  if (t !== 'system') showTheme(t);
  return t;
}
/** Chooses an appearance: kept, and shown on this window. */
export function setTheme(t: Theme) {
  showTheme(t);
  keep(KEY, t === 'system' ? null : t);
}

/** Keeps data-scheme on the scheme shown: the chosen one, else the system's, as either changes. */
export function followScheme() {
  const root = document.documentElement;
  const mq = matchMedia('(prefers-color-scheme: dark)');
  const set = () => { const t = root.dataset.theme; root.dataset.scheme = t === 'light' || t === 'dark' ? t : mq.matches ? 'dark' : 'light'; };
  set();
  mq.addEventListener('change', set);
  new MutationObserver(set).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
}
