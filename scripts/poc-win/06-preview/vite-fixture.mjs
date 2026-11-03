// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const [modulePath, root, ready] = process.argv.slice(2);
const { createServer } = await import(pathToFileURL(modulePath).href);
const server = await createServer({ root, configFile: false, logLevel: 'error', server: { host: '127.0.0.1', port: 0, allowedHosts: true } });
await server.listen();
writeFileSync(ready, JSON.stringify({ pid: process.pid, port: server.httpServer.address().port, token: server.config.webSocketToken }), 'utf8');
