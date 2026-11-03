// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { artifacts, baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { deployBinary, guardInstallationRoot, readInstallation } from './install-files';

baseline();
test('file deployment preserves ownership, is repeatable, and refuses user/profile directories before changing them', async () => {
  const root = await mkdtemp(join(artifacts, 'install-files-'));
  try {
    const source = join(root, 'source.exe'), target = join(root, 'CodeRail');
    // File deployment primitive only; this fixture is never executed.
    const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(0x80,0x3c); bytes.writeUInt32LE(0x4550,0x80); bytes.writeUInt16LE(0x8664,0x84); await writeFile(source, bytes);
    const first = await deployBinary(target, source, '0.0.1+1'); expect(await readFile(first.executable)).toEqual(bytes);
    expect(readInstallation(target)).toEqual(first);
    const again = await deployBinary(target, first.executable, '0.0.1+1'); expect(again.id).toBe(first.id); expect(again.sha256).toBe(first.sha256);
    const user = join(root, 'personal'); await mkdir(user); await writeFile(join(user, 'personal.txt'), 'untouched');
    await expect(guardInstallationRoot(user)).rejects.toMatchObject({ code: 'EEXIST' }); expect(await readFile(join(user, 'personal.txt'), 'utf8')).toBe('untouched');
    await expect(guardInstallationRoot(homedir())).rejects.toMatchObject({ code: 'EACCES' });
  } finally { if (!contains(artifacts, root)) throw new Error('Unsafe cleanup'); await retry(() => rm(root, { recursive: true })); }
});
