// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { win32 as p } from 'node:path';

/** Resolve the native image exactly as the pinned official npm launcher does.
 * This resolves metadata only, never evaluates codex.cmd or package JavaScript. */
export function npmCodex(packageRoot: string): string | null {
  if (!p.isAbsolute(packageRoot)) return null;
  let root: string;
  try { root = realpathSync.native(packageRoot); }
  catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  const vendor = [p.join(root, 'vendor')];
  try {
    const metadata = createRequire(p.join(root, 'package.json')).resolve('@openai/codex-win32-x64/package.json');
    vendor.unshift(p.join(p.dirname(realpathSync.native(metadata)), 'vendor'));
  } catch (error: any) {
    if (!['MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED'].includes(error.code)) throw error;
  }
  for (const base of vendor) for (const subdir of ['bin', 'codex']) {
    try {
      const exe = realpathSync.native(p.join(base, 'x86_64-pc-windows-msvc', subdir, 'codex.exe'));
      if (statSync(exe).isFile()) return exe;
    } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
  }
  return null;
}
