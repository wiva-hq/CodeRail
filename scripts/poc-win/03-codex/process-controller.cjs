// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
const {spawn}=require('node:child_process');
const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
console.log(JSON.stringify({ready:true,sentinel:sentinel.pid}));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
  const m=JSON.parse(line);
  spawn(m.argv[0],m.argv.slice(1),{windowsHide:true,stdio:'ignore'});
});
