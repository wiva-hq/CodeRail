// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mount } from 'svelte';
import './styles/theme.css';
import './styles/base.css';
import './styles/md.css';
import './styles/app.css';
import { followScheme, loadTheme } from './lib/theme';

followScheme();
loadTheme();

// (`bun run dev:mock`: a fake /api and one machine in the page, for working on the UI without a backend.)
if (import.meta.env.VITE_MOCK) await import('./mock');

// The app shell and web push: the service worker, in a built app only (in development it would cache the dev server).
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {}); });
}

const { default: App } = await import('./App.svelte');
mount(App, { target: document.getElementById('app')! });
