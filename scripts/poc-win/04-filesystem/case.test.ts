// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, baseline } from '../common';
import { contains, retry } from './paths';
import * as files from '../../../bridge/src/files';
import { ERR, type Caller } from '../../../protocol/src';
import { checkPath } from '../../../bridge/src/scope';
import { ScopedWindowsFs } from './fs';

baseline();

test('stat distinguishes physical Unicode sibling files with identical JavaScript lowercase', async () => {
  const root = await mkdtemp(join(artifacts, 'unicode-stat-'));
  const scope = await ScopedWindowsFs.create(root);
  try {
    const first = join(root, '\u0130.txt'), second = join(root, 'i\u0307.txt');
    await scope.write(first, Buffer.from('a')); await scope.write(second, Buffer.from('1234567890'));
    expect((await scope.stat(first)).size).toBe(1); expect((await scope.stat(second)).size).toBe(10);
  } finally { scope.close(); if (!contains(artifacts, root)) throw new Error('Unsafe cleanup'); await retry(() => rm(root, { recursive: true })); }
});
test('native case oracle: .git aliases stay protected while distinct Unicode names remain ordinary folders', async () => {
  const root = await mkdtemp(join(artifacts, 'unicode-case-')), oracle = join(root, 'oracle'), allowed = join(root, 'allowed');
  await mkdir(oracle); await mkdir(allowed); await mkdir(join(oracle, '.git'));
  const caller: Caller = { userId: 'case', username: 'case', role: 'owner', terminal: true, folders: [allowed], harnesses: null };
  try {
    const observed: Record<string, boolean> = {};
    for (const name of ['.GIT', '.Git', '.g\u0131t']) {
      let aliases = false;
      try { aliases = !!realpathSync.native(join(oracle, name)); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      observed[name] = aliases;
      if (aliases) await expect(files.makeDir({ path: join(allowed, name) }, caller)).rejects.toMatchObject({ code: ERR.forbidden });
      else expect((await files.makeDir({ path: join(allowed, name) }, caller)).name).toBe(name);
    }
    console.log(JSON.stringify({ nativeGitAliases: observed }));
  } finally { if (!contains(artifacts, root)) throw new Error('Unsafe cleanup'); await retry(() => rm(root, { recursive: true })); }
});

test('distinct physical Unicode directories with identical JavaScript lowercase cannot cross caller scope', async () => {
  const root = await mkdtemp(join(artifacts, 'unicode-scope-')), allowed = join(root, '\u0130-project'), outside = join(root, 'i\u0307-project');
  await mkdir(allowed); await mkdir(outside);
  try {
    expect(realpathSync.native(allowed)).not.toBe(realpathSync.native(outside));
    expect(allowed.toLowerCase()).toBe(outside.toLowerCase());
    const caller: Caller = { userId: 'case', username: 'case', role: 'owner', terminal: true, folders: [allowed], harnesses: null };
    await expect(checkPath(outside, caller)).rejects.toMatchObject({ code: ERR.forbidden });
    const path = join(allowed, '文件😀.txt');
    await files.write({ path, content: 'inside only' }, caller);
    expect((await files.read({ path }, caller)).content).toBe('inside only');
  } finally { if (!contains(artifacts, root)) throw new Error('Unsafe cleanup'); await retry(() => rm(root, { recursive: true })); }
});
