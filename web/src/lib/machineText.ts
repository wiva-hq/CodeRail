// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A machine's system and a folder in words.
export function osName(os?: string) {
  return os === 'darwin' ? 'macOS' : os === 'linux' ? 'Linux' : os === 'win32' ? 'Windows' : os ?? '';
}
/** A path with the home folder as ~. */
export function tilde(path: string, home?: string | null) {
  if (home && (path === home || path.startsWith(home + '/'))) return '~' + path.slice(home.length);
  return path;
}
/** A typed path with ~ as the home folder → the full path. */
export function untilde(path: string, home?: string | null) {
  if (!home) return path;
  return path === '~' ? home : path.startsWith('~/') ? home + path.slice(1) : path;
}
/** The last part of a path ("/Users/me/app" → "app"). */
export function baseName(path: string) {
  const p = path.replace(/\/+$/, '');
  return p.slice(p.lastIndexOf('/') + 1) || p || '/';
}
export function parentOf(path: string) {
  const p = path.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}
export function join(a: string, b: string) { return a.replace(/\/+$/, '') + '/' + b.replace(/^\/+/, ''); }
