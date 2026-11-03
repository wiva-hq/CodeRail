// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A machine's system and a folder in words.
export function osName(os?: string) {
  return os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os === 'win32' ? 'Windows' : os ?? '';
}
/** A path with the home folder as ~. */
export function tilde(path: string, home?: string | null) {
  const value = slash(path), base = home ? slash(home).replace(/\/+$/, '') : null;
  const compare = (s: string) => windows(path) ? s.toLowerCase() : s;
  if (base && (compare(value) === compare(base) || compare(value).startsWith(compare(base) + '/'))) return '~' + value.slice(base.length);
  return path;
}
const windows = (path: string) => /^[a-z]:[\\/]/i.test(path) || path.startsWith('\\\\') || /^\/\/[^/]+\/[^/]+/.test(path);
const slash = (path: string) => windows(path) ? path.replaceAll('\\', '/') : path;
function rootOf(path: string) { return path.match(/^[a-z]:\//i)?.[0] ?? path.match(/^\/\/[^/]+\/[^/]+(?:\/|$)/)?.[0].replace(/\/$/, '') ?? '/'; }
/** A typed path with ~ as the home folder → the full path. */
export function untilde(path: string, home?: string | null) {
  if (!home) return path;
  return path === '~' ? home : path.startsWith('~/') ? home + path.slice(1) : path;
}
/** The last part of a path ("/Users/me/app" → "app"). */
export function baseName(path: string) {
  const p = slash(path).replace(/\/+$/, '');
  return p.slice(p.lastIndexOf('/') + 1) || p || '/';
}
export function parentOf(path: string) {
  const value = slash(path), root = rootOf(value);
  const p = value.replace(/\/+$/, '');
  if (windows(path) && p.length <= root.replace(/\/$/, '').length) return root;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i).length < root.length ? root : p.slice(0, i);
}
export function join(a: string, b: string) { return slash(a).replace(/\/+$/, '') + '/' + (windows(a) ? b.replaceAll('\\', '/') : b).replace(/^\/+/, ''); }
