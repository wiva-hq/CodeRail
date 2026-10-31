// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Live viewport frames and native input, served only through Camofox's authenticated loopback API.
export function register(app, ctx) {
  // views: Camofox tab id → its view (a popup's tab shares its opener's); owners: page → view; tabOf: page → tab id.
  const views = new Map(), owners = new WeakMap(), tabOf = new WeakMap();
  ctx.events.on('browser:launching', ({ options }) => {
    const keys = Object.keys(options.env).filter((k) => /^CAMOU_CONFIG_\d+$/.test(k))
      .sort((a, b) => Number(a.split('_').at(-1)) - Number(b.split('_').at(-1)));
    const config = JSON.parse(keys.map((k) => options.env[k]).join(''));
    config.humanize = false;
    // Camofox otherwise reports 1x on public sites, which also downsizes native captures.
    config['window.devicePixelRatio'] = 2;
    // Frozen spoofed dimensions prevent native viewport changes and can hang Firefox's resize.
    for (const k of ['window.outerWidth', 'window.outerHeight', 'window.innerWidth', 'window.innerHeight', 'document.body.clientWidth', 'document.body.clientHeight', 'window.history.length']) delete config[k];
    for (const k of keys) delete options.env[k];
    const json = JSON.stringify(config);
    for (let i = 0; i < json.length; i += 32767) options.env[`CAMOU_CONFIG_${i / 32767 + 1}`] = json.slice(i, i + 32767);
  });
  ctx.events.on('session:creating', ({ contextOptions }) => {
    contextOptions.viewport = { width: 1280, height: 800 };
    contextOptions.deviceScaleFactor = 2;
  });
  const write = (sink, event) => {
    if (sink.res.destroyed) return;
    if (sink.blocked && event.type === 'frame') { sink.pending = event; return; }
    if (!sink.res.write(JSON.stringify(event) + '\n') && !sink.blocked) {
      sink.blocked = true;
      sink.res.once('drain', () => {
        sink.blocked = false;
        const pending = sink.pending; sink.pending = undefined;
        if (pending) write(sink, pending);
      });
    }
  };
  const send = (view, event) => {
    if (event.type === 'frame') view.frame = event;
    for (const sink of view.sinks) write(sink, event);
  };
  const metadata = (view) => {
    const page = view.page;
    if (!page || page.isClosed()) return;
    const url = page.url();
    if (url !== view.url) { view.url = url; view.title = ''; send(view, { type: 'nav', url, title: '' }); }
    if (view.readingTitle) return;
    view.readingTitle = true;
    void page.title().then((title) => {
      if (view.page === page && page.url() === url && title !== view.title) {
        view.title = title; send(view, { type: 'nav', url, title });
      }
    }).catch(() => {}).finally(() => { view.readingTitle = false; });
  };
  const stop = async (view) => {
    view.casting = null;
    view.generation++;
  };
  // Every frame sent goes through the hub, so the pace follows the user: brisk right
  // after input or a navigation, about one a second while the page settles, and rare once it's left alone.
  // Unchanged pixels are never sent.
  const PACE = [[3_000, 125], [30_000, 1_000], [Infinity, 5_000]];
  const pace = (view) => PACE.find(([within]) => Date.now() - view.active < within)[1];
  /** Something the user did (or a new viewer): capture now and keep the fast pace for a while. */
  const touch = (view) => { view.active = Date.now(); view.wake?.(); };
  const cast = async (view) => {
    if (!view.sinks.size || !view.page || view.page.isClosed()) { await stop(view); return; }
    if (view.casting === view.page) return;
    await stop(view);
    const page = view.page, generation = view.generation;
    view.casting = page;
    view.hash = undefined;
    touch(view);
    // The bundled Firefox's screencast returns stale pixels after scrolling. Capture its current
    // viewport instead, without a per-frame HTTP request or a delay after each capture.
    void (async () => {
      while (view.generation === generation && view.page === page && view.sinks.size && !page.isClosed()) {
        const start = performance.now();
        const brisk = pace(view) === PACE[0][1];
        try {
          // (A blinking caret alone would change every frame: it shows only while the user is typing.)
          const data = await page.screenshot({ type: 'jpeg', quality: 80, caret: brisk ? 'initial' : 'hide', scale: 'device', timeout: 1500 });
          // (Nothing to show yet on about:blank, but the wait below still comes: no capture loop at full speed.)
          const showing = view.generation === generation && view.page === page && page.url() !== 'about:blank';
          const hash = showing && Bun.hash(data);
          if (showing && hash !== view.hash) {
            view.hash = hash;
            send(view, { type: 'frame', data: data.toString('base64'), w: view.width, h: view.height });
          }
        } catch {
          // A navigation may destroy the old render context; the next capture uses the new one.
        }
        await new Promise((resolve) => {
          const after = (ms) => setTimeout(done, Math.max(1, ms - (performance.now() - start)));
          let timer = after(pace(view));
          function done() { if (view.wake === wake) view.wake = undefined; resolve(); }
          // (Input wakes a slow wait, but never sooner than the brisk pace.)
          function wake() { clearTimeout(timer); timer = after(PACE[0][1]); }
          view.wake = wake;
        });
      }
    })();
  };
  const reconcile = (view, work) => {
    view.castTail = view.castTail.catch(() => {}).then(async () => { if (work) await work(); await cast(view); });
    return view.castTail;
  };
  ctx.events.on('tab:created', ({ tabId, page }) => {
    void (async () => {
      const opener = await page.opener();
      let view = opener && owners.get(opener);
      if (!view) view = { page, pages: new Set(), sinks: new Set(), inputTail: Promise.resolve(), castTail: Promise.resolve(), casting: null, generation: 0, nav: -1, width: 1280, height: 800, dpr: 2, url: '', title: '', readingTitle: false };
      owners.set(page, view); views.set(tabId, view); tabOf.set(page, tabId); view.pages.add(page); view.page = page;
      page.setDefaultNavigationTimeout(15_000);
      page.on('dialog', (dialog) => void dialog.dismiss().catch(() => {}));
      page.on('framenavigated', (frame) => { if (frame === page.mainFrame() && view.page === page) { metadata(view); touch(view); } });
      page.on('domcontentloaded', () => { metadata(view); if (view.page === page) touch(view); });
      page.on('close', () => {
        view.pages.delete(page); views.delete(tabId);
        if (view.page === page) view.page = opener && !opener.isClosed() ? opener : [...view.pages].at(-1);
        if (!view.pages.size) { send(view, { type: 'closed' }); for (const sink of view.sinks) sink.res.end(); }
        else { metadata(view); void reconcile(view).catch(() => {}); }
      });
      page.on('crash', () => send(view, { type: 'error', message: 'The page crashed. Reload it to try again.' }));
      if (opener) await page.setViewportSize({ width: view.width, height: view.height });
      metadata(view);
      await reconcile(view);
    })().catch((error) => ctx.log('error', 'browser view failed', { error: error.message }));
  });
  ctx.events.on('tab:destroyed', ({ tabId }) => views.delete(tabId));
  app.get('/coderail/health', (_req, res) => res.json({ ok: true }));
  // Camofox's tab id for the page a view shows (it moves to a popup the page opens): the agent's tools act there.
  app.get('/coderail/:id/current', (req, res) => {
    const view = views.get(req.params.id);
    if (!view) return res.status(404).json({ error: 'That browser tab is gone' });
    res.json({ tabId: (view.page && tabOf.get(view.page)) ?? req.params.id });
  });
  app.get('/coderail/:id/stream', (req, res) => {
    const view = views.get(req.params.id);
    if (!view || !view.page || view.page.isClosed()) return res.status(404).json({ error: 'That browser tab is gone' });
    res.set({ 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
    res.flushHeaders();
    const sink = { res, blocked: false };
    view.sinks.add(sink);
    // Each viewer gets the current metadata and a fresh frame, including after reconnect.
    res.write(JSON.stringify({ type: 'nav', url: view.page.url(), title: view.title }) + '\n');
    if (view.frame) write(sink, view.frame);
    view.hash = undefined;
    touch(view);
    const timer = setInterval(() => { metadata(view); if (!sink.blocked) res.write('\n'); }, 1000);
    res.on('close', () => { clearInterval(timer); view.sinks.delete(sink); void reconcile(view).catch(() => {}); });
    void reconcile(view).catch((error) => { send(view, { type: 'error', message: error.message }); res.end(); });
  });
  app.post('/coderail/:id/:action', async (req, res) => {
    const view = views.get(req.params.id);
    if (!view || !view.page || view.page.isClosed()) return res.status(404).json({ error: 'That browser tab is gone' });
    const p = req.body ?? {};
    try {
      switch (req.params.action) {
        case 'resize':
          await reconcile(view, async () => {
            await stop(view);
            await Promise.all([...view.pages].map((page) => page.setViewportSize({ width: p.width, height: p.height })));
            view.width = p.width; view.height = p.height; view.dpr = Math.min(2, Math.max(1, Number(p.dpr) || 2));
          });
          break;
        case 'navigate': {
          const error = ctx.validateUrl(p.url);
          if (error) throw new Error(error);
          const sequence = p.sequence ?? view.nav + 1;
          if (sequence <= view.nav) break;
          view.nav = sequence;
          for (let attempt = 0; attempt < 3 && sequence === view.nav; attempt++) {
            try { await view.page.goto(p.url, { waitUntil: 'commit', timeout: 15_000 }); break; }
            catch (error) {
              if (sequence !== view.nav) break;
              // Firefox may commit an older in-flight navigation after the latest one starts.
              if (attempt === 2 || !/interrupted by another navigation|NS_BINDING_ABORTED/.test(error.message)) throw error;
            }
          }
          metadata(view);
          break;
        }
        case 'go': {
          const page = view.page;
          if (!p.delta) {
            // The bundled Firefox's protocol reload duplicates history; native reload preserves it.
            await Promise.all([page.waitForNavigation({ waitUntil: 'commit', timeout: 15_000 }), page.evaluate(() => location.reload())]);
          } else if (p.delta < 0) {
            const response = await page.goBack({ waitUntil: 'commit' });
            if (!response && view.pages.size > 1) await page.close();
          } else await page.goForward({ waitUntil: 'commit' });
          metadata(view);
          break;
        }
        case 'input': {
          const ev = p.ev ?? {};
          const motion = ev.type === 'wheel' || ev.type === 'mouse' && ev.action === 'mouseMoved';
          let batch = view.pendingInput;
          if (motion && batch?.motion && (batch.modifiers ?? 0) === (ev.modifiers ?? 0) && (batch.buttons ?? 0) === (ev.buttons ?? 0)) {
            // Keep the latest pointer position and accumulated scroll. Clicks and keys are barriers.
            const wheel = batch.events.find((event) => event.type === 'wheel');
            batch.events = ev.type === 'wheel'
              ? [{ ...ev, dx: (wheel?.dx ?? 0) + (ev.dx ?? 0), dy: (wheel?.dy ?? 0) + (ev.dy ?? 0) }]
              : [...(wheel ? [wheel] : []), ev];
          } else {
            batch = { motion, modifiers: ev.modifiers, buttons: ev.buttons, events: [ev] };
            const queued = batch;
            batch.task = view.inputTail.then(async () => {
              if (view.pendingInput === queued) view.pendingInput = undefined;
              const page = view.page;
              for (const event of queued.events) {
                try { await input(page, event); }
                catch (error) {
                  // Motion aimed at a document that just navigated is obsolete.
                  if (!queued.motion || !/Execution context was destroyed|Frame was detached|Target page, context or browser has been closed/.test(error.message)) throw error;
                }
              }
            });
            view.pendingInput = batch;
            view.inputTail = batch.task.catch(() => {});
          }
          await batch.task;
          metadata(view);
          break;
        }
        // (The agent acted through Camofox's own routes: frames speed up as after a person's input, below.)
        case 'touch': break;
        default: throw new Error('Unknown browser action');
      }
      touch(view);
      res.json({ ok: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
}

async function input(page, ev) {
  const n = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  if (ev.type === 'mouse' || ev.type === 'wheel') {
    const bits = n(ev.modifiers);
    for (const [mask, key] of [[1, 'Alt'], [2, 'Control'], [4, 'Meta'], [8, 'Shift']]) await page.keyboard[bits & mask ? 'down' : 'up'](key);
    await page.mouse.move(n(ev.x), n(ev.y));
    if (ev.type === 'wheel') await page.mouse.wheel(n(ev.dx), n(ev.dy));
    else {
      const button = ['left', 'middle', 'right'].includes(ev.button) ? ev.button : 'left';
      const options = { button, clickCount: Math.max(1, Math.min(3, n(ev.clickCount))) };
      if (ev.action === 'mousePressed') await page.mouse.down(options);
      else if (ev.action === 'mouseReleased') await page.mouse.up(options);
    }
  } else if (ev.type === 'key') {
    const key = ev.key === ' ' ? 'Space' : ev.key;
    if (typeof key === 'string' && key) await page.keyboard[ev.action === 'keyUp' ? 'up' : 'down'](key);
  } else if (ev.type === 'text' && typeof ev.text === 'string') await page.keyboard.insertText(ev.text.slice(0, 100_000));
}
