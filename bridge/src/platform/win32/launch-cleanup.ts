// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { win32 as p } from 'node:path';
import { NativeFile } from './native';
import { error } from './paths';
import { ProcessRef } from './job';
import { normalizeEnvironment, utf8 } from './shell';
import { guardInstallationRoot, readInstallation } from './install-files';
import { handoff } from './handoff';
import type { ActorIdentity } from './actor-control';

/** Local inactive-install fallback. Inherits any outer Job: this API does not
 * escape managed commands and must not replace a live supervisor handoff. */
export async function launchCleanup(input: string): Promise<ActorIdentity> {
  const root=await guardInstallationRoot(input), installed=readInstallation(root);
  if(!installed)throw error('EACCES','No owned installation');
  const directory=new NativeFile(root,true),caller=ProcessRef.open(process.pid);
  let actor:ReturnType<typeof handoff>|undefined, image:NativeFile|undefined;
  try {
    if(!caller)throw error('ESRCH','Cannot pin cleanup caller');
    try {
      const state=directory.child('supervisor.txt',false);
      try {
        const [pid,,nonce,created]=state.read(root,16384).toString('utf8').trim().split('\n');
        if(!/^\d+$/.test(pid)||!/^\d+$/.test(created)||!/^[a-f0-9]{32}$/.test(nonce))throw error('EINVAL','Invalid supervisor identity');
        const host=ProcessRef.open(Number(pid));
        try{if(host?.alive()&&String(host.created)===created)throw error('EBUSY','Use the running supervisor for cleanup');}finally{host?.close();}
      } finally {state.close();}
    } catch(cause:any){if(cause.code!=='ENOENT')throw cause;}
    image=directory.child('supervisor.exe',false);
    const bytes=image.read(root,1024*1024),nonce=crypto.randomUUID().replaceAll('-','');
    const script=utf8+`$ErrorActionPreference='Stop';try{$bytes=[IO.File]::ReadAllBytes($env:CR_IMAGE);$sha=[Security.Cryptography.SHA256]::Create();try{$hash=[BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()};if($hash -ne $env:CR_SHA){throw 'Helper hash mismatch'};$asm=[Reflection.Assembly]::Load($bytes);$asm.GetType('OwnedCleanup').GetMethod('Run').Invoke($null,@($env:CR_ROOT,$env:CR_ID,$env:CR_NONCE,0,'0',[int]$env:CR_CALLER,$env:CR_CALLER_CREATED))}catch{exit 1}`;
    const env:Record<string,string>={...normalizeEnvironment(process.env),CR_IMAGE:p.join(root,'supervisor.exe'),CR_SHA:new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),CR_ROOT:root,CR_ID:installed.id,CR_NONCE:nonce,CR_CALLER:String(caller.pid),CR_CALLER_CREATED:String(caller.created)};
    delete env.BUN_BE_BUN; delete env.CODERAIL_STOP_FILE;
    actor=handoff([p.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],p.dirname(root),env);
    const launched=actor;
    const deadline=performance.now()+10000;
    while(performance.now()<deadline){
      try {
        const file=directory.child('cleanup-ready-'+nonce,false);let state:ActorIdentity;
        try{state=JSON.parse(file.read(root,16384).toString('utf8'));}finally{file.close();}
        if(state.nonce!==nonce||state.pid!==launched.pid||state.created!==String(launched.created)||!/^\d+$/.test(state.jobHandle)||Number(state.jobHandle)<=0||!Number.isSafeInteger(Number(state.jobHandle)))throw error('EACCES','Cleanup acknowledgement identity mismatch');
        launched.detach();actor=undefined;return state;
      }catch(cause:any){if(cause.code!=='ENOENT')throw cause;}
      if(!launched.alive())throw error('EIO','Cleanup actor exited before acknowledgement');
      await Bun.sleep(25);
    }
    throw error('ETIMEDOUT','Cleanup actor did not acknowledge');
  } finally {image?.close();caller?.close();directory.close();await actor?.dispose();}
}
