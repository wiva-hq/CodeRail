// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { closeSync, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { win32 as p } from 'node:path';

/** Explorer-logon environments do not contain paths injected by the Codex app.
 * Probe the observed per-user desktop runtime layout, retaining x64 only. */
export function desktopCodex(localAppData: string | undefined): string | null {
  if (!localAppData || !p.isAbsolute(localAppData)) return null;
  const root = p.join(localAppData, 'OpenAI/Codex/bin'); let directories: string[];
  try { directories = readdirSync(realpathSync.native(root), { withFileTypes: true }).filter(item => item.isDirectory() && /^[a-f0-9]{8,64}$/i.test(item.name)).map(item => item.name); }
  catch (error: any) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null; throw error; }
  const candidates: { path: string; modified: number }[] = [];
  for (const directory of directories) {
    let fd: number | undefined;
    try {
      const path = realpathSync.native(p.join(root, directory, 'codex.exe')), info = statSync(path);
      if (!info.isFile() || info.size < 64) continue;
      fd = openSync(path, 'r'); const dos = Buffer.alloc(64); readSync(fd, dos, 0, dos.length, 0);
      if (dos.readUInt16LE(0) !== 0x5a4d) continue;
      const offset = dos.readUInt32LE(0x3c); if (offset + 6 > info.size) continue;
      const pe = Buffer.alloc(6); readSync(fd, pe, 0, pe.length, offset);
      if (pe.readUInt32LE(0) === 0x4550 && pe.readUInt16LE(4) === 0x8664) candidates.push({ path, modified: info.mtimeMs });
    } catch (error: any) { if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error; }
    finally { if (fd !== undefined) closeSync(fd); }
  }
  return candidates.sort((a, b) => b.modified - a.modified || a.path.localeCompare(b.path))[0]?.path ?? null;
}
