// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Caller, ERR, inFolders } from '@coderail/protocol';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { HOME, RpcError, STATE_DIR } from './env';

function expand(p: string): string {
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return join(HOME, p.slice(2));
  return p;
}

const PERMISSION_WAIT = 20_000;

/**
 * A file-system step that may wait on macOS: reaching a protected folder (Desktop, Documents, Downloads, other
 * volumes) without Full Disk Access holds the call until someone answers a permission dialog on the machine. It
 * runs off the main thread, so the bridge keeps answering, and gives up with a plain reason after a while.
 */
export function guarded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RpcError(ERR.forbidden, 'macOS is waiting for permission on this computer: give coderail Full Disk Access in System Settings › Privacy & Security, or answer the dialog there.')),
      PERMISSION_WAIT,
    );
  });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/** The real path of p, or of its nearest existing parent with the rest appended (for things not made yet). */
async function real(p: string): Promise<string> {
  try {
    return await guarded(realpath(p));
  } catch (e) {
    if (e instanceof RpcError) throw e;
    const parent = dirname(p);
    if (parent === p) return p;
    return join(await real(parent), basename(p));
  }
}

/** The caller's folders as real absolute paths, or null for anywhere. */
export async function callerFolders(caller: Caller): Promise<string[] | null> {
  if (!caller.folders) return null;
  return Promise.all(caller.folders.map((f) => real(resolve(expand(f)))));
}

/**
 * Resolve a path a client named and check the caller may touch it: absolute (or ~), links followed,
 * inside the caller's folders, and never CodeRail's own state folder (it holds the machine's token).
 */
export async function checkPath(p: unknown, caller: Caller): Promise<string> {
  if (typeof p !== 'string' || !p) throw new RpcError(ERR.invalid, 'A path is needed');
  const e = expand(p);
  if (!isAbsolute(e)) throw new RpcError(ERR.invalid, 'Paths are absolute');
  const r = await real(resolve(e));
  const state = await real(STATE_DIR);
  if (r === state || r.startsWith(state + '/')) throw new RpcError(ERR.forbidden, "CodeRail's own folder is off limits");
  if (!inFolders(r, await callerFolders(caller))) throw new RpcError(ERR.forbidden, 'That path is outside your folders');
  return r;
}

/**
 * A path a client means to create or change: checkPath, and never through a link that points nowhere yet (it
 * would be made wherever the link points, past the folder check). For a caller limited to some folders, never
 * inside a repository's .git either: its config and hooks are commands git runs.
 */
export async function checkWrite(p: unknown, caller: Caller): Promise<string> {
  const r = await checkPath(p, caller);
  const l = await lstat(r).catch(() => null);
  if (l?.isSymbolicLink()) throw new RpcError(ERR.forbidden, 'That is a link to somewhere that does not exist');
  if (caller.folders && r.split('/').some((s) => s.toLowerCase() === '.git')) throw new RpcError(ERR.forbidden, "A repository's .git folder is off limits");
  return r;
}
