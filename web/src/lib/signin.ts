// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A harness's sign-in opens its page in a new browser tab by itself: the tab is opened on the Sign in click (browsers
// only allow that during a click), showing "Opening the sign-in page…", and sent to the page once the machine prints
// its link (TerminalCard). Keyed by machine and harness.

const waiting = new Map<string, Window>();

/** On the Sign in click: a blank tab to send to the sign-in page. */
export function openSignInTab(machine: string, harness: string) {
  const w = window.open('', '_blank');
  if (!w) return; // blocked: the card's Open sign-in page button still works
  try {
    w.document.title = 'Signing in…';
    w.document.body.style.cssText = 'font: 15px -apple-system, system-ui, sans-serif; color: #6b6b74; display: grid; place-items: center; height: 100vh; margin: 0';
    w.document.body.textContent = 'Opening the sign-in page…';
  } catch {}
  waiting.set(`${machine}:${harness}`, w);
}

/** Once the link is known: the waiting tab goes there. Returns whether there was one. */
export function sendSignInTab(machine: string, harness: string, url: string): boolean {
  const key = `${machine}:${harness}`;
  const w = waiting.get(key);
  waiting.delete(key);
  if (!w || w.closed) return false;
  // Only an https page (the machine prints the link; a terminal's output is not to be trusted with more).
  let u: URL;
  try { u = new URL(url); } catch { w.close(); return false; }
  if (u.protocol !== 'https:') { w.close(); return false; }
  try { w.opener = null; } catch {}
  w.location.href = u.href;
  return true;
}

/** A sign-in that ended without a link (the terminal closed): its waiting tab is closed. */
export function dropSignInTab(machine: string, harness: string) {
  const key = `${machine}:${harness}`;
  const w = waiting.get(key);
  waiting.delete(key);
  if (w && !w.closed) w.close();
}
