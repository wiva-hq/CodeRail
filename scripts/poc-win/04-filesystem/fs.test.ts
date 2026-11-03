// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { win32 as p, join } from 'node:path';
import { artifacts, assert, baseline, encoded, ps, until } from '../common';
import { ProcessRef } from '../03-codex/process-jobs';
import { launch } from '../../../bridge/src/platform/win32/launcher';
import { ScopedWindowsFs } from './fs';
import { canonicalize, contains, nativeRealpath, normalize, retry } from './paths';
import { recycle } from './recycle';
import { snapshot, SnapshotWatcher } from './watch';

baseline();
const scratch: string[] = [];
const capabilities: ScopedWindowsFs[] = [];
async function fixture() {
  const dir = await mkdtemp(join(artifacts, 'fs-win32-'));
  scratch.push(dir);
  const root = join(dir, '项目 空格 中文'); const outside = join(dir, 'outside');
  await mkdir(root); await mkdir(outside);
  const fs = await ScopedWindowsFs.create(root); capabilities.push(fs);
  return { dir, root: fs.root, outside, fs };
}
afterEach(async () => {
  for (const fs of capabilities.splice(0)) fs.close();
  for (const path of scratch.splice(0)) {
    const resolved = realpathSync.native(path);
    if (!contains(realpathSync.native(artifacts), resolved) || !p.basename(resolved).startsWith('fs-win32-')) throw new Error('Unsafe test cleanup');
    await rm(resolved, { recursive: true });
  }
});

describe('Windows scoped filesystem', () => {
  test('absolute DOS/UNC/extended syntax, case and path boundaries; ambiguous devices rejected', async () => {
    expect(normalize('C:/工作 空格/file.txt')).toBe('C:\\工作 空格\\file.txt');
    expect(normalize('\\\\?\\C:\\工作\\file')).toBe('C:\\工作\\file');
    expect(normalize('\\\\?\\UNC\\server\\share\\中文')).toBe('\\\\server\\share\\中文');
    expect(contains('C:\\work', 'c:/WORK/a')).toBe(true);
    expect(contains('C:\\work', 'C:\\work-more\\a')).toBe(false);
    expect(contains('C:\\work', 'C:\\work\\..\\secret')).toBe(false);
    expect(contains('C:\\work', 'D:\\work\\a')).toBe(false);
    expect(contains('\\\\server\\share\\work', '\\\\server\\share-else\\work')).toBe(false);
    for (const name of ['C:relative', '\\root-relative', '\\\\.\\PhysicalDrive0', '\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1', 'C:\\work\\file:secret', 'C:\\work\\NUL.txt', 'C:\\work\\a.']) expect(() => normalize(name)).toThrow();
    const { fs, root } = await fixture();
    await fs.write(join(root, '中文 空格😀.txt'), '中文 UTF-8 😀\r\n');
    expect((await fs.read(join(root.toUpperCase(), '中文 空格😀.txt'))).toString('utf8')).toBe('中文 UTF-8 😀\r\n');
  });

  test('native resolution denies junction escape for read, create, move, recycle and dangling links', async () => {
    const { fs, root, outside } = await fixture();
    await writeFile(join(outside, 'secret.txt'), 'secret');
    const escape = join(root, 'escape'); await symlink(outside, escape, 'junction');
    expect(await nativeRealpath(escape)).toBe(await nativeRealpath(outside));
    for (const action of [() => fs.read(join(escape, 'secret.txt')), () => fs.write(join(escape, 'new.txt'), 'bad'), () => fs.mkdir(join(escape, 'new-dir')), () => fs.recycle(escape, recycle)]) await expect(action()).rejects.toMatchObject({ code: 'EACCES' });
    await fs.write(join(root, 'own.txt'), 'own');
    await expect(fs.move(join(root, 'own.txt'), join(escape, 'moved.txt'))).rejects.toMatchObject({ code: 'EACCES' });
    const target = join(outside, 'gone'); await mkdir(target);
    const dangling = join(root, 'dangling'); await symlink(target, dangling, 'junction'); await rm(target, { recursive: true });
    await expect(fs.write(join(dangling, 'new.txt'), 'bad')).rejects.toThrow();
    await expect(canonicalize(join(root, 'own.txt', 'child'), 'create')).rejects.toThrow();
    expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
    expect(existsSync(join(outside, 'new.txt'))).toBe(false);
  });

  test('same-root junction works; denied state directory remains inaccessible', async () => {
    const { fs, root } = await fixture();
    const inner = join(root, 'inner'); await mkdir(inner); await symlink(inner, join(root, 'alias'), 'junction');
    await fs.write(join(root, 'alias', 'normal.txt'), 'inside');
    expect((await fs.read(join(inner, 'normal.txt'))).toString('utf8')).toBe('inside');
    const restricted = await ScopedWindowsFs.create(root, [inner]); capabilities.push(restricted);
    await expect(restricted.read(join(root, 'alias', 'normal.txt'))).rejects.toMatchObject({ code: 'EACCES' });
  });

  test('long paths over MAX_PATH and nested creates read/write/rename correctly', async () => {
    const { fs, root } = await fixture();
    const directory = join(root, ...Array.from({ length: 9 }, (_, i) => `第${i}层_${'long'.repeat(6)}`));
    expect(directory.length).toBeGreaterThan(300);
    await fs.mkdir('\\\\?\\' + directory);
    const original = join(directory, '原始 中文.txt'), moved = join(directory, '修改 空格.txt');
    await fs.write('\\\\?\\' + original, 'long path 中文😀');
    await fs.move(original, moved);
    expect((await fs.read('\\\\?\\' + moved)).toString('utf8')).toBe('long path 中文😀');
  });

  async function lock(path: string, ready: string, milliseconds: number, release?: string) {
    const proc = launch([ps, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(import.meta.dir, 'lock.ps1'), '-Path', path, '-Ready', ready, '-Milliseconds', String(milliseconds), ...(release ? ['-Release', release] : [])], p.dirname(path));
    const close = async () => { const refs=proc.members().map(pid=>ProcessRef.open(pid)).filter((ref):ref is ProcessRef=>!!ref);try{proc.closeJob();await until(()=>refs.every(ref=>!ref.alive()));}finally{for(const ref of refs)ref.close();proc.dispose();} };
    try { await until(() => existsSync(ready), 10000, 'exclusive file lock ready'); }
    catch(cause) { await close();throw cause; }
    return { async close() { await close(); } };
  }
  test('real exclusive lock is retried, then atomic replacement succeeds without truncation', async () => {
    const { fs, root } = await fixture(); const file = join(root, 'locked 中文.txt');
    await fs.write(file, 'original');
    const release = join(root, 'release.flag');
    const holder = await lock(file, join(root, 'ready.flag'), 20000, release); let retries = 0;
    try {
      await fs.write(file, 'replacement 中文😀', () => { retries++; if(retries===1)writeFileSync(release,'release','utf8'); });
      expect(retries).toBeGreaterThan(0);
      expect((await fs.read(file)).toString('utf8')).toBe('replacement 中文😀');
      expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally { await holder.close(); }
  }, 20000);

  test('permanent lock exhausts bounded retries, keeps old bytes and removes temporary files', async () => {
    const { fs, root } = await fixture(); const file = join(root, 'busy.txt'); await fs.write(file, 'original');
    const holder = await lock(file, join(root, 'ready.flag'), 20000); let retries = 0;
    try {
      await expect(fs.write(file, 'must not appear', () => retries++)).rejects.toThrow();
      expect(retries).toBe(4);
      expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([]);
    } finally { await holder.close(); }
    expect((await fs.read(file)).toString('utf8')).toBe('original');
  }, 20000);

  test('only sharing/permission errors retry; malformed or missing paths fail immediately', async () => {
    let calls = 0;
    await expect(retry(async () => { calls++; throw Object.assign(new Error('invalid'), { code: 'EINVAL' }); })).rejects.toThrow('invalid');
    expect(calls).toBe(1);
    const { fs, root } = await fixture();
    await expect(fs.write(join(root, 'missing', 'file.txt'), 'x')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('held native directory handle prevents junction replacement during a write', async () => {
    const { fs, root, outside } = await fixture();
    const inner = join(root, 'inner'); await mkdir(inner);
    await fs.write(join(inner, 'file.txt'), 'original');
    const path = join(inner, 'file.txt'), ready = join(root, 'ready.flag');
    const holder = await lock(path, ready, 250); let swapPrevented = false;
    try {
      await fs.write(path, 'new', async () => {});
      // Root capability is itself pinned: renaming its root must be refused by Windows.
      try { await rename(root, root + '-swapped'); } catch (e: any) { expect(['EPERM', 'EACCES', 'EBUSY']).toContain(e.code); swapPrevented = true; }
      expect(swapPrevented).toBe(true);
      expect((await fs.read(path)).toString('utf8')).toBe('new');
      expect((await readdir(outside)).length).toBe(0);
    } finally { await holder.close(); }
  }, 20000);

  test('snapshot watcher reconciles high-frequency writes, renames and null/overflow invalidation', async () => {
    const { fs, root, outside } = await fixture();
    await writeFile(join(outside, 'secret.txt'), 'never read'); await symlink(outside, join(root, 'escape'), 'junction');
    let latest = new Map<string, string>(); const errors: Error[] = [];
    const watcher = new SnapshotWatcher(fs, value => { latest = new Map(value); }, e => errors.push(e), 200);
    await watcher.start();
    try {
      const nested = join(root, '目录'); await mkdir(nested);
      await Promise.all(Array.from({ length: 120 }, (_, i) => writeFile(join(nested, `中文 ${i}.txt`), `payload ${i}`, 'utf8')));
      await rename(join(nested, '中文 0.txt'), join(nested, 'renamed.txt')); await unlink(join(nested, '中文 1.txt'));
      for (let i = 0; i < 30; i++) await writeFile(join(root, 'hot.txt'), `update ${i}`, 'utf8');
      watcher.invalidate(); // Same invalidation path as a null filename / overflow.
      const expected = await snapshot(fs);
      await until(() => latest.has('目录\\renamed.txt') && latest.size === 122 && [...expected].every(([name, value]) => latest.get(name) === value), 15000, 'final snapshot fingerprints converged');
      expect([...latest]).toEqual([...(await snapshot(fs))]);
      expect([...latest.keys()].some(name => name.includes('secret'))).toBe(false);
      expect(errors).toEqual([]);
      console.log(JSON.stringify({ snapshotEntries: latest.size, nativeEvents: watcher.events, scans: watcher.scans }));
    } finally { await watcher.close(); }
  }, 30000);

  test('recycle creates a real per-user Recycle Bin record, restores exact bytes; UNC refuses permanent deletion', async () => {
    const { fs, root } = await fixture(); const file = join(root, `回收 空格 ${crypto.randomUUID()}.txt`);
    const payload = 'recoverable 中文😀'; await fs.write(file, payload);
    await fs.recycle(file, recycle); expect(existsSync(file)).toBe(false);
    const sidProcess = Bun.spawn([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value')], { windowsHide: true, stdout: 'pipe', stderr: 'pipe' });
    const sid = (await new Response(sidProcess.stdout).text()).trim(); expect(await sidProcess.exited).toBe(0); expect(sid).toMatch(/^S-1-/);
    const bin = join(p.parse(root).root, '$Recycle.Bin', sid);
    let restored = false;
    for (const name of await readdir(bin)) {
      if (!/^\$I[^\\]+$/.test(name)) continue;
      const info = await readFile(join(bin, name));
      const version = Number(info.readBigUInt64LE(0));
      const original = info.subarray(version === 2 ? 28 : 24).toString('utf16le').replace(/\0.*$/s, '');
      if (original.toLowerCase() !== file.toLowerCase()) continue;
      const data = join(bin, '$R' + name.slice(2));
      expect(await readFile(data, 'utf8')).toBe(payload);
      await rename(data, file); await unlink(join(bin, name)); restored = true; break;
    }
    expect(restored).toBe(true); expect((await fs.read(file)).toString('utf8')).toBe(payload);
    await expect(recycle('\\\\server\\share\\file')).rejects.toMatchObject({ code: 'ENOTSUP' });
  }, 30000);
});
