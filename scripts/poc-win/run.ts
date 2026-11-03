// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { artifacts, assert, baseline, root } from './common';
baseline();
const suite = process.argv[2] ?? 'all';
const entries = { runtime: '01-bun-runtime/run.ts', terminal: '02-conpty-terminal/run.ts', codex: '03-codex/run.ts' };
assert(suite === 'all' || suite in entries, `Unknown suite: ${suite}`);
await Bun.write(join(artifacts, 'environment.json'), JSON.stringify({ bun: Bun.version, platform: process.platform, arch: process.arch, osVersion: (await import('node:os')).release(), codexPath: process.env.POC_CODEX_PATH ?? null, pwshPath: process.env.POC_PWSH_PATH ?? null, nodePath: process.env.POC_NODE_PATH ?? null, at: new Date().toISOString(), filter: process.env.POC_FILTER ?? null }, null, 2));
let failed = false;
for (const [name, entry] of Object.entries(entries)) {
  if (suite !== 'all' && suite !== name) continue;
  const p = Bun.spawn([process.execPath, join(root, entry)], { env: { ...process.env, BUN_BE_BUN: '1' }, stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const lines: string[] = [];
  const errors: string[] = [];
  const consume = async (stream: ReadableStream<Uint8Array>, target: string[], output: { write(chunk: string): unknown }) => {
    const decoder = new TextDecoder('utf-8');
    for await (const chunk of stream) { const text = decoder.decode(chunk, { stream: true }); target.push(text); output.write(text); }
    target.push(decoder.decode());
  };
  await Promise.all([consume(p.stdout, lines, process.stdout), consume(p.stderr, errors, process.stderr)]);
  const code = await p.exited;
  const log = lines.join('') + errors.join('');
  await Bun.write(join(artifacts, `${name}.log`), log);
  await Bun.write(join(artifacts, `${name}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}.log`), log);
  failed ||= code !== 0;
}
process.exitCode = failed ? 1 : 0;
