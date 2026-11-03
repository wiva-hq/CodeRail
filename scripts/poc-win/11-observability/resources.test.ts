// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { launch } from '../../../bridge/src/platform/win32/launcher';
import { ProcessRef } from '../../../bridge/src/platform/win32/job';
import { artifacts, baseline, until } from '../common';
import { resources } from './resources';
baseline();

test('resource sample includes only owned listener and rejects the exited root identity', async () => {
  const dir = await mkdtemp(join(artifacts, 'resource-中文-'));
  const ready = join(dir, 'ready.json');
  const unrelated = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('unrelated') });
  const child = launch([process.execPath, join(import.meta.dir, 'listener.ts'), ready], dir);
  const ref = ProcessRef.open(child.pid)!;
  try {
    await until(() => Bun.file(ready).exists());
    const listener = await Bun.file(ready).json();
    const sample = await resources(ref);
    expect(sample!.rootPid).toBe(child.pid);
    expect(sample!.processes.some(item => item.pid === listener.pid && item.privateBytes > 0 && item.workingSetBytes > 0)).toBe(true);
    expect(sample!.ports.some(item => item.pid === listener.pid && item.port === listener.port)).toBe(true);
    expect(sample!.ports.some(item => item.port === unrelated.port)).toBe(false);
    child.closeJob(); await until(() => !ref.alive());
    expect(await resources(ref)).toBeNull();
    console.log(JSON.stringify({ ownedResourceSample: true, unrelatedListenerExcluded: true, deadIdentityRejected: true }));
  } finally {
    child.dispose(); await until(() => !ref.alive()); ref.close(); unrelated.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
