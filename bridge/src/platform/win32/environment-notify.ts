// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {win32 as p} from 'node:path';
import {run} from './process';
import {utf8} from './shell';

/** A whole managed helper Job bounds HWND_BROADCAST's per-window timeout. */
export async function notifyEnvironmentChange() {
  const source='using System;using System.Runtime.InteropServices;public class CodeRailEnvironment{[DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);[DllImport("kernel32.dll")]public static extern void SetLastError(uint e);}';
  const script=utf8+`$ErrorActionPreference='Stop';Add-Type -TypeDefinition '${source}';[CodeRailEnvironment]::SetLastError(0);$out=[UIntPtr]::Zero;$sent=[CodeRailEnvironment]::SendMessageTimeout([IntPtr]65535,26,[UIntPtr]::Zero,'Environment',2,100,[ref]$out);$code=[Runtime.InteropServices.Marshal]::GetLastWin32Error();if($sent -ne [IntPtr]::Zero){'{"status":"sent"}'}else{'{"status":"unavailable","win32":'+$code+'}'}`;
  try {
    const result=await run([p.join(process.env.SystemRoot!,'System32/WindowsPowerShell/v1.0/powershell.exe'),'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{timeout:5000});
    if(result.code!==0)return {status:'unavailable' as const,reason:'notification helper failed'};
    const value=JSON.parse(result.stdout.trim());
    if(value.status==='sent')return {status:'sent' as const};
    return {status:'unavailable' as const,reason:`Win32 ${Number(value.win32)}`};
  }catch{return {status:'unavailable' as const,reason:'notification helper failed or exceeded 5 seconds'};}
}
