// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * The download host keeps only the newest build, described by its latest.json, which scripts/publish.ts writes.
 */
export interface Latest {
  version: string;
  build: string;
  published: string;
  mac: { url: string; sha256: string; size: number };
  /** By target, like darwin-arm64. */
  bridge: Record<string, { url: string; sha256: string }>;
  github: string;
}

const BASE = 'https://dl.coderail.codes';

/** latest.json, read again at most once a minute. */
let cached: { at: number; value: Latest | null } | null = null;

export async function latest(): Promise<Latest | null> {
  if (cached && Date.now() - cached.at < 60_000) return cached.value;
  const r = await fetch(`${BASE}/latest.json`).catch(() => null);
  const value = r?.ok ? ((await r.json()) as Latest) : null;
  cached = { at: Date.now(), value };
  return value;
}
