// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Caller } from '../../../protocol/src';
import * as git from '../../../bridge/src/git';
import { createWindowsAdapter } from '../../../bridge/src/platform/win32';
import { artifacts, baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';

baseline();
test('production Git RPC and native process adapter: Chinese CRLF diff, stage and commit without injected dependencies', async () => {
  const root = await mkdtemp(join(artifacts, 'git-native-rpc-')), previous = process.env.CODERAIL_HOME;
  process.env.CODERAIL_HOME = join(root, 'runtime-state');
  const win = createWindowsAdapter(), caller: Caller = { userId: 'gate', username: 'gate', role: 'owner', terminal: true, folders: [root], harnesses: null };
  try {
    const executable = await win.git.executable!(), env = win.git.environment(await win.shell.userEnv());
    for (const args of [['init'], ['config', 'user.name', 'Windows Gate'], ['config', 'user.email', 'gate@localhost'], ['config', 'core.autocrlf', 'true']]) {
      expect((await win.process.run([executable, ...args], { cwd: root, env })).code).toBe(0);
    }
    const name = '中文 空格.txt'; await writeFile(join(root, name), '第一行\r\n第二行\r\n');
    await git.stage({ cwd: root, paths: [name] }, caller); await git.commit({ cwd: root, message: '初始 中文😀' }, caller);
    await writeFile(join(root, name), '第一行\r\n第二行 已修改😀\r\n');
    const status = await git.status({ cwd: root }, caller); expect(status?.files.some(file => file.path === name)).toBe(true);
    const diff = await git.diff({ cwd: root, path: name }, caller); expect(diff.diff).toContain('+第二行 已修改😀'); expect(diff.diff).not.toContain('-第一行');
    await git.stage({ cwd: root, paths: [name] }, caller); const commit = await git.commit({ cwd: root, message: '正式 RPC 提交😀' }, caller);
    expect(commit.hash).toMatch(/^[a-f0-9]{40}$/); expect((await git.log({ cwd: root, limit: 1 }, caller))[0].subject).toBe('正式 RPC 提交😀');
    expect((await git.status({ cwd: root }, caller))?.files.filter(file => file.path === name)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CODERAIL_HOME; else process.env.CODERAIL_HOME = previous;
    if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
}, 60000);
