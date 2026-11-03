// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { STATE_DIR } from './env';

declare global { var __CODERAIL_BROWSER__: { archive: string; hash: string } | undefined; }

export async function browserRuntime(): Promise<string> {
  const app = join(dirname(process.execPath), '../Resources/browser');
  if (existsSync(join(app, 'camoufox/version.json'))) return app;
  const bundled = globalThis.__CODERAIL_BROWSER__;
  if (!bundled) {
    const target = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`;
    const development = join(import.meta.dir, '../.cache/browser/1.18.1-152.0.4-beta.30-1', target, 'runtime');
    if (existsSync(join(development, 'camoufox/version.json'))) return development;
    throw new Error('The bundled browser is missing. Build the bridge before running it.');
  }
  const dir = join(STATE_DIR, 'browser/runtime', bundled.hash);
  if (existsSync(join(dir, 'ready'))) { prune(dir); return dir; }
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const tmp = dir + '.tmp';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const archive = dir + '.tar.gz';
  await Bun.write(archive, Bun.file(bundled.archive));
  try {
    // (Windows's own bsdtar: a GNU tar earlier on PATH, such as Git's, reads `C:` as a remote host.)
    const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
    const p = Bun.spawn([tar, '-xzf', archive, '-C', tmp], { stdout: 'ignore', stderr: 'pipe', windowsHide: true });
    const error = await new Response(p.stderr).text();
    if (await p.exited !== 0) throw new Error(`Could not open the bundled browser: ${error.trim()}`);
    await Bun.write(join(tmp, 'ready'), '1');
    renameSync(tmp, dir);
  } finally { rmSync(archive, { force: true }); rmSync(tmp, { recursive: true, force: true }); }
  prune(dir);
  return dir;
}

/** Earlier builds' runtimes (about 1 GB each): only this build's stays. A file still open (Windows) waits for the next start. */
function prune(dir: string) {
  for (const name of readdirSync(dirname(dir))) {
    if (name === basename(dir)) continue;
    try { rmSync(join(dirname(dir), name), { recursive: true, force: true }); } catch {}
  }
}
