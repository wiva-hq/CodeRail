// Puts the copyright and license header at the top of every source file git tracks, in that file's comment
// style, after a shebang or doctype if there is one. Files that already have it are left alone.
//   bun scripts/license-headers.ts          add it where it's missing
//   bun scripts/license-headers.ts --check  list files without it, and fail if there are any
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const LINES = ['Copyright 2026 Wiva, Inc.', 'SPDX-License-Identifier: Apache-2.0'];
const MARK = 'SPDX-License-Identifier';

const STYLES: Record<string, (lines: string[]) => string> = {
  ts: (l) => l.map((x) => `// ${x}`).join('\n'),
  js: (l) => l.map((x) => `// ${x}`).join('\n'),
  swift: (l) => l.map((x) => `// ${x}`).join('\n'),
  css: (l) => `/* ${l.join('\n   ')} */`,
  sql: (l) => l.map((x) => `-- ${x}`).join('\n'),
  yml: (l) => l.map((x) => `# ${x}`).join('\n'),
  yaml: (l) => l.map((x) => `# ${x}`).join('\n'),
  svelte: (l) => `<!-- ${l.join('\n     ')} -->`,
  html: (l) => `<!-- ${l.join('\n     ')} -->`,
};

const files = Bun.spawnSync(['git', 'ls-files'], { cwd: root }).stdout.toString().trim().split('\n');
const check = process.argv.includes('--check');
const missing: string[] = [];
for (const f of files) {
  const ext = f.split('.').pop()!;
  const style = STYLES[ext];
  if (!style) continue;
  const path = join(root, f);
  const text = readFileSync(path, 'utf8');
  if (text.slice(0, 600).includes(MARK)) continue;
  missing.push(f);
  if (check) continue;
  const header = style(LINES) + '\n';
  // A first line that has to stay first: a shebang, or an HTML doctype.
  const first = text.match(/^(#![^\n]*\n|<!doctype[^>]*>\n)/i)?.[0] ?? '';
  writeFileSync(path, first + header + text.slice(first.length));
}
if (check) {
  for (const f of missing) console.log(f);
  if (missing.length) {
    console.error(`${missing.length} file(s) without the license header; run bun scripts/license-headers.ts`);
    process.exit(1);
  }
} else {
  console.log(`added the header to ${missing.length} file(s)`);
}
