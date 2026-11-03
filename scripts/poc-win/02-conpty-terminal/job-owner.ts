// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Deliberately terminated by its parent to verify kernel-driven Job cleanup.
import { spawnNative, quote } from './win32';
import { ps, encoded } from '../common';
import { join } from 'node:path';
const [pidFile, readyFile] = process.argv.slice(2);
const child = spawnNative([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(`& ${quote(process.env.POC_NODE_PATH!)} ${quote(join(import.meta.dir, 'tree-child.cjs'))} ${quote(pidFile)}`)], { cwd: import.meta.dir, job: true });
await Bun.write(readyFile, JSON.stringify({ ownerPid: process.pid, rootPid: child.pid }));
setInterval(() => {}, 1000);
