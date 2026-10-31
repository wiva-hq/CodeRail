// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The SPA's routes (docs/api.md "Pages"), on the history API. `route` is the current one; `go` pushes (or replaces)
// a path; internal <a href> clicks are taken over in App.svelte.
export type Route =
  | { name: 'home' }
  | { name: 'machine'; id: string; session: string | null }
  | { name: 'link'; code: string }
  | { name: 'invite'; code: string }
  | { name: 'setup' }
  | { name: 'settings'; tab: string | null }
  | { name: 'notfound' };

export function parse(path: string, search = ''): Route {
  const q = new URLSearchParams(search);
  const p = path.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'home' };
  let m: RegExpMatchArray | null;
  if ((m = p.match(/^\/m\/([^/]+)(?:\/s\/([^/]+))?$/))) return { name: 'machine', id: decodeURIComponent(m[1]), session: m[2] ? decodeURIComponent(m[2]) : null };
  if (p === '/link') return { name: 'link', code: q.get('code') ?? '' };
  if ((m = p.match(/^\/invite\/([^/]+)$/))) return { name: 'invite', code: decodeURIComponent(m[1]) };
  if (p === '/setup') return { name: 'setup' };
  if ((m = p.match(/^\/settings(?:\/([^/]+))?$/))) return { name: 'settings', tab: m[1] ?? null };
  return { name: 'notfound' };
}

class Router {
  route = $state<Route>(parse(location.pathname, location.search));
  path = $state(location.pathname + location.search);
  constructor() {
    window.addEventListener('popstate', () => this.sync());
  }
  private sync() {
    this.path = location.pathname + location.search;
    this.route = parse(location.pathname, location.search);
  }
  go(path: string, replace = false) {
    if (path === location.pathname + location.search) return;
    if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
    this.sync();
    window.scrollTo(0, 0);
  }
  back(fallback = '/') {
    if (history.length > 1 && document.referrer.startsWith(location.origin)) history.back();
    else this.go(fallback);
  }
}

export const router = new Router();

export const paths = {
  machine: (id: string, session?: string | null) => `/m/${encodeURIComponent(id)}${session ? `/s/${encodeURIComponent(session)}` : ''}`,
};
