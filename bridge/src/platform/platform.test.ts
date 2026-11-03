// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPlatformAdapter } from './index';
import { createPosixAdapter } from './posix';
import { createService } from './posix/service';
import { PlatformUnsupportedError, type RunResult, type ServiceSpec } from './types';

const scratch: string[] = [];
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'coderail-platform-'));
  scratch.push(root);
  return root;
}
afterEach(() => {
  for (const root of scratch.splice(0)) {
    // Only remove directories created by this test, under the OS temp root.
    if (!resolve(root).startsWith(resolve(tmpdir()) + '\\') && !resolve(root).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unsafe test cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('platform selection and authorization boundaries', () => {
  test('rejects unsupported platforms', () => {
    expect(() => createPlatformAdapter('freebsd')).toThrow(PlatformUnsupportedError);
  });

  for (const os of ['darwin', 'linux'] as const) {
    test(`${os}: checks directory boundaries, root, traversal and case`, () => {
      const path = createPosixAdapter(os).path;
      expect(path.contains('/work', '/work')).toBe(true);
      expect(path.contains('/work/', '/work/a')).toBe(true);
      expect(path.contains('/', '/work')).toBe(true);
      expect(path.contains('/work', '/work-else/a')).toBe(false);
      expect(path.contains('/work', '/work/../secret')).toBe(false);
      expect(path.contains('/Work', '/work/a')).toBe(false);
      expect(path.hasSegment('/work/.GIT/config', '.git')).toBe(true);
      expect(path.hasSegment('/work/.github/config', '.git')).toBe(false);
    });
  }

  test('unimplemented Windows capabilities fail closed instead of executing POSIX commands', async () => {
    const win = createPlatformAdapter('win32');
    expect(win.path.delimiter).toBe(';');
    expect(() => win.process.spawn(['systemctl'])).toThrow(PlatformUnsupportedError);
    expect(() => win.shell.openExternal('https://example.com')).toThrow(PlatformUnsupportedError);
    expect(win.git.nullFile).toBe('NUL');
    expect(win.git.environment({}).GCM_INTERACTIVE).toBe('never');
  });

  test('Windows lexical authorization uses drive/UNC boundaries and native separators', () => {
    const win = createPlatformAdapter('win32');
    expect(win.path.contains('C:\\work', 'c:/WORK/file')).toBe(true);
    expect(win.path.contains('C:\\work', 'C:\\work-other')).toBe(false);
    expect(win.path.contains('C:\\work', 'C:\\work\\..\\secret')).toBe(false);
    expect(win.path.contains('\\\\server\\share', '\\\\server\\share-other')).toBe(false);
    expect(win.path.hasSegment('C:\\work\\.GIT\\config', '.git')).toBe(true);
    expect(win.fs.openScope).toBeDefined();
  });
});

describe('native path resolution', () => {
  test('resolves junctions/symlinks before authorizing existing and new paths', async () => {
    const root = temp();
    const allowed = join(root, 'allowed');
    const outside = join(root, 'outside 中文');
    mkdirSync(allowed); mkdirSync(outside);
    const link = join(allowed, 'escape');
    symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
    const fs = createPosixAdapter('linux').fs;
    expect(await fs.canonicalize(link, 'existing')).toBe(realpathSync.native(outside));
    expect(await fs.canonicalize(join(link, 'new', 'file.txt'), 'create')).toBe(join(realpathSync.native(outside), 'new', 'file.txt'));
    await expect(fs.canonicalize(join(link, 'missing'), 'existing')).rejects.toThrow();
  });

  test('does not treat a non-directory error as a creatable path', async () => {
    const root = temp();
    const file = join(root, 'file');
    writeFileSync(file, '中文', 'utf8');
    await expect(createPosixAdapter('linux').fs.canonicalize(join(file, 'child'), 'create')).rejects.toThrow();
  });

  test('rejects creation through a dangling junction/symlink', async () => {
    const root = temp();
    const target = join(root, 'target');
    mkdirSync(target);
    const link = join(root, 'link');
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    rmdirSync(target);
    await expect(createPosixAdapter('linux').fs.canonicalize(join(link, 'new.txt'), 'create')).rejects.toThrow();
  });
});

describe('POSIX service migration without starting services', () => {
  const ok: RunResult = { code: 0, stdout: '', stderr: '' };
  function spec(root: string): ServiceSpec {
    return { home: root, stateDir: join(root, '.coderail'), logPath: join(root, 'bridge.log'), command: ['/opt/Code Rail/bridge', 'run'], quiet: true };
  }

  test('Linux retains unit options and command ordering', async () => {
    const calls: string[][] = [];
    const service = createService('linux', async cmd => { calls.push(cmd); return ok; });
    const root = temp();
    await service.install(spec(root));
    const unit = readFileSync(join(root, '.config/systemd/user/coderail.service'), 'utf8');
    expect(unit).toContain('ExecStart="/opt/Code Rail/bridge" "run"');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('WantedBy=default.target');
    expect(calls).toEqual([
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'coderail'],
      ['systemctl', '--user', 'restart', 'coderail'],
    ]);
    await service.uninstall(spec(root));
    expect(calls.at(-1)).toEqual(['systemctl', '--user', 'disable', '--now', 'coderail']);
  });

  test('macOS retains LaunchAgent arguments, UID domain and lifecycle order', async () => {
    const calls: string[][] = [];
    const service = createService('darwin', async cmd => {
      calls.push(cmd);
      return cmd[1] === 'print' ? { ...ok, code: 1 } : ok;
    }, () => 501);
    const root = temp();
    await service.install(spec(root));
    const plist = join(root, 'Library/LaunchAgents/codes.coderail.bridge.plist');
    expect(readFileSync(plist, 'utf8')).toContain('<array><string>/opt/Code Rail/bridge</string><string>run</string></array>');
    expect(calls).toEqual([
      ['launchctl', 'bootout', 'gui/501/codes.coderail.bridge'],
      ['launchctl', 'print', 'gui/501/codes.coderail.bridge'],
      ['launchctl', 'bootstrap', 'gui/501', plist],
    ]);
    await service.uninstall(spec(root));
    expect(calls.at(-1)).toEqual(['launchctl', 'bootout', 'gui/501/codes.coderail.bridge']);
  });
});
