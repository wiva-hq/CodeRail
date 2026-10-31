// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// CodeRail's service worker: a light app shell (the page and its hashed assets, network first so a deploy shows at
// once; the cache only answers when the network can't), and web push: a push's {title, body, url} is shown, and a
// click focuses an open CodeRail window on that url or opens one. /api is never cached.
const CACHE = 'coderail-shell-v1';

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.svg', '/icon-192.png'])).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // (Pages: the network, else the cached shell, so the app opens offline and says so.)
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); return r; }).catch(() => caches.match('/')));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    // (Hashed: a cached copy is always right.)
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return r; })));
  }
});

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { body: e.data ? e.data.text() : '' }; }
  const title = p.title || 'CodeRail';
  e.waitUntil(self.registration.showNotification(title, {
    body: p.body || '',
    data: { url: p.url || '/' },
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: p.tag || p.url || undefined,
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  // Only a page of this site (a notification's link comes from the server, but never leads elsewhere).
  let url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin);
  if (url.origin !== self.location.origin) url = new URL('/', self.location.origin);
  url = url.href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (new URL(c.url).origin === self.location.origin) {
        await c.focus();
        if ('navigate' in c) { try { await c.navigate(url); } catch { /* another origin's */ } }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
