// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
const readline = require('node:readline');
let tick = 0;
const out = text => process.stdout.write(text + '\r\n');
setInterval(() => out('\x1b[31m持续中文😀' + (++tick) + '\x1b[0m'), 100);
readline.createInterface({ input: process.stdin, terminal: false }).on('line', line => {
  if (line === 'SIZE') {
    const size = process.stdout.getWindowSize ? process.stdout.getWindowSize() : [process.stdout.columns, process.stdout.rows];
    out('SIZE=' + size[0] + 'x' + size[1]);
  }
  else if (line === 'EXIT') process.exit(0);
  else out('ROUNDTRIP=' + line);
});
