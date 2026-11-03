// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
process.stdout.write('FFI_READY中文😀\r\n');
require('node:readline').createInterface({ input: process.stdin, terminal: false }).on('line', line => {
  process.stdout.write('ROUNDTRIP=' + line + '\r\n');
  if (line === 'SIZE') { const size = process.stdout.getWindowSize?.() ?? []; process.stdout.write('SIZE=' + size.join('x') + '\r\n'); }
});
setInterval(() => {}, 1000);
