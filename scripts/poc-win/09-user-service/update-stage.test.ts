// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { appendFile, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { deployBinary, readInstallation } from './install-files';
import { stageUpdate } from './update-stage';

baseline();
test('update staging rejects corrupt/wrong-architecture packages and preserves current installation', async () => {
  const root = await mkdtemp(join(artifacts, 'update-stage-'));
  try {
    const source = join(root, 'download.exe'), target = join(root, 'CodeRail');
    // Synthetic PE is only a file-validation fixture; never executed.
    const bytes = Buffer.alloc(512); bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84);
    await writeFile(source, bytes); const installed = await deployBinary(target, source, '0.0.1+1');
    bytes[511] = 42; await writeFile(source, bytes);
    const manifest = { version: '0.0.1+2', size: bytes.length, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') };
    await expect(stageUpdate(target, source, { ...manifest, sha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'EINVAL' });
    expect(await readdir(target)).not.toContain('updates');
    const staged = await stageUpdate(target, source, manifest);
    expect(await readFile(staged.executable)).toEqual(bytes);
    expect(await stageUpdate(target, source, manifest)).toEqual(staged);
    expect(readInstallation(target)).toEqual(installed);
    expect((await readFile(installed.executable))[511]).toBe(0);
    await appendFile(staged.executable, 'untrusted overlay');
    await expect(stageUpdate(target, source, manifest)).rejects.toMatchObject({ code: 'EACCES' });
    await writeFile(staged.executable, 'tampered');
    await expect(stageUpdate(target, source, manifest)).rejects.toMatchObject({ code: 'EACCES' });
    bytes.writeUInt16LE(0xaa64, 0x84); await writeFile(source, bytes);
    await expect(stageUpdate(target, source, { ...manifest, sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') })).rejects.toMatchObject({ code: 'EINVAL' });
  } finally {
    if (!contains(artifacts, root)) throw new Error('Unsafe cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
});
