// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baseline } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { UserAutorun } from './autorun';
import { UserEnvironmentValue, type RegistryString } from './user-path';
import { installPrepared } from './install-transaction';
import { UserService } from './service';

baseline();
test('unpaired installation transaction: register only, conflict rejection and rollback after a registry write failure', async () => {
  const base = realpathSync.native(tmpdir()), root = await mkdtemp(join(base, 'cri-'));
  const startup = new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`), environment = new UserEnvironmentValue(`CodeRail-PoC-${crypto.randomUUID()}`);
  const realPath = new UserEnvironmentValue(), before = realPath.read();
  let command: string | undefined;
  try {
    const binary = join(root, 'fixture.exe'), bytes = Buffer.alloc(512);
    // Validation fixture only: registration must never execute this image.
    bytes.write('MZ'); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80); bytes.writeUInt16LE(0x8664, 0x84); await writeFile(binary, bytes);
    const target = join(root, 'good');
    const result = await installPrepared(target, binary, '0.0.1+1', { startup, environment }); command = result.command;
    expect(startup.read()).toBe(command); expect(environment.read()?.text).toBe(join(target, 'bin/current'));
    expect((await new UserService(startup).status({ command: [], stateDir: target, home: base, logPath: join(target, 'bridge.log') })).running).toBe(false);
    expect(JSON.parse(await readFile(join(target, 'ownership.txt'), 'utf8')).status).toBe('registered-unpaired');
    await expect(installPrepared(join(root, 'conflict'), binary, '0.0.1+1', { startup, environment })).rejects.toMatchObject({ code: 'EEXIST' });
    startup.uninstall(command); command = undefined; environment.write(null);
    class FailingValue extends UserEnvironmentValue {
      fail = true;
      override write(value: RegistryString | null) { super.write(value); if (this.fail) { this.fail = false; throw new Error('Injected failure after registry commit'); } }
    }
    const failing = new FailingValue(environment.name), failed = join(root, 'failed');
    await expect(installPrepared(failed, binary, '0.0.1+1', { startup, environment: failing })).rejects.toThrow('Injected failure');
    expect(startup.read()).toBeNull(); expect(environment.read()).toBeNull();
    expect(JSON.parse(await readFile(join(failed, 'ownership.txt'), 'utf8')).status).toBe('rolled-back');
    class FailingStartup extends UserAutorun {
      override install(command: string) { super.install(command);throw new Error('Injected failure after startup commit'); }
    }
    await expect(installPrepared(join(root,'failed-startup'),binary,'0.0.1+1',{startup:new FailingStartup(startup.name),environment})).rejects.toThrow('after startup commit');
    expect(startup.read()).toBeNull();expect(environment.read()).toBeNull();
    expect(realPath.read()).toEqual(before);
  } finally {
    if (command) startup.uninstall(command); environment.write(null);
    if (!contains(base, realpathSync.native(root))) throw new Error('Unsafe cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
}, 60000);
