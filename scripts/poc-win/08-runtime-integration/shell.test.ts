// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { runWindows } from '../05-git/process';
import { defaultCommand, findExecutable, mergePath, normalizeEnvironment, userEnv, utf8 } from './shell';
import { gitInstallPaths } from '../../../bridge/src/platform/win32/registry';

baseline();
test('environment refresh adds registry PATH without losing inherited tool/proxy environment', async () => {
  const env = mergePath({ Path: 'C:\\Tools;C:\\WINDOWS', USERPROFILE: 'C:\\Users\\中文', HTTPS_PROXY: 'http://127.0.0.1:1234' }, ['c:\\windows\\;%USERPROFILE%\\bin']);
  expect(env.PATH).toBe('C:\\Tools;C:\\WINDOWS;C:\\Users\\中文\\bin');
  expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:1234');
  const actual = await userEnv(); expect(actual.HOME).toBeTruthy(); expect(actual.PATH).toBeTruthy();
  const registered = gitInstallPaths(); expect(registered.length).toBeGreaterThan(0);
  expect(registered.some(path => findExecutable(join(path, 'cmd/git.exe'), actual))).toBe(true);
});
test('native executable discovery: Unicode PATH, no cwd shadow or batch interpretation', async () => {
  const root = await mkdtemp(join(artifacts, 'shell-discovery-'));
  try {
    const bin = join(root, '工具 空格'); await mkdir(bin);
    await writeFile(join(bin, 'probe.cmd'), '@exit /b 0');
    // Discovery is independent of executable validity; launch is tested below with real binaries.
    await writeFile(join(bin, 'probe.exe'), 'discovery fixture');
    expect(findExecutable('probe', { Path: `.;relative;"${bin}"` })).toBe(join(bin, 'probe.exe'));
    expect(findExecutable('probe.cmd', { PATH: bin })).toBeNull();
    expect(findExecutable('.\\probe.exe', { PATH: bin })).toBeNull();
    expect(findExecutable('probe', { PATH: '.;relative' })).toBeNull();
    expect(() => findExecutable('bad\0.exe', {})).toThrow();
    const env = normalizeEnvironment({ Path: bin, USERPROFILE: root, BUN_BE_BUN: '1' });
    expect(env.PATH).toBe(bin); expect(env.Path).toBeUndefined(); expect(env.BUN_BE_BUN).toBeUndefined(); expect(env.HOME).toBe(root);
  } finally {
    if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
});

test('current user environment and selected PowerShell preserve UTF-8 stdin/stdout', async () => {
  const env = normalizeEnvironment(process.env);
  const command = defaultCommand(env);
  expect(command[0].toLowerCase()).toMatch(/(?:pwsh|powershell)\.exe$/);
  const result = await runWindows([command[0], '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(utf8 + '$text=[Console]::In.ReadToEnd();[Console]::Out.Write($text)', 'utf16le').toString('base64')], { input: '中文 输入😀\n' });
  expect(result.code).toBe(0); expect(result.stdout).toBe('中文 输入😀\n');
  console.log(JSON.stringify({ selectedShell: command[0], utf8RoundTrip: true }));
}, 20000);
