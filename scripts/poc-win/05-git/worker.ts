// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { rename } from 'node:fs/promises';
const config = await Bun.file(process.argv[2]).json();
const env: Record<string, string | undefined> = { ...process.env, ...config.envPatch };
for (const key of config.clearEnv ?? []) delete env[key];
const output = config.output as string;
try {
  const child = Bun.spawn(config.argv, { cwd: config.cwd, env, stdin: config.input === undefined ? 'ignore' : Buffer.from(config.input, 'utf8'), stdout: 'pipe', stderr: 'pipe', windowsHide: true });
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder('utf-8'); let text = ''; let bytes = 0;
    for await (const chunk of stream) {
      bytes += chunk.length;
      if (bytes > (config.maxOutputBytes ?? 4 * 1024 * 1024)) throw new Error('Command output exceeds bounded capture');
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  };
  const [stdout, stderr, code] = await Promise.all([consume(child.stdout), consume(child.stderr), child.exited]);
  await Bun.write(output + '.tmp', JSON.stringify({ code, stdout, stderr }));
} catch (e) { await Bun.write(output + '.tmp', JSON.stringify({ error: String(e) })); }
await rename(output + '.tmp', output);
