// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { baseline, until } from '../common';
baseline();
test('Bun WebSocket close aborts a stalled upgrade without waiting for TCP timeout', async () => {
  let requests = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() { requests++; return new Promise<Response>(() => {}); } });
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`); let closed = false;
  socket.onclose = () => { closed = true; }; socket.onerror = () => {};
  try {
    await until(() => requests === 1); expect(socket.readyState).toBe(WebSocket.CONNECTING);
    const start = performance.now(); socket.close(); await until(() => closed, 2000, 'pending handshake aborted');
    expect(performance.now() - start).toBeLessThan(2000);
  } finally { socket.close(); server.stop(true); }
}, 10000);
