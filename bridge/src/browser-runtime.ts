// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { STATE_DIR } from './env';

declare global { var __CODERAIL_BROWSER__: { archive: string; hash: string } | undefined; }

export async function browserRuntime(): Promise<string> {
  const app = join(dirname(process.execPath), '../Resources/browser');
  if (existsSync(join(app, 'camoufox/version.json'))) return app;
  const bundled = globalThis.__CODERAIL_BROWSER__;
  if (!bundled) {
    const development = join(import.meta.dir, '../.cache/browser/1.18.1-152.0.4-beta.30-1', `${process.platform}-${process.arch}`, 'runtime');
    if (existsSync(join(development, 'camoufox/version.json'))) return development;
    throw new Error('The bundled browser is missing. Build the bridge before running it.');
  }
  const dir = join(STATE_DIR, 'browser/runtime', bundled.hash);
  if (existsSync(join(dir, 'ready'))) return dir;
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  const tmp = dir + '.tmp';
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const archive = dir + '.tar.gz';
  await Bun.write(archive, Bun.file(bundled.archive));
  try {
    const p = Bun.spawn(['tar', '-xzf', archive, '-C', tmp], { stdout: 'ignore', stderr: 'pipe' });
    const error = await new Response(p.stderr).text();
    if (await p.exited !== 0) throw new Error(`Could not open the bundled browser: ${error.trim()}`);
    await Bun.write(join(tmp, 'ready'), '1');
    renameSync(tmp, dir);
  } finally { rmSync(archive, { force: true }); rmSync(tmp, { recursive: true, force: true }); }
  return dir;
}
