// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { win32 as p } from 'node:path';
import { error, nativeRealpath } from './paths';
import type { Env } from '../types';
export const gitEnvironment={GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GIT_OPTIONAL_LOCKS:'0',GIT_LITERAL_PATHSPECS:'1',GIT_PAGER:'cat',GIT_SSH_COMMAND:'ssh -o BatchMode=yes -o NumberOfPasswordPrompts=0 -o StrictHostKeyChecking=yes',GIT_SSH_VARIANT:'ssh',LC_ALL:'C.UTF-8',LANG:'C.UTF-8'};
export const clearGitEnvironment=['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_CONFIG_COUNT','GIT_CONFIG_PARAMETERS','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES','GIT_COMMON_DIR','GIT_PREFIX','GIT_EXTERNAL_DIFF','GIT_DIFF_OPTS'];
const common=['-c','core.quotePath=false','-c','i18n.logOutputEncoding=utf-8','-c','i18n.commitEncoding=utf-8','-c','color.ui=false','-c','credential.interactive=never'];
const restricted=['-c','core.fsmonitor=false','-c','core.hooksPath=NUL','-c','protocol.ext.allow=never'];
export function environment(env:Env):Env{
  const result={...env,...gitEnvironment};for(const key of clearGitEnvironment)delete (result as Env)[key];return result;
}
export function gitArguments(args:string[],limited:boolean){
  // Empty diff.external executes an empty name. Suppress both external drivers
  // and attribute-selected textconv helpers through command options instead.
  const command=['diff','show','log'].includes(args[0])?[args[0],'--no-ext-diff','--no-textconv',...args.slice(1)]:args;
  return [...common,...(limited?restricted:[]),...command];
}
export async function findGit(env:NodeJS.ProcessEnv=process.env):Promise<string>{
  const candidates=[Bun.which('git.exe',{PATH:env.PATH??env.Path}),...[env.ProgramFiles,env['ProgramFiles(x86)'],env.LOCALAPPDATA&&p.join(env.LOCALAPPDATA,'Programs')].filter(Boolean).map(base=>p.join(base!,'Git/cmd/git.exe'))];
  for(const candidate of candidates){if(!candidate)continue;try{return await nativeRealpath(candidate);}catch(e:any){if(e.code!=='ENOENT'&&e.code!=='ENOTDIR')throw e;}}
  const{gitInstallPaths}=await import('./registry');
  for(const base of gitInstallPaths()){try{return await nativeRealpath(p.join(base,'cmd/git.exe'));}catch(e:any){if(e.code!=='ENOENT')throw e;}}
  throw error('ENOENT','Git for Windows not found in PATH, default locations or registry');
}
