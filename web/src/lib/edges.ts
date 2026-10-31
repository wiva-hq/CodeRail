// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Scroll edges (open-claude-ui ScrollFadeContainer's sensor, without the gradient: Forest draws a hairline): a
// scroller says whether more is hidden above or below it, as `data-more-top` / `data-more-bottom` on itself and on
// the box it sits in (a card's tab body draws the line), and keeps saying it as it scrolls, resizes or grows.
//
//   <div class="body scroll" {@attach edges()}>…</div>

export function edges(opts: { host?: (node: HTMLElement) => HTMLElement | null } = {}) {
  return (node: HTMLElement) => {
    const host = (opts.host ?? ((n) => n.parentElement))(node);
    const set = (el: HTMLElement | null, k: string, on: boolean) => { if (el) { if (on) el.setAttribute(k, ''); else el.removeAttribute(k); } };
    const f = () => {
      const top = node.scrollTop > 2;
      const bottom = node.scrollTop + node.clientHeight < node.scrollHeight - 2;
      for (const el of [node, host]) { set(el, 'data-more-top', top); set(el, 'data-more-bottom', bottom); }
    };
    f();
    node.addEventListener('scroll', f, { passive: true });
    const ro = new ResizeObserver(f);
    ro.observe(node);
    // (Rows that open or load change the height without a resize of the scroller itself.)
    const mo = new MutationObserver(() => requestAnimationFrame(f));
    mo.observe(node, { childList: true, subtree: true });
    return () => {
      node.removeEventListener('scroll', f);
      ro.disconnect(); mo.disconnect();
      for (const el of [node, host]) { el?.removeAttribute('data-more-top'); el?.removeAttribute('data-more-bottom'); }
    };
  };
}
