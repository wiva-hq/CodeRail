// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Times, sizes and names as the app writes them.

// (The formats, made once: a time as the system writes it, 9:04 or 9:04 AM; dates in English, as the words around
// them are.)
const HM = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const DAY_YEAR = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const DATE = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium' });
const COMPACT = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

/** A size in binary units (1 KB = 1024 bytes, as Forest counts them): "640 bytes", "4.2 KB", "1.3 MB", "2.0 GB". */
export function fileSize(n: number) {
  if (n < 1024) return `${n} bytes`;
  const [v, u] = n < 1 << 20 ? [n / 1024, 'KB'] : n < 1 << 30 ? [n / (1 << 20), 'MB'] : [n / (1 << 30), 'GB'];
  return `${v.toFixed(1)} ${u}`;
}
/** A step's duration: "0.4 s", "41 s", "2m 14s". */
export function short(ms: number) {
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)} s`;
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
/** A finished turn's time: "8s", "1m 3s", "1h 2m". */
export function worked(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor(s / 60) % 60}m`;
}
/** "14:05" today, "Mon 14:05" this week, else "Oct 12". */
export function time(ms: number) {
  if (!ms) return '';
  const d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return HM.format(d);
  if (now.getTime() - ms < 6 * 86_400_000) return `${WEEKDAY.format(d)} ${HM.format(d)}`;
  return DAY.format(d);
}
/** "14:05" today, else how long ago ("3h ago", "yesterday"). */
export function recent(ms: number, now = Date.now()) {
  if (!ms) return '';
  return new Date(ms).toDateString() === new Date(now).toDateString() ? HM.format(ms) : ago(ms, now);
}
/** "Oct 24, 2026". */
export function date(ms: number) { return ms ? DATE.format(ms) : ''; }
/** "Oct 24, 2026, 9:04" (when a build was made). */
export function dateTime(ms: number) { return ms ? `${DATE.format(ms)}, ${HM.format(ms)}` : ''; }
/** "213.3K", "1.2M", "940". */
export function compact(n?: number) { return n == null || !Number.isFinite(n) ? '' : COMPACT.format(n); }
/** "2m ago", "3h ago", "yesterday". */
export function ago(ms: number, now = Date.now()) {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 2 * 86_400) return 'yesterday';
  return `${Math.floor(s / 86_400)}d ago`;
}
/** "9:04", "17:20" (a message's time in its hover pill; FClock.time). */
export function hm(ms: number) {
  return ms ? HM.format(ms) : '';
}
/** The chat's day line: "Today", "Yesterday", "Oct 14" (FClock.dayLine). */
export function dayLine(ms: number, now = Date.now()) {
  const d = new Date(ms), n = new Date(now);
  if (d.toDateString() === n.toDateString()) return 'Today';
  const y = new Date(n); y.setDate(n.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return (d.getFullYear() !== n.getFullYear() ? DAY_YEAR : DAY).format(d);
}
/** "invoice-previ…ew.png": a long name cut in the middle, so its end and extension stay. */
export function middle(s: string, n = 28) {
  if (s.length <= n) return s;
  const dot = s.lastIndexOf('.');
  const tail = Math.max(dot > 0 && s.length - dot <= 8 ? s.length - dot + 3 : Math.floor(n / 3), 6);
  return s.slice(0, n - tail - 1) + '…' + s.slice(s.length - tail);
}
/** "Today, 10:06", "Yesterday, 17:20", "Oct 14, 9:04" (a version's time; FClock.stamp). */
export function stamp(ms: number, now = Date.now()) {
  if (!ms) return '';
  return `${dayLine(ms, now)}, ${hm(ms)}`;
}
/** A badge's number: at most two digits ("99+"), so a badge keeps its size. */
export function badge(n: number) {
  return n > 99 ? '99+' : String(n);
}
