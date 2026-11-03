// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { desktopCodex } from './desktop-codex';
import { artifacts, baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { findExecutable } from './shell';

baseline();
test('desktop Codex discovery works without injected PATH, filters architecture and missing runtimes', async () => {
  const root = await mkdtemp(join(artifacts, 'desktop-codex-'));
  try {
    const x64 = join(root, 'OpenAI/Codex/bin/0123456789abcdef/codex.exe'), arm = join(root, 'OpenAI/Codex/bin/abcdef0123456789/codex.exe');
    for (const [path, machine] of [[x64, 0x8664], [arm, 0xaa64]] as const) {
      await mkdir(join(path, '..'), { recursive: true });
      const bytes = Buffer.alloc(256); bytes.writeUInt16LE(0x5a4d, 0); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(machine, 0x84); await writeFile(path, bytes);
    }
    expect(desktopCodex(root)).toBe(x64); expect(desktopCodex(join(root, 'missing'))).toBeNull(); expect(desktopCodex('relative')).toBeNull();
    expect(findExecutable('codex', { PATH: '', HOME: root, LOCALAPPDATA: root })).toBe(x64);
    expect(findExecutable('codex', { PATH: '', CODEX_PATH: x64 })).toBe(x64);
  } finally { if (!contains(artifacts, root)) throw new Error('Unsafe cleanup'); await retry(() => rm(root, { recursive: true })); }
});
