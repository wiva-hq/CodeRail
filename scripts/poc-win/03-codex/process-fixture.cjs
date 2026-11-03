// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
const {spawn}=require('node:child_process');
const fs=require('node:fs');
const [mode, oracle]=process.argv.slice(2);
const record = pid => fs.appendFileSync(oracle,JSON.stringify({pid})+'\n','utf8');
record(process.pid);
if(mode==='leaf') {
  const ping=spawn('ping.exe',['-t','127.0.0.1'],{windowsHide:true,stdio:'ignore'});record(ping.pid);
} else {
  if(mode==='churn') for(let i=0;i<12;i++) spawn('cmd.exe',['/d','/c','exit','0'],{windowsHide:true,stdio:'ignore'});
  const child=spawn(process.execPath,[__filename,'leaf',oracle],{windowsHide:true,stdio:'ignore',detached:mode==='root-exits'});record(child.pid);
  if(mode==='root-exits') { child.unref(); process.exit(0); }
}
setInterval(()=>{},1000);
