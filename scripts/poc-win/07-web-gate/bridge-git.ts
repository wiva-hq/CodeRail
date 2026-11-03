// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import type { ScopedWindowsFs } from '../04-filesystem/fs';
import type { WindowsGit } from '../05-git/git';

/** Run the existing protocol-facing Git handlers unchanged with candidate
 * platform dependencies. Test-only bundling; no production adapter switch. */
export async function loadBridgeGit(fs: ScopedWindowsFs, git: WindowsGit, output: string) {
  const key = `__coderail_gate_${crypto.randomUUID().replaceAll('-', '')}`;
  const root = fs.root.replaceAll('\\', '/');
  (globalThis as any)[key] = {
    HOME: root,
    run: (command: string[], options: any) => git.run(command.slice(1), options.cwd, { input:options.input,timeout:options.timeout }),
    userEnv: async () => ({}),
    checkPath: async (path: string) => (await fs.authorize(path, 'create')).replaceAll('\\', '/'),
    platform: { git: { environment: (env: any) => env, safeArguments: [], nullFile: 'NUL' } },
  };
  const entry = join(import.meta.dir, '../../../bridge/src/git.ts');
  const result = await Bun.build({entrypoints:[entry],target:'bun',format:'esm',plugins:[{
    name:'gate-platform-dependencies',setup(build) {
      build.onResolve({filter:/^\.\/(env|scope|platform)$/},args => args.importer.replaceAll('\\','/') === entry.replaceAll('\\','/') ? {path:args.path.slice(2),namespace:'gate'} : undefined);
      build.onLoad({filter:/.*/,namespace:'gate'},args => ({loader:'ts',contents:`const deps=(globalThis as any)[${JSON.stringify(key)}]; ${args.path==='env' ? 'export const HOME=deps.HOME; export const run=deps.run; export const userEnv=deps.userEnv; export class RpcError extends Error { constructor(public code:number,message:string){super(message)} }' : args.path==='scope' ? 'export const checkPath=deps.checkPath;' : 'export const platform=deps.platform;'}`}));
    },
  }]});
  if (!result.success) throw new Error(result.logs.map(String).join('\n'));
  await Bun.write(output,result.outputs[0]);
  return { handlers: await import(output), dispose() { delete (globalThis as any)[key]; } };
}
