// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdirSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir, hostname, userInfo } from 'node:os';
import { join } from 'node:path';

/** The product version, changed by hand when there's a release to name. */
export const RELEASE = '0.0.1';
declare const CODERAIL_BUILD: string | undefined;
/** The build number: the release pipeline's run number (bun build --define), 0 for local builds. */
export const BUILD = typeof CODERAIL_BUILD === 'string' ? CODERAIL_BUILD : '0';
/** `coderail version`: both, like 0.0.1+42. The Mac app replaces the installed bridge when it differs. */
export const VERSION = `${RELEASE}+${BUILD}`;
export const HOME = homedir();
export const STATE_DIR = process.env.CODERAIL_HOME ?? join(HOME, '.coderail');
export const CONFIG_PATH = join(STATE_DIR, 'config.json');
export const LOG_PATH = join(STATE_DIR, 'bridge.log');
/** The running bridge's connection state, for the menu bar app and `coderail status`. */
export const STATE_PATH = join(STATE_DIR, 'state.json');

export type LinkState = 'connecting' | 'connected' | 'offline' | 'removed';

export function setState(state: LinkState) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(STATE_PATH, JSON.stringify({ state, at: new Date().toISOString(), pid: process.pid }) + '\n');
  } catch {}
}

/** `coderail access`'s answer, for the Mac app's permission step. */
export const ACCESS_PATH = join(STATE_DIR, 'access.json');

export function setFullDiskAccess(v: boolean | null) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(ACCESS_PATH, JSON.stringify({ fullDiskAccess: v, at: new Date().toISOString() }) + '\n');
  } catch {}
}

/**
 * Whether this process has macOS Full Disk Access (null elsewhere, or if it can't tell). Reading these needs exactly
 * that, and macOS refuses it outright rather than asking, so the check never shows a dialog.
 */
const FULL_DISK_PROBES = ['/Library/Application Support/com.apple.TCC/TCC.db', join(HOME, 'Library/Safari/Bookmarks.plist')];

export async function hasFullDiskAccess(): Promise<boolean | null> {
  if (process.platform !== 'darwin') return null;
  let refused = false;
  for (const p of FULL_DISK_PROBES) {
    try {
      await (await open(p, 'r')).close();
      return true;
    } catch (e: any) {
      if (e?.code === 'EPERM' || e?.code === 'EACCES') refused = true;
    }
  }
  return refused ? false : null;
}

export function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(' ')}`;
  console.log(line);
}

let shellEnv: Record<string, string> | null = null;

/**
 * The environment of the user's login shell. A launchd/systemd service starts with a bare PATH, so the
 * harnesses, git, node and the user's tools are found the way they are in the user's own terminal.
 */
export async function userEnv(): Promise<Record<string, string>> {
  if (shellEnv) return shellEnv;
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete base.BUN_BE_BUN;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const marker = '__CODERAIL_ENV__';
    const p = Bun.spawn([shell, '-ilc', `printf '${marker}'; env -0`], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...base, CODERAIL_PROBE: '1' },
    });
    const timer = setTimeout(() => p.kill(), 8000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    const i = out.lastIndexOf(marker);
    if (i >= 0) {
      for (const pair of out.slice(i + marker.length).split('\0')) {
        const eq = pair.indexOf('=');
        if (eq > 0) base[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
  } catch (e) {
    log('could not read the login shell environment', e);
  }
  for (const k of ['CODERAIL_PROBE', 'SHLVL', '_', 'PWD', 'OLDPWD', 'BUN_BE_BUN']) delete base[k];
  const extra = [join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const parts = (base.PATH ?? '').split(':').filter(Boolean);
  for (const e of extra) if (!parts.includes(e)) parts.push(e);
  base.PATH = parts.join(':');
  base.HOME ??= HOME;
  base.LANG ??= 'en_US.UTF-8';
  shellEnv = base;
  return base;
}

export function machineBasics() {
  return { hostname: hostname().replace(/\.local$/, ''), os: process.platform, arch: process.arch, home: HOME, user: userInfo().username };
}

export function b64(bytes: Uint8Array | string): string {
  return Buffer.from(bytes).toString('base64');
}

export class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

/** Run a program and collect its output. */
export async function run(
  cmd: string[],
  opts: { cwd?: string; timeout?: number; input?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = opts.env ?? (await userEnv());
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env,
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = opts.timeout ? setTimeout(() => p.kill(), opts.timeout) : null;
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
}
