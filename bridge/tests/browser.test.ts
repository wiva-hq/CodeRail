// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Opt in after building the bridge: exercise its bundled browser without a package install or download.
// CODERAIL_BROWSER_TEST_HOME can retain isolated profiles between local runs.
test.skipIf(process.env.CODERAIL_BROWSER_TEST !== '1')('Camofox browsing through the bridge', async () => {
  const home = process.env.CODERAIL_BROWSER_TEST_HOME ?? mkdtempSync(join(tmpdir(), 'coderail-browser-'));
  process.env.CODERAIL_HOME = home;
  const { Browsers } = await import('../src/browser');
  const events: any[] = [];
  let writable = true;
  const browser = new Browsers((topic, data) => events.push({ topic, ...data, at: performance.now() }), () => writable);
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === '/slow.js') { await Bun.sleep(3000); return new Response('', { headers: { 'content-type': 'application/javascript' } }); }
    return new Response(new URL(req.url).pathname === '/second' ? '<title>Second page</title><p>Second</p>' : `
      <title>Browser fixture</title>
      <style>body{margin:0;height:3000px}input,button,a{box-sizing:border-box;display:block;width:220px;height:40px;margin:10px}</style>
      <input><button onclick="document.title=document.querySelector('input').value">Save title</button>
      <a href="/second" target="_blank">Popup</a>
      ${path === '/animate' ? '<style>.motion{position:fixed;top:250px;width:60px;height:60px;background:#368;animation:slide 1s linear infinite alternate}@keyframes slide{to{transform:translateX(400px)}}</style><div class="motion"></div>' : ''}
      ${path === '/busy' ? '<script>addEventListener("mousemove",()=>{const end=performance.now()+100;while(performance.now()<end){}});let scroll=0;addEventListener("wheel",e=>scroll+=e.deltaY);addEventListener("keydown",e=>{if(e.key==="Enter")document.title=document.querySelector("input").value+":"+scroll});document.querySelector("input").oninput=(e)=>{document.title=e.target.value}</script>' : ''}
      ${path === '/slow' ? '<script src="/slow.js"></script>' : ''}`, {
      headers: { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" },
    });
  } });
  const url = `http://127.0.0.1:${server.port}/`;
  const nav = () => events.filter((e) => e.type === 'nav').at(-1);
  const frames = () => events.filter((e) => e.type === 'frame');
  async function until(condition: () => boolean, timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (!condition()) {
      const error = events.find((e) => e.type === 'error');
      if (error) throw new Error(error.message);
      if (Date.now() > deadline) throw new Error('Timed out waiting for browser event: ' + JSON.stringify(nav()));
      await Bun.sleep(100);
    }
  }
  try {
    await expect(browser.open({ sessionId: 'chat-1', url: 'file:///etc/passwd' })).rejects.toThrow('Only http and https');
    const before = performance.now();
    const { id } = await browser.open({ sessionId: 'chat-1', url, width: 800, height: 600, dpr: 2 });
    // (One browser per chat: opening again in the same chat reuses it.)
    expect((await browser.open({ sessionId: 'chat-1', url, width: 800, height: 600, dpr: 2 })).id).toBe(id);
    expect(performance.now() - before).toBeLessThan(1000);
    await browser.navigate({ sessionId: id, url: url + 'second' }); // A new URL while Camofox is still starting.
    await until(() => nav()?.title === 'Second page' && frames().length > 0, 8 * 60_000);
    await browser.navigate({ sessionId: id, url });
    await until(() => nav()?.title === 'Browser fixture');
    expect(Buffer.from(frames()[0].data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(jpegSize(frames()[0].data)).toEqual({ width: 1600, height: 1200 });
    async function click(x: number, y: number) {
      for (const action of ['mousePressed', 'mouseReleased']) {
        await browser.input({ sessionId: id, ev: { type: 'mouse', action, x, y, button: 'left', clickCount: 1 } });
      }
    }
    await click(40, 30);
    await browser.input({ sessionId: id, ev: { type: 'text', text: 'Native input works' } });
    await browser.input({ sessionId: id, ev: { type: 'key', action: 'keyDown', key: '!' } });
    await browser.input({ sessionId: id, ev: { type: 'key', action: 'keyUp', key: '!' } });
    await click(40, 80);
    await until(() => nav()?.title === 'Native input works!');
    await browser.navigate({ sessionId: id, url: url + 'second' });
    await until(() => nav()?.title === 'Second page');
    await browser.go({ sessionId: id, delta: -1 });
    await until(() => nav()?.url === url);
    await browser.go({ sessionId: id, delta: 1 });
    await until(() => nav()?.url === url + 'second');
    await browser.go({ sessionId: id, delta: 0 });
    await browser.go({ sessionId: id, delta: -1 });
    await until(() => nav()?.url === url);
    await click(40, 130);
    await until(() => nav()?.title === 'Second page');
    await browser.go({ sessionId: id, delta: -1 }); // Back from a popup returns to its opener.
    await until(() => nav()?.url === url);
    await browser.resize({ sessionId: id, width: 700, height: 500 });
    await browser.watch({ sessionId: id, on: true });
    await until(() => frames().at(-1)?.w === 700 && frames().at(-1)?.h === 500);
    expect(jpegSize(frames().at(-1).data)).toEqual({ width: 1400, height: 1000 });
    const count = frames().length;
    await browser.input({ sessionId: id, ev: { type: 'wheel', x: 100, y: 200, dx: 0, dy: 400 } });
    await until(() => frames().length > count);
    await browser.watch({ sessionId: id, on: false });
    const paused = frames().length;
    await Bun.sleep(750);
    expect(frames().length).toBe(paused);
    await browser.attach({ sessionId: id });
    await until(() => frames().length > paused);
    await browser.navigate({ sessionId: id, url: url + 'animate' });
    await until(() => nav()?.url === url + 'animate');
    // Each frame is a hub request: brisk only right after the user acts, then about one a second.
    const animationStart = performance.now();
    await Bun.sleep(1500);
    const fps = frames().filter((frame) => frame.at >= animationStart).length / 1.5;
    expect(fps).toBeGreaterThan(5);
    expect(fps).toBeLessThan(9);
    await Bun.sleep(2500);
    const settledStart = performance.now();
    await Bun.sleep(3000);
    const settled = frames().filter((frame) => frame.at >= settledStart).length;
    expect(settled).toBeLessThanOrEqual(4);
    expect(settled).toBeGreaterThan(0);
    writable = false;
    const congested = frames().length;
    await Bun.sleep(300);
    expect(frames().length).toBe(congested);
    // Pausing under congestion used to leave a cancelled flush timer and freeze reattachment.
    await browser.watch({ sessionId: id, on: false });
    writable = true;
    await browser.attach({ sessionId: id });
    await until(() => frames().length > congested);
    const loading = browser.navigate({ sessionId: id, url: url + 'slow' });
    await Bun.sleep(100);
    const inputStart = performance.now();
    await browser.input({ sessionId: id, ev: { type: 'mouse', action: 'mouseMoved', x: 100, y: 200 } });
    const latency = performance.now() - inputStart;
    expect(latency).toBeLessThan(500);
    await loading;
    // A second URL must also be usable before the slow page finishes loading its script.
    await browser.navigate({ sessionId: id, url: url + 'second' });
    await until(() => nav()?.title === 'Second page');
    // A busy page must not replay every stale pointer position before delivering a click or text.
    await browser.navigate({ sessionId: id, url: url + 'busy' });
    await until(() => nav()?.title === 'Browser fixture');
    await click(40, 30);
    const moves: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      moves.push(browser.input({ sessionId: id, ev: { type: 'mouse', action: 'mouseMoved', x: 250 + i, y: 200 } }));
      moves.push(browser.input({ sessionId: id, ev: { type: 'wheel', dx: 0, dy: 5, x: 250 + i, y: 200 } }));
      await Bun.sleep(5);
    }
    const burstStart = performance.now();
    await browser.input({ sessionId: id, ev: { type: 'text', text: 'Burst survived' } });
    const burstLatency = performance.now() - burstStart;
    expect(burstLatency).toBeLessThan(800);
    await Promise.all(moves);
    await until(() => nav()?.title === 'Burst survived');
    await browser.input({ sessionId: id, ev: { type: 'key', action: 'keyDown', key: 'Enter' } });
    await browser.input({ sessionId: id, ev: { type: 'key', action: 'keyUp', key: 'Enter' } });
    await until(() => nav()?.title === 'Burst survived:150');
    console.log(`Busy page: ${Math.round(burstLatency)} ms input after 60 motion/scroll events`);
    const burst: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      burst.push(browser.navigate({ sessionId: id, url: url + 'burst-' + i }));
      burst.push(browser.input({ sessionId: id, ev: { type: 'wheel', x: 250, y: 200, dx: 0, dy: 10 } }));
      burst.push(browser.resize({ sessionId: id, width: 650 + i % 2 * 50, height: 500 }));
      await Bun.sleep(5);
    }
    burst.push(browser.navigate({ sessionId: id, url: url + 'second' }));
    await Promise.all(burst);
    await until(() => nav()?.title === 'Second page');
    expect(nav()?.url).toBe(url + 'second');
    await browser.resize({ sessionId: id, width: 700, height: 500 });
    if (process.env.CODERAIL_BROWSER_PUBLIC_TEST === '1') {
      const publicFrames = frames().length;
      await browser.navigate({ sessionId: id, url: 'https://www.google.com/' });
      await until(() => nav()?.title === 'Google' && frames().length > publicFrames);
      await Bun.sleep(500);
      expect(jpegSize(frames().at(-1).data)).toEqual({ width: 1400, height: 1000 });
    }
    console.log(`Camofox stream: ${fps.toFixed(1)} fps, Retina capture, ${Math.round(latency)} ms input during loading`);
    await browser.close({ sessionId: id });
    expect(events.at(-1)?.type).toBe('closed');
    await expect(browser.attach({ sessionId: id })).rejects.toThrow('That browser tab is gone');
  } finally {
    browser.shutdown();
    server.stop(true);
    if (!process.env.CODERAIL_BROWSER_TEST_HOME) rmSync(home, { recursive: true, force: true });
  }
}, 10 * 60_000);

function jpegSize(data: string) {
  const bytes = Buffer.from(data, 'base64');
  for (let i = 2; i < bytes.length;) {
    if (bytes[i++] !== 0xff) continue;
    const marker = bytes[i++], length = bytes.readUInt16BE(i);
    if ([0xc0, 0xc1, 0xc2].includes(marker)) return { width: bytes.readUInt16BE(i + 5), height: bytes.readUInt16BE(i + 3) };
    i += length;
  }
  throw new Error('Missing JPEG dimensions');
}
