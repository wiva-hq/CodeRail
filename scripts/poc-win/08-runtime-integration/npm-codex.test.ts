// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { artifacts, baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { npmCodex } from './npm-codex';
import { runWindows } from '../05-git/process';
import { findExecutable } from './shell';

baseline();
test('pinned npm Codex resolves a native executable through package-manager Junctions without executing a shim', async () => {
  const root = await mkdtemp(join(artifacts, 'npm-codex-'));
  try {
    const acp = Bun.resolveSync('@agentclientprotocol/codex-acp', join(import.meta.dir, '../../../bridge'));
    const wrapper = Bun.resolveSync('@openai/codex/bin/codex.js', acp), actual = realpathSync.native(join(dirname(wrapper), '..'));
    const installed = join(root, '全局 npm'); await symlink(actual, installed, 'junction');
    const executable = npmCodex(installed); expect(executable).toBeTruthy(); expect(executable).toMatch(/codex\.exe$/);
    const prefix = join(root, 'npm-prefix'); await mkdir(join(prefix, 'node_modules/@openai'), { recursive: true });
    await symlink(actual, join(prefix, 'node_modules/@openai/codex'), 'junction');
    expect(findExecutable('codex', { PATH: prefix })).toBe(executable);
    const version = await runWindows([executable!, '--version']); expect(version.code).toBe(0); expect(version.stdout).toContain('0.160.1');
    expect(npmCodex(join(root, 'not-installed'))).toBeNull();
    console.log(JSON.stringify({ npmNativeVersion: version.stdout.trim(), cmdShimExecuted: false }));
  } finally { if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup'); await retry(() => rm(root, { recursive: true })); }
}, 30000);
