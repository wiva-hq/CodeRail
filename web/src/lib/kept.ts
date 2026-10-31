// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// What the app keeps on this device (localStorage), as JSON: read with a fallback, written, or forgotten (null). A
// web view that refuses storage (a private window) reads the fallback and keeps nothing.
export function kept<T>(key: string, fallback: T): T {
  let v: string | null;
  try { v = localStorage.getItem(key); } catch { return fallback; }
  return v == null ? fallback : parsed(v, fallback);
}
/** A kept value: its JSON, else the fallback. */
export function parsed<T>(v: string, fallback: T): T {
  try { return JSON.parse(v) as T; } catch { return fallback; }
}
export function keep(key: string, v: unknown) {
  try { if (v == null) localStorage.removeItem(key); else localStorage.setItem(key, JSON.stringify(v)); } catch { /* nothing kept */ }
}
