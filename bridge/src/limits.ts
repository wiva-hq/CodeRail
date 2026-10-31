// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/**
 * Claude's plan usage limits (the 5-hour and weekly windows), as the Claude app shows them: read with the computer's
 * own Claude Code login (the macOS Keychain, or ~/.claude/.credentials.json) from Anthropic's usage endpoint. The
 * token stays on this computer; only the percentages and reset times go out. Claude Code refreshes the token
 * itself, so an expired one just means "not now" (the last answer is kept).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { HOME, log, run } from './env';

export interface PlanLimits {
  /** "Max (20x)", "Pro", … */
  plan: string | null;
  windows: { id: string; label: string; used: number; resetsAt: number | null }[];
  at: number;
}

const FRESH = 60_000;
let last: PlanLimits | null = null;
let inflight: Promise<PlanLimits | null> | null = null;

async function credentials(): Promise<any | null> {
  const dir = process.env.CLAUDE_CONFIG_DIR || join(HOME, '.claude');
  try { return JSON.parse(await readFile(join(dir, '.credentials.json'), 'utf8'))?.claudeAiOauth ?? null; } catch { /* not there */ }
  if (process.platform !== 'darwin') return null;
  const r = await run(['/usr/bin/security', 'find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }).catch(() => null);
  if (!r || r.code !== 0) return null;
  try { return JSON.parse(r.stdout)?.claudeAiOauth ?? null; } catch { return null; }
}

/** "max" + "default_claude_max_20x" → "Max (20x)". */
function planName(c: any): string | null {
  const t = String(c?.subscriptionType ?? '');
  if (!t) return null;
  const name = t.charAt(0).toUpperCase() + t.slice(1);
  const x = /_(\d+x)$/.exec(String(c?.rateLimitTier ?? ''));
  return x ? `${name} (${x[1]})` : name;
}

const WINDOWS: [string, string][] = [['five_hour', '5-hour limit'], ['seven_day', 'Weekly · all models'], ['seven_day_opus', 'Weekly · Opus'], ['seven_day_sonnet', 'Weekly · Sonnet']];

async function fetchLimits(): Promise<PlanLimits | null> {
  const c = await credentials();
  if (!c?.accessToken) return null;
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${c.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!res?.ok) { if (res) log('plan limits:', res.status); return null; }
  const u: any = await res.json().catch(() => null);
  if (!u) return null;
  const windows = WINDOWS.flatMap(([id, label]) => {
    const w = u[id];
    if (!w || typeof w.utilization !== 'number') return [];
    const t = w.resets_at ? Date.parse(w.resets_at) : NaN;
    return [{ id, label, used: Math.max(0, Math.min(100, w.utilization)), resetsAt: Number.isNaN(t) ? null : t }];
  });
  return { plan: planName(c), windows, at: Date.now() };
}

/** The limits, at most a minute old (`fresh`: ask again now, after a turn). */
export async function planLimits(fresh = false): Promise<PlanLimits | null> {
  if (last && !fresh && Date.now() - last.at < FRESH) return last;
  inflight ??= fetchLimits().then((l) => (l ? (last = l) : last)).finally(() => { inflight = null; });
  return inflight;
}
