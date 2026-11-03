// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { cmd, until, assert, killTree } from '../common';
const require = createRequire(import.meta.url);
const pty = require('node-pty');
const p = pty.spawn(cmd, ['/Q', '/K', 'chcp 65001 >nul'], { cols: 80, rows: 24, cwd: import.meta.dir, env: process.env, useConpty: true });
let output = '';
p.onData((data: string) => { output += data; });
try {
  p.write('echo NODEPTY_中文😀\r');
  await until(() => output.includes('NODEPTY_中文😀'), 10000);
  p.resize(120, 40);
  assert(output.includes('中文😀'));
  console.log(JSON.stringify({ runtime: process.versions.bun ? `bun ${Bun.version}` : `node ${process.version}`, pid: p.pid, chinese: true, resizeNoCrash: true }));
} finally { await killTree(p.pid); p.kill(); }
