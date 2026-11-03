// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { writeFileSync } from 'node:fs';
import { hostname, userInfo } from 'node:os';
import { join } from 'node:path';
import { platform } from './platform';

/** The product version, changed by hand when there's a release to name. */
export const RELEASE = '0.0.1';
declare const CODERAIL_BUILD: string | undefined;
/** The build number: the release pipeline's run number (bun build --define), 0 for local builds. */
export const BUILD = typeof CODERAIL_BUILD === 'string' ? CODERAIL_BUILD : '0';
/** `coderail version`: both, like 0.0.1+42. The Mac app replaces the installed bridge when it differs. */
export const VERSION = `${RELEASE}+${BUILD}`;
export const HOME = platform.path.home();
export const STATE_DIR = platform.path.stateDir();
export const CONFIG_PATH = join(STATE_DIR, 'config.json');
export const LOG_PATH = join(STATE_DIR, 'bridge.log');
/** The running bridge's connection state, for the menu bar app and `coderail status`. */
export const STATE_PATH = join(STATE_DIR, 'state.json');

export type LinkState = 'connecting' | 'connected' | 'offline' | 'removed';

export function setState(state: LinkState) {
  try {
    platform.fs.ensurePrivateDirectory(STATE_DIR);
    writeFileSync(STATE_PATH, JSON.stringify({ state, at: new Date().toISOString(), pid: process.pid, version: VERSION }) + '\n');
  } catch {}
}

/** `coderail access`'s answer, for the Mac app's permission step. */
export const ACCESS_PATH = join(STATE_DIR, 'access.json');

export function setFullDiskAccess(v: boolean | null) {
  try {
    platform.fs.ensurePrivateDirectory(STATE_DIR);
    writeFileSync(ACCESS_PATH, JSON.stringify({ fullDiskAccess: v, at: new Date().toISOString() }) + '\n');
  } catch {}
}

/**
 * Whether this process has macOS Full Disk Access (null elsewhere, or if it can't tell). Reading these needs exactly
 * that, and macOS refuses it outright rather than asking, so the check never shows a dialog.
 */
export const hasFullDiskAccess = () => platform.fs.hasFullDiskAccess();

export function log(...args: unknown[]) {
  const line = `[${new Date().toISOString()}] ${args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a))).join(' ')}`;
  console.log(line);
}

export const userEnv = platform.shell.userEnv;

export function machineBasics() {
  return { hostname: hostname().replace(/\.local$/, ''), os: process.platform, arch: process.arch, home: platform.os === 'win32' ? HOME.replaceAll('\\', '/') : HOME, user: userInfo().username };
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
export const run = platform.process.run;
