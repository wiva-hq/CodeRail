// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/// <reference path="./assets.d.ts" />
import { join } from 'node:path';
import { ProcessJob, ProcessRef } from './job';
import { error, normalize } from './paths';
import script from './recycle.ps1' with { type: 'text' };

export async function recycle(path: string) {
  const target = normalize(path);
  if (target.startsWith('\\\\')) throw error('ENOTSUP', 'UNC recycling is unavailable; permanent deletion is forbidden');
  const job = new ProcessJob();
  const child = Bun.spawn([join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'), '-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, env: { ...process.env, CODERAIL_RECYCLE_TARGET: target }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const root = ProcessRef.open(child.pid);
  if (!root) { job.close(); throw error('EIO', 'Recycle helper exited before containment'); }
  const timer = setTimeout(() => job.close(), 15000);
  try {
    job.assign(root);
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw error('EIO', `Recycle failed (${code}): ${stderr.trim()}`);
    if (JSON.parse(stdout).recycled !== true) throw error('EIO', 'Recycle helper returned no success confirmation');
  } finally { clearTimeout(timer); job.close(); root.close(); }
}
