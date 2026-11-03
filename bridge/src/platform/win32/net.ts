// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { win32 } from 'node:path';
import { captureTree, ProcessRef, snapshot } from './job';
import { run } from './process';
import { normalizeEnvironment, utf8 } from './shell';

export async function listeningPorts(roots?: readonly number[]) {
  const table = snapshot(), owned = new Set(roots ? [] : table.map(p => p.pid));
  const refs = new Map<number, ProcessRef>();
  try {
    // A non-elevated bridge cannot open arbitrary system processes. Capture
    // only explicit live roots, using creation times to reject stale parent PIDs.
    if (roots) for (const pid of roots) {
      if (refs.has(pid)) continue;
      const root = ProcessRef.open(pid); if (!root || !root.alive()) { root?.close(); continue; }
      refs.set(pid, root); owned.add(pid);
      for (const child of captureTree(root, table)) {
        if (refs.has(child.pid)) child.close();
        else { refs.set(child.pid, child); owned.add(child.pid); }
      }
    }
    const env = normalizeEnvironment(process.env);
    delete env.PSMODULEPATH; // Windows PowerShell must not import PowerShell 7's built-in modules.
    const ps = win32.join(env.SYSTEMROOT ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
    const script = utf8 + "$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $items=@(Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,OwningProcess); ConvertTo-Json -InputObject $items -Compress";
    const result = await run([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 15000, env });
    if (result.code !== 0) throw new Error(`Windows port discovery failed: ${result.stderr}`);
    const values = JSON.parse(result.stdout) as { LocalAddress: string; LocalPort: number; OwningProcess: number }[];
    return values.filter(item => owned.has(item.OwningProcess) && (!roots || refs.get(item.OwningProcess)?.alive())).map(item => ({ port: item.LocalPort, pid: item.OwningProcess, command: table.find(p => p.pid === item.OwningProcess)?.name ?? '', address: item.LocalAddress })).sort((a, b) => a.port - b.port);
  } finally { for (const ref of refs.values()) ref.close(); }
}
