// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// `@Name` of a member drawn as a mention; your own name (`self`) inverted on ink. A markdown-it core rule over the
// text tokens, so code, link targets and attributes are never touched.
import type { MarkdownIt } from 'markdown-it';

export type Names = { names?: Set<string>; self?: Set<string> };

const AT = /(^|[\s(])@([\p{L}\p{N}._+-]+)/gu;

export function mentionPlugin(md: MarkdownIt) {
  md.core.ruler.push('mention', (state) => {
    const { names, self } = (state.env ?? {}) as Names;
    if (!names?.size && !self?.size) return;
    for (const blk of state.tokens) {
      if (blk.type !== 'inline' || !blk.children) continue;
      const out: typeof blk.children = [];
      for (const t of blk.children) {
        if (t.type !== 'text') { out.push(t); continue; }
        let at = 0;
        for (const m of t.content.matchAll(AT)) {
          const n = m[2];
          const trail = /[.,]+$/.exec(n)?.[0] ?? '';
          const word = trail ? n.slice(0, -trail.length) : n;
          const key = word.toLowerCase();
          const me = !!self?.has(key);
          if (!me && !names?.has(key)) continue;
          const start = m.index + m[1].length;
          const before = new state.Token('text', '', 0);
          before.content = t.content.slice(at, start);
          const tok = new state.Token('mention', '', 0);
          tok.content = word;
          tok.meta = { me };
          out.push(before, tok);
          at = start + 1 + word.length;
        }
        if (!at) { out.push(t); continue; }
        const rest = new state.Token('text', '', 0);
        rest.content = t.content.slice(at);
        out.push(rest);
      }
      blk.children = out;
    }
  });
  md.renderer.rules.mention = (tokens, idx) => {
    const t = tokens[idx];
    return `<span class="mention${t.meta?.me ? ' me' : ''}">@${md.utils.escapeHtml(t.content)}</span>`;
  };
}
