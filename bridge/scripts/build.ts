// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Builds the bridge: each ACP adapter bundled to one JavaScript file, embedded in a single binary per
// platform. `bun scripts/build.ts [target...]`, targets like darwin-arm64 (default: all). The build
// number comes from CODERAIL_BUILD (the release pipeline's run number), else 0.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserArchive } from './browser';

const root = join(import.meta.dir, '..');
const out = join(root, 'build');
const ALL = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'adapters'), { recursive: true });

const adapters: Record<string, string> = {
  'claude-code': '@agentclientprotocol/claude-agent-acp/dist/index.js',
  codex: '@agentclientprotocol/codex-acp/dist/index.js',
};

for (const [id, entry] of Object.entries(adapters)) {
  const r = await Bun.build({
    entrypoints: [Bun.resolveSync(entry, root)],
    target: 'bun',
    format: 'esm',
    minify: false,
    // The harnesses' own binaries: CodeRail runs the machine's installed claude / codex instead.
    external: ['@anthropic-ai/claude-agent-sdk-*', '@openai/codex-*', '@openai/codex'],
  });
  if (!r.success) {
    for (const m of r.logs) console.error(m);
    process.exit(1);
  }
  await Bun.write(join(out, 'adapters', `${id}.js`), r.outputs[0]);
  console.log(`bundled ${id}: ${(r.outputs[0].size / 1e6).toFixed(1)} MB`);
}

const entry = `import claude from './adapters/claude-code.js' with { type: 'file' };
import codex from './adapters/codex.js' with { type: 'file' };
globalThis.__CODERAIL_ADAPTERS__ = { 'claude-code': claude, codex };
`;

for (const t of targets) {
  const archive = join(out, `browser-${t}.tar.gz`);
  await browserArchive(t, archive);
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(archive).stream()) hash.update(chunk);
  writeFileSync(join(out, 'entry.ts'), entry + `
import browser from './browser-${t}.tar.gz' with { type: 'file' };
globalThis.__CODERAIL_BROWSER__ = { archive: browser, hash: '${hash.digest('hex').slice(0, 24)}' };
await import('../src/main.ts');
`);
  async function compile(output: string, source: string) {
    const p = Bun.spawn(['bun', 'build', source, '--compile', '--minify', `--target=bun-${t}`, '--define', `CODERAIL_BUILD=${JSON.stringify(process.env.CODERAIL_BUILD ?? '0')}`, '--outfile', output], {
      cwd: root, stdout: 'inherit', stderr: 'inherit',
    });
    if (await p.exited !== 0) process.exit(1);
    if (t.startsWith('darwin') && process.platform === 'darwin') {
      if (await Bun.spawn(['codesign', '--force', '--sign', '-', output]).exited !== 0) process.exit(1);
    }
    console.log(`built ${output} (${(Bun.file(output).size / 1e6).toFixed(1)} MB)`);
  }
  await compile(join(out, `coderail-${t}`), join(out, 'entry.ts'));
  if (t.startsWith('darwin')) {
    // The Mac app carries its browser as signed resources, once, outside the universal bridge binary.
    mkdirSync(join(out, 'app'), { recursive: true });
    writeFileSync(join(out, 'app-entry.ts'), entry + "await import('../src/main.ts');\n");
    await compile(join(out, 'app', `coderail-${t}`), join(out, 'app-entry.ts'));
  }
  rmSync(archive);
}
