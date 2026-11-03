// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const [pidFile, level = '0'] = process.argv.slice(2);
fs.appendFileSync(pidFile, JSON.stringify({ pid: process.pid, ppid: process.ppid, level }) + '\n', 'utf8');
const child = level === '0'
  ? spawn(process.execPath, [__filename, pidFile, '1'], { windowsHide: true, stdio: 'ignore' })
  : spawn('ping.exe', ['-t', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
fs.appendFileSync(pidFile, JSON.stringify({ pid: child.pid, ppid: process.pid, level: Number(level) + 1 }) + '\n', 'utf8');
setInterval(() => {}, 1000);
