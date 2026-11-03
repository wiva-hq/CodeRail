// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect, test} from 'bun:test';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {baseline} from '../common';
import {contains, retry} from '../04-filesystem/paths';
import {UserAutorun} from './autorun';
import {UserEnvironmentValue, type RegistryString} from './user-path';
import {installPrepared} from './install-transaction';
import {unregisterInstallation} from './uninstall-registration';

baseline();
test('uninstall registry crash recovery preserves later duplicate PATH entries and rejects third-party startup ownership', async () => {
  const base=realpathSync.native(tmpdir()), root=await mkdtemp(join(base,'crunreg-'));
  const startup=new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`), environment=new UserEnvironmentValue(`CodeRail-PoC-${crypto.randomUUID()}`), realPath=new UserEnvironmentValue(), original=realPath.read();
  try {
    const binary=join(root,'fixture.exe'), target=join(root,'CodeRail'), pe=Buffer.alloc(512);
    pe.write('MZ');pe.writeUInt32LE(0x80,0x3c);pe.writeUInt32LE(0x4550,0x80);pe.writeUInt16LE(0x8664,0x84);await writeFile(binary,pe);
    const installed=await installPrepared(target,binary,'0.0.1+1',{startup,environment});
    startup.uninstall(installed.command);startup.install('unrelated');
    await expect(unregisterInstallation(target,{startup,environment})).rejects.toMatchObject({code:'EEXIST'});
    expect(environment.read()?.text).toBe(join(target,'bin/current'));
    startup.uninstall('unrelated');startup.install(installed.command);
    const entry=join(target,'bin/current');environment.write({type:2,text:entry+';C:\\Later;'+entry});
    class CrashAfterWrite extends UserEnvironmentValue {
      override write(value: RegistryString|null) { super.write(value);throw new Error('Injected post-write crash'); }
    }
    await expect(unregisterInstallation(target,{startup,environment:new CrashAfterWrite(environment.name)})).rejects.toThrow('post-write crash');
    expect(startup.read()).toBeNull();expect(environment.read()?.text).toBe('C:\\Later;'+entry);
    await unregisterInstallation(target,{startup,environment});
    expect(environment.read()?.text).toBe('C:\\Later;'+entry);
    environment.write({type:1,text:'C:\\UserEdited;'+entry});
    expect((await unregisterInstallation(target,{startup,environment})).filesRetained).toBe(true);
    expect(environment.read()).toEqual({type:1,text:'C:\\UserEdited;'+entry});
    expect(realPath.read()).toEqual(original);
  } finally {
    const command=startup.read();if(command)startup.uninstall(command);environment.write(null);
    if(!contains(base,realpathSync.native(root)))throw new Error('Unsafe cleanup');await retry(()=>rm(root,{recursive:true}));
  }
},30000);
