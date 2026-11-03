// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { realpath } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { win32 as p } from 'node:path';

export function error(code: string, message: string) { return Object.assign(new Error(message), { code }); }
/** Only ordinary absolute DOS/UNC paths. Device names and NT namespaces are not files. */
export function normalize(input: string): string {
  if (!input || input.includes('\0')) throw error('EINVAL', 'An absolute Windows path is required');
  let path = input.replaceAll('/', '\\');
  if (/^\\\\\?\\UNC\\/i.test(path)) path = '\\\\' + path.slice(8);
  else if (/^\\\\\?\\[a-z]:\\/i.test(path)) path = path.slice(4);
  else if (/^\\\\[?.]\\/.test(path)) throw error('EINVAL', 'Device namespace is forbidden');
  if (!/^[a-z]:\\/i.test(path) && !/^\\\\[^\\]+\\[^\\]+(?:\\|$)/.test(path)) throw error('EINVAL', 'Drive-relative and root-relative paths are forbidden');
  const root = p.parse(path).root;
  for (const part of path.slice(root.length).split('\\')) {
    if (!part || part === '.' || part === '..') continue;
    if (/[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)) throw error('EINVAL', 'Ambiguous Windows filename / alternate data stream');
  }
  return p.normalize(path);
}
export function contains(root: string, path: string) {
  const relative = p.relative(normalize(root).toLowerCase(), normalize(path).toLowerCase());
  return relative === '' || (relative !== '..' && !relative.startsWith('..\\') && !p.isAbsolute(relative));
}
/** Authorization only: BOTH operands must already be canonicalized by native
 * realpath (or have a canonical existing parent). Never Unicode-case-fold
 * physical directory names: JS lowercase can merge distinct NTFS objects. */
export function containsCanonical(root: string, candidate: string) {
  const a = normalize(root), b = normalize(candidate);
  if (a.startsWith('\\\\') !== b.startsWith('\\\\')) return false;
  const parts = (path: string) => path.split('\\').filter(Boolean).map((part, i) => i === 0 && /^[a-z]:$/i.test(part) ? part.toUpperCase() : part);
  const parent = parts(a), child = parts(b);
  return parent.length <= child.length && parent.every((part, i) => part === child[i]);
}
export function nativeRealpath(path: string): Promise<string> {
  return new Promise((resolve, reject) => realpath.native(path, (e, value) => e ? reject(e) : resolve(normalize(value))));
}
export async function canonicalize(input: string, intent: 'existing' | 'create' = 'existing'): Promise<string> {
  const path = normalize(input);
  try { return await nativeRealpath(path); }
  catch (cause: any) {
    if (intent !== 'create' || cause.code !== 'ENOENT') throw cause;
    const entry = await lstat(path).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
    if (entry?.isSymbolicLink()) throw error('EACCES', 'Dangling reparse point');
    const parent = p.dirname(path);
    if (parent === path) throw cause;
    const resolved = await canonicalize(parent, 'create');
    const parentEntry = await stat(resolved).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
    if (parentEntry && !parentEntry.isDirectory()) throw error('ENOTDIR', 'Parent is not a directory');
    return p.join(resolved, p.basename(path));
  }
}
export async function retry<T>(operation: () => Promise<T>, onRetry?: (attempt: number, cause: unknown) => void): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (e: any) {
      if (!['EBUSY', 'EPERM', 'EACCES'].includes(e.code) || attempt >= 4) throw e;
      onRetry?.(attempt + 1, e);
      await Bun.sleep(Math.min(50 * 2 ** attempt, 200));
    }
  }
}
