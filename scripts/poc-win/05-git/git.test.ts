// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assertGone, baseline, until } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { findGit, WindowsGit, gitEnvironment } from './git';
import { runWindows } from './process';

baseline(); const scratch: string[] = [];
afterEach(async () => { for (const dir of scratch.splice(0)) { if (!contains(artifacts, dir) || !dir.includes('git-win32-')) throw new Error('Unsafe test cleanup'); await retry(()=>rm(dir, { recursive: true })); } });
async function repository() {
  const root = await mkdtemp(join(artifacts, 'git-win32-')); scratch.push(root);
  const cwd = join(root, '仓库 空格'); await mkdir(cwd);
  const git = new WindowsGit(await findGit());
  for (const args of [['init'], ['config', 'user.name', 'Windows PoC'], ['config', 'user.email', 'poc@localhost'], ['config', 'core.autocrlf', 'true']]) expect((await git.run(args, cwd)).code).toBe(0);
  return { git, cwd, root };
}
test('Git discovery finds actual executable and no-headless-prompt configuration is effective', async () => {
  const { git, cwd } = await repository();
  expect((await git.run(['--version'], cwd)).stdout).toContain('windows');
  expect((await git.run(['config', '--get', 'core.quotePath'], cwd)).stdout.trim()).toBe('false');
  expect(gitEnvironment.GCM_INTERACTIVE).toBe('never'); expect(gitEnvironment.GIT_TERMINAL_PROMPT).toBe('0');
  const gcm = await git.run(['credential-manager', '--version'], cwd); expect(gcm.code).toBe(0);
  console.log(JSON.stringify({ git: git.executable, gcmVersion: gcm.stdout.trim() }));
}, 30000);

test('UTF-8 Chinese filenames, CRLF/LF mixed repo, literal paths, diff and local commit', async () => {
  const { git, cwd } = await repository();
  await writeFile(join(cwd, '.gitattributes'), '*.txt text\n*.sh text eol=lf\n', 'utf8');
  await writeFile(join(cwd, '中文 空格.txt'), '第一行\r\n第二行\r\n', 'utf8');
  await writeFile(join(cwd, 'script.sh'), 'echo one\necho two\n', 'utf8');
  for (const args of [['add', '--', '.'], ['commit', '-m', '初始 提交😀']]) expect((await git.run(args, cwd)).code).toBe(0);
  expect((await git.run(['status', '--porcelain=v2', '-z'], cwd)).stdout).toBe('');
  await writeFile(join(cwd, '中文 空格.txt'), '第一行\r\n改动 中文😀\r\n', 'utf8');
  const diff = await git.run(['diff', '--', '中文 空格.txt'], cwd);
  expect(diff.code, diff.stderr).toBe(0); expect(diff.stdout).toContain('中文 空格.txt'); expect(diff.stdout).toContain('+改动 中文😀'); expect(diff.stdout).not.toContain('-第一行');
  const status = await git.run(['status', '--porcelain=v2', '-z'], cwd); expect(status.stdout).toContain('中文 空格.txt');
  await writeFile(join(cwd, 'literal[1].txt'), 'only literal\r\n'); await writeFile(join(cwd, 'literal1.txt'), 'must stay untracked\r\n');
  expect((await git.run(['add', '--', 'literal[1].txt', '中文 空格.txt'], cwd)).code).toBe(0);
  const staged = await git.run(['diff', '--cached', '--name-only', '-z'], cwd); expect(staged.stdout).toContain('literal[1].txt\0'); expect(staged.stdout).not.toContain('literal1.txt\0');
  expect((await git.run(['commit', '-m', '中文变更 😀'], cwd)).code).toBe(0);
  expect((await git.run(['log', '-1', '--format=%s'], cwd)).stdout.trim()).toBe('中文变更 😀');
  expect((await git.run(['config', '--get', 'core.autocrlf'], cwd)).stdout.trim()).toBe('true');
}, 60000);

test('restricted Git cannot execute a repository pre-commit hook', async () => {
  const { git, cwd } = await repository(); const marker = join(cwd, 'hook-ran');
  await writeFile(join(cwd, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf ran > hook-ran\nexit 1\n', 'utf8');
  await writeFile(join(cwd, 'tracked.txt'), 'safe\r\n');
  expect((await git.run(['add', '--', '.'], cwd)).code).toBe(0);
  const commit = await git.run(['commit', '-m', 'hooks disabled'], cwd);
  expect(commit.code).toBe(0); expect(existsSync(marker)).toBe(false);
}, 30000);

test('managed command timeout closes the entire nested process Job', async () => {
  const root = await mkdtemp(join(artifacts, 'git-win32-')); scratch.push(root);
  const script = join(root, 'tree.cjs'), oracle = join(root, 'pids.json');
  const node = Bun.which('node.exe'); expect(node).toBeTruthy();
  await writeFile(script, `const {spawn}=require('node:child_process');const fs=require('node:fs');if(process.argv[2]==='leaf'){const p=spawn('ping.exe',['-t','127.0.0.1'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(oracle)},JSON.stringify([process.pid,p.pid]));}else spawn(process.execPath,[__filename,'leaf'],{stdio:'ignore',windowsHide:true});setInterval(()=>{},1000);`);
  await expect(runWindows([node!, script], { cwd: root, timeout: 2000 })).rejects.toThrow('managed command');
  await until(() => existsSync(oracle), 1000, 'nested fixture started');
  const pids = JSON.parse(await readFile(oracle, 'utf8')); await assertGone(pids);
}, 20000);
