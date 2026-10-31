// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The whole of a file, for viewers that read it here (a Word document, a spreadsheet, a zip's list): by its URL,
// within a size this page can hold.

export const READ_LIMIT = 60 * 1024 * 1024;

export async function fetchBytes(url: string, size: number): Promise<ArrayBuffer> {
  if (size > READ_LIMIT) throw new Error(`Too large to show here (${Math.round(size / 1024 / 1024)} MB): download it instead`);
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(((await r.json().catch(() => null)) as any)?.error ?? `Could not read it (${r.status})`);
  return r.arrayBuffer();
}
