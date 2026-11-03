// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { ps, encoded } from '../common';
const config = await Bun.file(process.argv[2]).json();
const quote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
const argv = [config.node, join(import.meta.dir, 'vite-fixture.mjs'), config.vite, config.root, config.ready];
const decoder = new TextDecoder('utf-8');
const child = Bun.spawn([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded('& ' + argv.map(quote).join(' '))], {
  cwd: config.root, windowsHide: true,
  terminal: { cols: 100, rows: 30, data(_term, bytes) { process.stdout.write(decoder.decode(bytes, { stream: true })); } },
});
await Bun.write(config.terminalReady, JSON.stringify({ workerPid: process.pid, shellPid: child.pid }));
await child.exited;
