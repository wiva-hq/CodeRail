// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { encoded, ps } from '../common';
import { quote } from './win32';
const [pidFile, readyFile] = process.argv.slice(2);
const command = `& ${quote(process.env.POC_NODE_PATH!)} ${quote(join(import.meta.dir, 'tree-child.cjs'))} ${quote(pidFile)}`;
const child = Bun.spawn([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(command)], { windowsHide: true, terminal: { cols: 80, rows: 24, data() {} } });
await Bun.write(readyFile, JSON.stringify({ workerPid: process.pid, terminalPid: child.pid }));
await child.exited;
