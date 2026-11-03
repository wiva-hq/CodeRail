// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { artifacts, assert, assertGone, ps, result, until } from '../common';
import { SessionWorker } from './session-worker';

export async function acpCommandRecovery() {
  return result('acp-command-session-job-cancel-load-continue', async () => {
    const dir=join(artifacts,`ACP owned 中文 ${Date.now()}`);mkdirSync(dir);const cwd=realpathSync.native(dir);
    const fixture=join(cwd,`${crypto.randomUUID()}.ps1`), nodeScript=join(cwd,'descendants.cjs');
    await Bun.write(nodeScript, `const {spawn}=require('node:child_process');const fs=require('node:fs');if(process.argv[2]==='leaf'){spawn('ping.exe',['-t','127.0.0.1'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(__dirname+'/started.flag','ready','utf8')}else spawn(process.execPath,[__filename,'leaf'],{windowsHide:true,stdio:'ignore'});setInterval(()=>{},1000);`);
    await Bun.write(fixture,`\ufeff[IO.File]::WriteAllText((Join-Path $PSScriptRoot "write-permission.flag"),"approval"); & '${process.env.POC_NODE_PATH!}' '${nodeScript}'`);
    const worker=new SessionWorker(cwd,'acp');await worker.start();
    try{
      const session=await worker.rpc.call('session/new',{cwd,mcpServers:[]},60000);const sessionId=session.sessionId;
      const marker=`ACP_MEMORY_${crypto.randomUUID()}`;
      await worker.rpc.call('session/prompt',{sessionId,prompt:[{type:'text',text:`Remember this exact marker: ${marker}. Reply only READY. Do not use tools.`}]},120000);
      const command=`& '${ps}' -NoProfile -ExecutionPolicy Bypass -File '${fixture}'`;
      let approvalCount=0,approvalFailure:Error|undefined;
      worker.rpc.onRequest=async message=>{
        try{
          assert.equal(message.method,'session/request_permission');const p=message.params;
          console.log(JSON.stringify({acpCommandPermission:p}));
          const raw=p.toolCall?.rawInput;
          const candidates=[raw?.command,raw?.cmd,...(Array.isArray(raw?.command)?raw.command:[])];
          // ACP presents Codex's debug-quoted Windows command, not argv. Match
          // exact known representations; do not unescape arbitrary shell text.
          const displays=[command,...[ps,process.env.POC_PWSH_PATH].filter(Boolean).map(shell=>`${JSON.stringify(shell)} -Command ${JSON.stringify(command)}`)];
          assert(candidates.some(v=>typeof v==='string'&&displays.includes(v)),'Approve only the exact local test command');
          assert.equal(realpathSync.native(raw.cwd),cwd);
          const option=p.options.find((o:any)=>o.kind==='allow_once');assert(option,'allow_once option required');
          worker.armApproval();approvalCount++;
          return{outcome:{outcome:'selected',optionId:option.optionId}};
        }catch(error){approvalFailure=error as Error;throw error;}
      };
      const pending=worker.rpc.call('session/prompt',{sessionId,prompt:[{type:'text',text:`Execute exactly this command using the shell tool and wait: ${command}. The fixture writes a local file, so read-only mode requires explicit user approval: request sandbox escalation for this command before execution. Do not inspect files or use other tools.`}]},120000).then(value=>({value}),error=>({error:String(error)}));
      await until(()=>{if(approvalFailure)throw approvalFailure;return existsSync(join(cwd,'started.flag'));},120000,'ACP approved nested command running');
      assert.equal(approvalCount,1);
      const recovery=await worker.cancelAndRecover({sessionId},500);
      assert(recovery.restarted,'Must exercise forced ACP session recovery');
      const oldPrompt=await pending;
      await assertGone(recovery.entireJobPids);
      const followup=await worker.rpc.call('session/prompt',{sessionId,prompt:[{type:'text',text:'What exact marker did I ask you to remember? Reply only that marker. Do not use tools.'}]},120000);
      assert.equal(followup.stopReason,'end_turn');
      const answer=worker.rpc.events.filter(e=>e.method==='session/update'&&e.params.update?.sessionUpdate==='agent_message_chunk').map(e=>e.params.update.content?.text??'').join('');assert(answer.includes(marker));
      return{strategy:'B',protocol:'ACP',approvalCount,recovery,oldPrompt,historyAndContextRestored:true,remaining:0};
    }finally{await worker.stop();}
  });
}
