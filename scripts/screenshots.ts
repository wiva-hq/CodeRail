// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Takes the README's screenshots from the UI's mock mode (fake machines and sessions, nothing real), with headless
// Chrome over the DevTools protocol, at 2x, into docs/images/.
//   cd web && bun run dev:mock        (in another terminal; serves http://localhost:5174)
//   bun scripts/screenshots.ts
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const out = join(root, 'docs/images');
const BASE = process.env.MOCK_URL ?? 'http://localhost:5174';
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

// The machine screen's panes: the chat, and beside it the diff over a terminal.
const layout = (cards: { kind: string }[][]) => {
  const groups = cards.map((tabs, i) => {
    const ts = tabs.map((t, j) => ({ id: `t${i}${j}`, ...t }));
    return { id: `g${i}`, tabs: ts, active: ts[0].id };
  });
  const right = groups.length === 1 ? { t: 'group', id: 'g0' } : { t: 'split', v: true, items: groups.map((g) => ({ t: 'group', id: g.id })), w: groups.map(() => 1) };
  return JSON.stringify({ root: { t: 'split', v: false, items: [{ t: 'chat' }, right], w: [600, 560] }, groups, parked: [], expanded: null, spots: {} });
};

const SHOTS = [
  { name: 'machine', path: '/m/m1/s/s1', w: 1440, h: 900, dark: false, panes: layout([[{ kind: 'changes' }], [{ kind: 'terminal' }]]) },
  { name: 'machine-dark', path: '/m/m1/s/s1', w: 1440, h: 900, dark: true, panes: layout([[{ kind: 'changes' }], [{ kind: 'terminal' }]]) },
  { name: 'files-preview', path: '/m/m1/s/s2', w: 1440, h: 900, dark: false, panes: layout([[{ kind: 'files' }], [{ kind: 'browser' }]]) },
  { name: 'phone', path: '/', w: 390, h: 844, dark: false, mobile: true },
  { name: 'phone-session', path: '/m/m1/s/s1', w: 390, h: 844, dark: false, mobile: true },
];

const profile = join(root, 'mac/build/.chrome-screenshots');
rmSync(profile, { recursive: true, force: true });
const chrome = Bun.spawn([CHROME, '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--no-first-run', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });

async function devtools(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const page = ((await r.json()) as any[]).find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await Bun.sleep(200);
  }
  throw new Error('Chrome did not start');
}

const ws = new WebSocket(await devtools());
await new Promise((r) => (ws.onopen = r));
let seq = 0;
const waiting = new Map<number, (v: any) => void>();
ws.onmessage = (e) => {
  const m = JSON.parse(String(e.data));
  if (m.id && waiting.has(m.id)) {
    waiting.get(m.id)!(m.error ? Promise.reject(new Error(m.error.message)) : m.result);
    waiting.delete(m.id);
  }
};
const cdp = (method: string, params: object = {}): Promise<any> =>
  new Promise((resolve) => {
    const id = ++seq;
    waiting.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

mkdirSync(out, { recursive: true });
await cdp('Page.enable');
for (const s of SHOTS) {
  await cdp('Emulation.setDeviceMetricsOverride', { width: s.w, height: s.h, deviceScaleFactor: 2, mobile: !!s.mobile });
  await cdp('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: s.dark ? 'dark' : 'light' }] });
  await cdp('Page.navigate', { url: `${BASE}/` });
  await Bun.sleep(800);
  const seed = s.panes ? `localStorage.setItem('coderail.panes.m1', ${JSON.stringify(s.panes)});` : '';
  await cdp('Runtime.evaluate', { expression: `localStorage.clear(); ${seed}` });
  await cdp('Page.navigate', { url: BASE + s.path });
  await Bun.sleep(5000);
  const shot = await cdp('Page.captureScreenshot', { format: 'png' });
  await Bun.write(join(out, `${s.name}.png`), Buffer.from(shot.data, 'base64'));
  console.log(`docs/images/${s.name}.png`);
}
ws.close();
chrome.kill();
rmSync(profile, { recursive: true, force: true });
