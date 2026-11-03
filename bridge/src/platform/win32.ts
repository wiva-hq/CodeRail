// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { homedir } from 'node:os';
import { win32 } from 'node:path';
import { PlatformUnsupportedError, type PlatformAdapter } from './types';
import { canonicalize, contains, containsCanonical, normalize } from './win32/paths';
import { environment, findGit, gitArguments } from './win32/git';
import { defaultCommand, findExecutable, userEnv } from './win32/shell';

/** Each capability is enabled only after its independent Windows gate. */
export function createWindowsAdapter(): PlatformAdapter {
  const unsupported = (feature: string): never => { throw new PlatformUnsupportedError('win32', feature); };
  const stateDir = () => process.env.CODERAIL_HOME ?? win32.join(process.env.LOCALAPPDATA ?? win32.join(homedir(), 'AppData/Local'), 'CodeRail');
  return {
    os: 'win32',
    path: {
      delimiter: ';', home: homedir,
      stateDir,
      basename: win32.basename,
      expandUser: p => p === '~' ? homedir() : /^~[\\/]/.test(p) ? win32.join(homedir(), p.slice(2)) : p,
      contains,
      hasSegment: (p, segment) => normalize(p).split(/[\\/]/).some(part => part.toLowerCase() === segment.toLowerCase()),
    },
    process: {
      spawn: () => unsupported('process spawning'),
      async spawnManaged(command, options) {
        if (process.platform !== 'win32') return unsupported('native Windows managed process on this host');
        return (await import('./win32/stream')).spawnStream(command, options);
      },
      stopLegacy: () => unsupported('process termination'),
      async run(command, options) {
        if (process.platform !== 'win32') return unsupported('native Windows process execution on this host');
        return (await import('./win32/process')).run(command, options);
      },
      onShutdown(handler) {
        process.on('SIGINT', handler); process.on('SIGTERM', handler);
        return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
      },
    },
    shell: {
      async userEnv() {
        if (process.platform !== 'win32') return unsupported('native Windows environment on this host');
        return userEnv();
      },
      findExecutable,
      defaultCommand,
      openExternal: () => unsupported('opening external URLs'),
    },
    fs: {
      containsCanonical,
      async canonicalize(input, intent) {
        if (process.platform !== 'win32') return unsupported('native Windows path resolution on this host');
        return (await canonicalize(input, intent)).replaceAll('\\', '/');
      },
      async openScope(root, denied) {
        if (process.platform !== 'win32') return unsupported('native Windows filesystem on this host');
        return (await import('./win32/fs')).ScopedWindowsFs.create(root, denied);
      },
      ensurePrivateDirectory(path) {
        if (process.platform !== 'win32') return unsupported('private directory ACL on this host');
        // Synchronous contract, native module is loaded only on an actual Windows host.
        (require('./win32/private-fs') as typeof import('./win32/private-fs')).ensurePrivateDirectory(path);
      },
      writePrivateFile(path, content) {
        if (process.platform !== 'win32') return unsupported('private file ACL on this host');
        (require('./win32/private-fs') as typeof import('./win32/private-fs')).writePrivateFile(path, content);
      },
      async trash(path) {
        if (process.platform !== 'win32') return unsupported('Recycle Bin on this host');
        const { ScopedWindowsFs } = await import('./win32/fs');
        const { recycle } = await import('./win32/recycle');
        const fs = await ScopedWindowsFs.create(win32.dirname(path));
        try { await fs.recycle(path, recycle); return path; } finally { fs.close(); }
      },
      hasFullDiskAccess: async () => null,
    },
    net: { proxyFor(url) {
      if (process.platform !== 'win32') return unsupported('native Windows proxy configuration on this host');
      return (require('./win32/system-proxy') as typeof import('./win32/system-proxy')).proxyFor(url);
    }, async listeningPorts() {
      if (process.platform !== 'win32') return unsupported('native Windows port discovery on this host');
      return (await import('./win32/net')).listeningPorts();
    } },
    service: {
      async details() {
        if (process.platform !== 'win32') return unsupported('native Windows service resources on this host');
        const { UserService } = await import('./win32/service');
        return new UserService().details({ stateDir: stateDir(), command: [], home: homedir(), logPath: win32.join(stateDir(), 'bridge.log') });
      },
      async status() {
        if (process.platform !== 'win32') return unsupported('native Windows service on this host');
        const { UserService } = await import('./win32/service');
        const status = await new UserService().status({ stateDir: stateDir(), command: [], home: homedir(), logPath: win32.join(stateDir(), 'bridge.log') });
        return status.running ? `running (pid ${status.pid}, bridge ${status.childPid})` : 'stopped';
      },
      async install(spec) {
        if (process.platform !== 'win32') return unsupported('native Windows service on this host');
        const { UserService } = await import('./win32/service'); await new UserService().install(spec);
      },
      async uninstall(spec) {
        if (process.platform !== 'win32') return unsupported('native Windows service on this host');
        const { UserService } = await import('./win32/service'); await new UserService().uninstall(spec);
      },
      async followLogs(path) {
        if (process.platform !== 'win32') return unsupported('native Windows logs on this host');
        const { printLogs } = await import('./win32/logs');
        const controller = new AbortController(), stop = () => controller.abort();
        process.on('SIGINT', stop);
        try { await printLogs(path, { follow: true, signal: controller.signal }); }
        finally { process.off('SIGINT', stop); }
      },
    },
    git: {
      nullFile:'NUL',safeArguments:gitArguments([],true),environment,
      arguments:gitArguments,
      async executable(){if(process.platform!=='win32')return unsupported('Git for Windows on this host');return findGit();},
    },
  };
}
