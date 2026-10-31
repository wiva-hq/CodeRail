// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Messages as Markdown (markdown-it), code blocks highlighted by Shiki in the theme's syntax colours (a
// css-variables theme: every token colour is a `--syntax-*` variable from styles/theme.css, light and dark).
import MarkdownIt from 'markdown-it';
import { createHighlighterCore, createCssVariablesTheme, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { ICONS } from './art.gen';
import { mentionPlugin } from './mentions';

const theme = createCssVariablesTheme({ name: 'coderail', variablePrefix: '--shiki-', fontStyle: true });

// The languages a project's code is likely in; another is drawn plain.
const LANGS: Record<string, () => Promise<unknown>> = {
  typescript: () => import('shiki/langs/typescript.mjs'),
  javascript: () => import('shiki/langs/javascript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  prisma: () => import('shiki/langs/prisma.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  'objective-c': () => import('shiki/langs/objective-c.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  jsonc: () => import('shiki/langs/jsonc.mjs'),
  json5: () => import('shiki/langs/json5.mjs'),
  ini: () => import('shiki/langs/ini.mjs'),
  vue: () => import('shiki/langs/vue.mjs'),
  svelte: () => import('shiki/langs/svelte.mjs'),
  scss: () => import('shiki/langs/scss.mjs'),
  less: () => import('shiki/langs/less.mjs'),
  fish: () => import('shiki/langs/fish.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
};
const ALIAS: Record<string, string> = {
  ts: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', sh: 'shellscript', bash: 'shellscript', zsh: 'shellscript', shell: 'shellscript',
  console: 'shellscript', py: 'python', rs: 'rust', yml: 'yaml', md: 'markdown', jsx: 'tsx', h: 'c', hpp: 'cpp', cc: 'cpp', 'c++': 'cpp',
  objc: 'objective-c', m: 'objective-c', mm: 'objective-c', kt: 'kotlin', kts: 'kotlin', rb: 'ruby', svg: 'xml', plist: 'xml', html5: 'html',
  conf: 'ini', cfg: 'ini', env: 'ini', docker: 'dockerfile', patch: 'diff',
};
/** The language a fence or a file names, as the highlighter knows it ('' when it does not). */
export function langOf(info: string) { const l = (info ?? '').trim().split(/\s+/)[0].toLowerCase(); const k = ALIAS[l] ?? l; return LANGS[k] ? k : ''; }

let hl: HighlighterCore | null = null;
let loading: Promise<HighlighterCore> | null = null;
const listeners = new Set<() => void>();

/** Called once the highlighter is ready (the views draw again). */
export function onHighlighterReady(f: () => void) { listeners.add(f); return () => listeners.delete(f); }

function highlighter() {
  loading ??= createHighlighterCore({
    themes: [theme],
    langs: Object.values(LANGS).map((f) => f() as never),
    engine: createJavaScriptRegexEngine(),
  }).then((h) => { hl = h; for (const f of listeners) f(); return h; });
  return loading;
}

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, info) {
    const lang = langOf(info);
    if (hl && lang) {
      try { return hl.codeToHtml(code, { lang, theme: 'coderail' }); } catch { /* plain */ }
    } else if (!hl) highlighter();
    return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
  },
});

/** Text made safe inside HTML (markdown-it's own). */
export const escapeHtml = (t: string): string => md.utils.escapeHtml(t);

// A code block (open-claude-ui CodeBlock.tsx): a header row with the language
// as written and Copy, then the code, which scrolls sideways and never wraps. Copy is one delegated click in
// Markdown.svelte (`[data-copy]`): it shows a check and "Copied" for 1.4 s.
const COPY = `<svg class="i" width="14" height="14" viewBox="0 0 24 24" stroke-width="1.8" aria-hidden="true">${ICONS.copy ?? ''}</svg>`;
const defaultFence = md.renderer.rules.fence!;
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const info = (tokens[idx].info ?? '').trim().split(/\s+/)[0];
  const body = defaultFence(tokens, idx, options, env, self);
  return `<div class="codeblock"><div class="cb-head"><span class="cb-lang">${escapeHtml(info || 'text')}</span>` +
    `<button type="button" class="cb-copy" data-copy aria-label="Copy code">${COPY}<span class="cb-l">Copy</span></button></div>${body}</div>`;
};
// Tables in a rounded hairline frame (a wrapper: a table's own border-radius does not clip its cells).
md.renderer.rules.table_open = () => '<div class="tbl"><table>';
md.renderer.rules.table_close = () => '</table></div>';
// An image in a message is its link: the app never fetches a remote picture inside its window.
md.renderer.rules.image = (tokens, idx) => {
  const t = tokens[idx];
  const src = String(t.attrGet('src') ?? '');
  const alt = String(t.content || src);
  return `<a href="${escapeHtml(src)}" target="_blank" rel="noreferrer">${escapeHtml(alt)}</a>`;
};

// Links open in a new tab, never in the app's own window.
type Rule = NonNullable<typeof md.renderer.rules.link_open>;
const defaultLink: Rule = md.renderer.rules.link_open ?? ((t, i, o, _e, s) => s.renderToken(t, i, o));
const linkOpen: Rule = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet('target', '_blank');
  tokens[idx].attrSet('rel', 'noreferrer');
  return defaultLink(tokens, idx, options, env, self);
};
md.renderer.rules.link_open = linkOpen;
md.use(mentionPlugin);

/** A file's text, highlighted when its language is one Shiki knows here (else plain). */
export function highlight(code: string, lang: string) {
  lang = langOf(lang) || lang;
  if (hl && lang && LANGS[lang]) { try { return hl.codeToHtml(code, { lang, theme: 'coderail' }); } catch { /* plain */ } }
  return `<pre class="shiki"><code>${escapeHtml(code)}</code></pre>`;
}

export function render(text: string, names: Set<string> = new Set(), self: Set<string> = new Set()) {
  return md.render(text ?? '', { names, self });
}

/** One line, inline Markdown only (a step's title: `code` in it). */
export function inline(text: string) {
  return md.renderInline(text ?? '');
}

highlighter();

/** A text's lines as coloured tokens (the diff's syntax colours: `color` is a `var(--shiki-…)`); null while the
 * highlighter loads (it calls `onHighlighterReady` after) or for a language it does not know. */
export function tokenLines(code: string, lang: string): { content: string; color?: string; fontStyle?: number }[][] | null {
  lang = langOf(lang) || lang;
  if (!hl) { highlighter(); return null; }
  if (!lang || !LANGS[lang]) return null;
  try { return hl.codeToTokensBase(code, { lang, theme: 'coderail' }) as { content: string; color?: string; fontStyle?: number }[][]; } catch { return null; }
}
