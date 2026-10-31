// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Bytes as the daemon carries them in JSON: base64 (`files.read`/`files.write`, uploads, terminal and job output).

/** Bytes → base64. */
export function b64(bytes: Uint8Array | ArrayBuffer) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}
/** Base64 → bytes. */
export function unb64(s: string) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}
/** Base64 → text (UTF-8). */
export function b64Text(s: string) {
  return new TextDecoder().decode(unb64(s));
}
