// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { UserService } from '../../../bridge/src/platform/win32/service';
import { run } from '../../../bridge/src/platform/win32/process';
import { contains } from '../../../bridge/src/platform/win32/paths';
import { artifacts, baseline, until } from '../common';
baseline();
const exe = realpathSync.native(process.argv[2]);
const base = realpathSync.native(artifacts), root = await mkdtemp(join(base, 'compiled-status-'));
const service = new UserService(), ready = join(root, 'listener.json');
const spec = { stateDir: root, command: [process.execPath, join(import.meta.dir, 'listener.ts'), ready], home: root, logPath: join(root, 'bridge.log') };
try {
  // Prepare/start does not register startup or mutate the user's PATH.
  await service.prepare(spec); await service.start(spec);
  await until(() => Bun.file(ready).exists());
  const listener = await Bun.file(ready).json();
  const env = { ...process.env, CODERAIL_HOME: root, PATH: join(process.env.SystemRoot!, 'System32') } as Record<string, string>;
  const result = await run([exe, 'status', '--json'], { env, timeout: 30000 });
  assert.equal(result.code, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.resourcesError, undefined);
  assert.equal(status.resources.running, true);
  assert(status.resources.processes.some((item: any) => item.pid === listener.pid && item.privateBytes > 0));
  assert(status.resources.ports.some((item: any) => item.pid === listener.pid && item.port === listener.port));
  await service.stop(spec);
  const stopped = await run([exe, 'status', '--json'], { env, timeout: 30000 });
  assert.equal(stopped.code, 0, stopped.stderr);
  assert.equal(JSON.parse(stopped.stdout).resources.running, false);
  console.log(JSON.stringify({ compiledStatus: true, noNodeBunOnCliPath: true, liveOwnedListener: true, stoppedResources: true, registryChanged: false }));
} finally {
  await service.stop(spec);
  if (!contains(base, realpathSync.native(root))) throw new Error('Unsafe resource fixture cleanup');
  await rm(root, { recursive: true });
}
