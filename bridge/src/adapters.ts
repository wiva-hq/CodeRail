// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from './env';

// The ACP adapters, as one JavaScript file each. In a built bridge they are embedded in the binary
// (scripts/build.ts) and written out to ~/.coderail/adapters/<hash>/ on first use, since a child
// process cannot read the binary's embedded files. In development they come from node_modules.

const PACKAGES: Record<string, string> = {
  'claude-code': '@agentclientprotocol/claude-agent-acp/dist/index.js',
  codex: '@agentclientprotocol/codex-acp/dist/index.js',
};

declare global {
  // Set by the build's entry: harness id -> embedded file path.
  var __CODERAIL_ADAPTERS__: Record<string, string> | undefined;
}

export async function adapterPath(harness: string): Promise<string> {
  const embedded = globalThis.__CODERAIL_ADAPTERS__?.[harness];
  if (embedded) {
    const file = Bun.file(embedded);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = Bun.hash(bytes).toString(36);
    const dir = join(STATE_DIR, 'adapters', hash);
    const out = join(dir, `${harness}.js`);
    if (!existsSync(out)) {
      mkdirSync(dir, { recursive: true });
      await Bun.write(out + '.tmp', bytes);
      await import('node:fs/promises').then((fs) => fs.rename(out + '.tmp', out));
    }
    return out;
  }
  return Bun.resolveSync(PACKAGES[harness], import.meta.dir);
}
