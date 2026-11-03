// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {win32 as p} from 'node:path';
import {baseline} from '../common';
baseline();
test('Bun Windows spawning explicitly forwards environment values added by the current process',async()=>{
  const key='CODERAIL_POC_ENV_'+crypto.randomUUID().replaceAll('-',''),value=crypto.randomUUID();process.env[key]=value;
  try{
    const command=[p.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoLogo','-NoProfile','-NonInteractive','-Command',`[Console]::Write([Environment]::GetEnvironmentVariable('${key}'))`];
    const implicit=Bun.spawn(command,{stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
    const implicitText=await new Response(implicit.stdout).text();expect(await implicit.exited).toBe(0);
    const explicit=Bun.spawn(command,{env:{...process.env},stdin:'ignore',stdout:'pipe',stderr:'pipe',windowsHide:true});
    expect(await new Response(explicit.stdout).text()).toBe(value);expect(await explicit.exited).toBe(0);
    console.log(JSON.stringify({implicitForwardsCurrentChanges:implicitText===value,explicitForwardsCurrentChanges:true}));
  }finally{delete process.env[key];}
},15000);
