// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, baseline } from '../common';
import { NativeFile } from './native';
import { contains } from './paths';

baseline();
test('observational no-follow file handles allow external in-place writes; replacement succeeds after release', async () => {
  const dir = await mkdtemp(join(artifacts, 'nt-observation-')), path = join(dir, 'hot.txt');
  await writeFile(path, 'before'); const parent = new NativeFile(dir, true), file = parent.child('hot.txt', false, false, false, 7);
  parent.close(); // Isolate the observer's file-sharing policy from directory capability locks.
  try {
    await writeFile(path, 'after');
    expect(file.read(dir, 1024).toString('utf8')).toBe('after');
    file.close();
    // MoveFileEx replacement on this host still rejects a live destination
    // handle. The bridge's atomic replacement uses bounded native retries.
    await writeFile(join(dir, 'replacement.txt'), 'replacement'); await rename(join(dir, 'replacement.txt'), path);
    expect(await readFile(path, 'utf8')).toBe('replacement');
  } finally {
    file.close(); parent.close();
    if (!contains(artifacts, dir)) throw new Error('Unsafe test cleanup'); await rm(dir, { recursive: true });
  }
});
test('NT handle-relative create/rename cannot be redirected by a swapped parent Junction', async () => {
  const dir = await mkdtemp(join(artifacts, 'nt-relative-'));
  const parent = join(dir, 'parent'), moved = join(dir, 'original-parent'), outside = join(dir, 'outside');
  await mkdir(parent); await mkdir(outside); await writeFile(join(outside, 'target.txt'), 'outside must survive');
  // Allow parent renaming here to deliberately test the relative-handle fallback.
  const lease = new NativeFile(parent, true, false, undefined, 7);
  try {
    await rename(parent, moved);
    await symlink(outside, parent, 'junction');
    const file = lease.child('temp.txt', false, true, true);
    try { file.write(Buffer.from('owned 中文😀', 'utf8')); file.renameTo(lease, 'target.txt', true); }
    finally { file.close(); }
    expect(await readFile(join(moved, 'target.txt'), 'utf8')).toBe('owned 中文😀');
    expect(await readFile(join(outside, 'target.txt'), 'utf8')).toBe('outside must survive');
    const link = new NativeFile(dir, true);
    try { expect(() => link.child('parent', true)).toThrow('Reparse point'); } finally { link.close(); }
  } finally {
    lease.close();
    if (!contains(artifacts, dir) || !dir.includes('nt-relative-')) throw new Error('Unsafe test cleanup');
    await rm(dir, { recursive: true });
  }
});
