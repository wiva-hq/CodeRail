// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// What the first frame needs before the app's script runs: the phone layout (a narrow window; lib/layout keeps it
// current) and the scheme the colours are drawn in (the appearance chosen in Settings, else the system's).
(() => {
  if (matchMedia('(max-width: 700px)').matches) document.documentElement.dataset.phone = '1';
  let t = null;
  try { t = JSON.parse(localStorage.getItem('coderail.theme') ?? 'null'); } catch { /* none kept */ }
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
  document.documentElement.dataset.scheme = t === 'light' || t === 'dark' ? t : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
})();
