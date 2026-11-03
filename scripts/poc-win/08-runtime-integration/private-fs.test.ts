// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, baseline, ps, encoded } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { runWindows } from '../05-git/process';
import { currentSid, ensurePrivateDirectory, writePrivateFile } from './private-fs';

baseline();
test('non-elevated private directory/file: protected user+SYSTEM DACL, atomic UTF-8 writes, Junction rejection', async () => {
  const root = await mkdtemp(join(artifacts, 'private-acl-'));
  try {
    const dir = join(root, '私有 空格', 'nested'), file = join(dir, 'config.json');
    ensurePrivateDirectory(dir); writePrivateFile(file, '首次 中文😀'); writePrivateFile(file, '替换 中文😀');
    expect(await readFile(file, 'utf8')).toBe('替换 中文😀');
    const script = '$ErrorActionPreference="Stop";$paths=@($env:POC_DIR,$env:POC_FILE);foreach($p in $paths){$a=Get-Acl -LiteralPath $p;[PSCustomObject]@{protected=$a.AreAccessRulesProtected;rules=@($a.Access|ForEach-Object{[PSCustomObject]@{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;rights=[int]$_.FileSystemRights;inherited=$_.IsInherited}})}|ConvertTo-Json -Compress -Depth 4}';
    const r = await runWindows([ps, '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(script)], { envPatch: { POC_DIR: dir, POC_FILE: file }, clearEnv: ['PSModulePath'] });
    expect(r.stderr).not.toContain('S="Error"');
    expect(r.code).toBe(0);
    const rows = r.stdout.trim().split(/\r?\n/).map(line => JSON.parse(line)); expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.protected).toBe(true); expect(row.rules.length).toBe(2);
      expect(row.rules.map((x: any) => x.sid).sort()).toEqual([currentSid(), 'S-1-5-18'].sort());
      expect(row.rules.every((x: any) => !x.inherited && (x.rights & 0x1f01ff) === 0x1f01ff)).toBe(true);
    }
    const outside = join(root, 'outside'), link = join(root, 'escape'); await mkdir(outside); await writeFile(join(outside, 'secret'), 'untouched');
    await symlink(outside, link, 'junction');
    expect(() => ensurePrivateDirectory(link)).toThrow('Reparse point');
    expect(() => writePrivateFile(join(link, 'secret'), 'bad')).toThrow('Reparse point');
    expect(await readFile(join(outside, 'secret'), 'utf8')).toBe('untouched');
    console.log(JSON.stringify({ privateDacl: 'current-user+SYSTEM', atomicUtf8: true, junctionDenied: true }));
  } finally {
    if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
}, 20000);
