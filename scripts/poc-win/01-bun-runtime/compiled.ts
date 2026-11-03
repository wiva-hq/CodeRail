// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import asset from './asset.txt' with { type: 'file' };
let terminalOutput = '';
const child = Bun.spawn([`${process.env.SystemRoot}\\System32\\cmd.exe`, '/d', '/c', 'chcp 65001 >nul & echo COMPILED_中文'], {
  windowsHide: true,
  terminal: { cols: 80, rows: 24, data(_term, bytes) { terminalOutput += new TextDecoder('utf-8').decode(bytes); } },
});
const code = await child.exited;
if (code !== 0 || !terminalOutput.includes('COMPILED_中文')) throw new Error('Compiled ConPTY output failed');
console.log(JSON.stringify({ version: Bun.version, asset: (await Bun.file(asset).text()).trim(), standalone: !process.env.PATH, compiledTerminal: true, argv: process.argv.slice(2) }));
