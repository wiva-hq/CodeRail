// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { baseline, until } from '../common';
import { launch } from '../08-runtime-integration/launcher';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';
import { captureTree } from './tree-identity';

baseline();
test('stale parent PID cannot make an older unrelated live process part of a new service tree', async () => {
  const spectator = launch([process.execPath, '-e', 'setInterval(()=>{},1000)'], process.cwd());
  await Bun.sleep(20);
  const service = launch([process.execPath, '-e', 'setInterval(()=>{},1000)'], process.cwd());
  const root = ProcessRef.open(service.pid)!;
  try {
    // Deterministically simulate a Toolhelp row left by a previous holder of the
    // parent's numeric PID. Both handles and their creation times are real.
    const captured = captureTree(root, [{ pid: spectator.pid, parentPid: service.pid, name: 'bun.exe' }]);
    try { expect(captured).toHaveLength(0); } finally { for (const child of captured) child.close(); }
    service.closeJob(); await until(() => !service.alive()); expect(spectator.alive()).toBe(true);
  } finally { root.close(); service.dispose(); spectator.closeJob(); await until(() => !spectator.alive()); spectator.dispose(); }
});
