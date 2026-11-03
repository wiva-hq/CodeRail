// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, realpathSync } from 'node:fs';
import { win32 as p } from 'node:path';
import { NativeFile } from './native';
import { error } from './paths';
import { ensurePrivateDirectory, writePrivateFile } from './private-fs';
import { guardInstallationRoot, readInstallation } from './install-files';

export interface UpdateArtifact { version: string; sha256: string; size: number }
const maximum = 1024 * 1024 * 1024;
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');

/** File-only PoC: verify a downloaded artifact before staging. Never switches a running installation. */
export async function stageUpdate(input: string, download: string, expected: UpdateArtifact) {
  if (!/^\d+\.\d+\.\d+\+\d+$/.test(expected.version) || !/^[a-f0-9]{64}$/.test(expected.sha256)
    || !Number.isSafeInteger(expected.size) || expected.size < 64 || expected.size > maximum) throw error('EINVAL', 'Invalid Windows update manifest');
  const root = await guardInstallationRoot(input), installed = readInstallation(root);
  if (!installed) throw error('EACCES', 'An owned installation is required before staging an update');
  const source = new NativeFile(realpathSync.native(download), false);
  let bytes: Buffer;
  try {
    if (source.details().size !== expected.size) throw error('EINVAL', 'Update size mismatch');
    bytes = source.read(p.dirname(realpathSync.native(download)), expected.size);
  } finally { source.close(); }
  if (digest(bytes) !== expected.sha256) throw error('EINVAL', 'Update SHA256 mismatch');
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a || pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550
    || bytes.readUInt16LE(pe + 4) !== 0x8664) throw error('EINVAL', 'Update is not a Windows x64 executable');
  const directory = p.join(root, 'updates', expected.sha256);
  ensurePrivateDirectory(directory);
  const executable = p.join(directory, 'coderail.exe');
  if (existsSync(executable)) {
    const parent = new NativeFile(directory, true);
    try {
      const file = parent.child('coderail.exe', false);
      try {
        if (file.details().size !== expected.size || digest(file.read(directory, expected.size)) !== expected.sha256) throw error('EACCES', 'Previously staged update was modified');
      }
      finally { file.close(); }
    } finally { parent.close(); }
  } else writePrivateFile(executable, bytes);
  return { installationId: installed.id, previous: installed.executable, executable, ...expected };
}
