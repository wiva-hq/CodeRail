// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Web push (docs/api.md "Push"): the service worker (public/sw.js) shows a push's {title, body, url} and opens the url
// on a click. Turning it on asks the browser's permission, subscribes with the deployment's VAPID key and gives the
// subscription to the server.
import { api } from './api';

export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export async function registration(): Promise<ServiceWorkerRegistration> {
  const r = (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register('/sw.js', { scope: '/' }));
  await navigator.serviceWorker.ready;
  return r;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const r = await navigator.serviceWorker.getRegistration('/');
  return (await r?.pushManager.getSubscription()) ?? null;
}

function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** → null when it worked, else why not. */
export async function enablePush(): Promise<string | null> {
  if (!pushSupported()) return 'This browser can’t receive notifications. On iPhone, add CodeRail to the Home Screen first.';
  const { publicKey } = await api.pushKey();
  if (!publicKey) return 'Notifications aren’t set up on this server (no VAPID key).';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'Notifications are blocked for this site in the browser’s settings.';
  const reg = await registration();
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await api.pushSubscribe(sub.toJSON());
  return null;
}

export async function disablePush() {
  const sub = await currentSubscription();
  if (!sub) return;
  await api.pushUnsubscribe(sub.endpoint).catch(() => {});
  await sub.unsubscribe();
}
