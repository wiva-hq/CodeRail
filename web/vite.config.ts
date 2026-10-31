// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// The server (`bun run dev:server`) serves /api on 8787 in development; the dev server passes /api, WebSockets included,
// to it, keeping the page's host so the server's same-origin checks see the page's own origin.
// `bun run dev:mock` (VITE_MOCK=1) fakes /api and one machine in the page instead (src/mock).
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: { '/api': { target: process.env.API_TARGET ?? 'http://localhost:8787', changeOrigin: false, ws: true } },
  },
  build: { target: 'safari16', outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2048 },
});
