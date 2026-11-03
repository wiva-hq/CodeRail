// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { artifacts, baseline, assertGone } from '../common';
import { contains, retry } from '../04-filesystem/paths';
import { run } from '../../../bridge/src/platform/win32/process';
import { runWindows } from '../05-git/process';

baseline();
test('production managed runner: UTF-8, environment in memory, failure, timeout clears nested Job', async () => {
  const root = await mkdtemp(join(artifacts, 'runtime-process-')), previous = process.env.CODERAIL_HOME;
  process.env.CODERAIL_HOME = join(root, 'state');
  try {
    const result = await run([process.execPath, '-e', 'process.stdout.write("中文😀:"+process.env.POC_MEMORY_ONLY)'], { env: { ...process.env as Record<string, string>, POC_MEMORY_ONLY: 'safe-test-value' } });
    expect(result).toEqual({ code: 0, stdout: '中文😀:safe-test-value', stderr: '' });
    const failed = await run([process.execPath, '-e', 'console.error("预期错误");process.exit(7)']);
    expect(failed.code).toBe(7); expect(failed.stderr).toContain('预期错误');
    const output = join(root, 'pids.json');
    const nested = `const child=Bun.spawn([process.execPath,'-e','Bun.spawn(["ping.exe","-t","127.0.0.1"],{stdout:"ignore"});setInterval(()=>{},1000)'],{stdout:'ignore'});await Bun.write(${JSON.stringify(output)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`;
    await expect(run([process.execPath, '-e', nested], { timeout: 1000 })).rejects.toThrow('timed out');
    const pids = JSON.parse(await readFile(output, 'utf8')); await assertGone(pids);
    expect(await readdir(join(root, 'state/runtime'))).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.CODERAIL_HOME; else process.env.CODERAIL_HOME = previous;
    if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
}, 30000);

test('compiled managed runner executes embedded worker without node/bun on PATH', async () => {
  const root = await mkdtemp(join(artifacts, 'runtime-compile-'));
  try {
    const entry = join(root, 'entry.ts'), exe = join(root, 'runtime.exe'), work = join(root, 'work'); await mkdir(work);
    const implementation = join(import.meta.dir, '../../../bridge/src/platform/win32.ts').replaceAll('\\', '/');
    await writeFile(entry, `import {createWindowsAdapter} from ${JSON.stringify(implementation)};const win=createWindowsAdapter();win.fs.ensurePrivateDirectory(process.env.CODERAIL_HOME);const cmd=process.env.SystemRoot+'\\\\System32\\\\cmd.exe';const result=await win.process.run([cmd,'/D','/C','echo embedded-worker-ok']);const child=await win.process.spawnManaged([cmd,'/D','/C','echo embedded-stream-ok'],{cwd:process.cwd()});const stdout=await new Response(child.stdout).text();const code=await child.exited;console.log(JSON.stringify({result,stream:{stdout,code}}));`);
    const build = await runWindows([process.execPath, 'build', '--compile', '--outfile', exe, entry], { timeout: 90000 });
    expect(build.code).toBe(0);
    const result = await runWindows([exe], { cwd: work, timeout: 20000, envPatch: { CODERAIL_HOME: join(root, 'state'), PATH: join(process.env.SystemRoot!, 'System32') }, clearEnv: ['BUN_BE_BUN'] });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ result: { code: 0, stdout: 'embedded-worker-ok\r\n', stderr: '' }, stream: { code: 0, stdout: 'embedded-stream-ok\r\n' } });
    console.log(JSON.stringify({ compiledRuntime: true, embeddedWorker: true, noNodeBunOnPath: true }));
  } finally {
    if (!contains(artifacts, root)) throw new Error('Unsafe fixture cleanup');
    await retry(() => rm(root, { recursive: true }));
  }
}, 120000);
