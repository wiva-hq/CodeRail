// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
export {};
const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('中文状态😀') });
await Bun.write(process.argv[2], JSON.stringify({ pid: process.pid, port: server.port }));
