// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { artifacts, baseline, until, assertGone } from '../common';
import { ScopedWindowsFs } from '../04-filesystem/fs';
import { contains } from '../04-filesystem/paths';
import { WindowsGit, findGit } from '../05-git/git';
import { spawnNative } from '../02-conpty-terminal/win32';
import { listeningPorts } from '../06-preview/net';
import { loadBridgeGit } from './bridge-git';
import { Proxy } from '../../../bridge/src/proxy';

baseline();
const dir = await mkdtemp(join(artifacts, 'web-gate2-')), root = join(dir, '项目 中文 空格'); await mkdir(root);
const fs = await ScopedWindowsFs.create(root), git = new WindowsGit(await findGit());
for (const args of [['init'],['config','user.name','Windows Gate'],['config','user.email','gate@localhost'],['config','core.autocrlf','true']]) { const r = await git.run(args,root); if(r.code) throw new Error(r.stderr); }
await fs.write(join(root,'.gitattributes'),'*.txt text\n'); await fs.write(join(root,'中文 空格.txt'),'第一行\r\n原始 第二行\r\n');
for(const args of [['add','--','.'],['commit','-m','gate baseline']]) { const r=await git.run(args,root); if(r.code)throw new Error(r.stderr); }
await fs.write(join(root,'中文 空格.txt'),'第一行\r\n网页 待提交😀\r\n');
await fs.write(join(root,'index.html'),'<!doctype html><html><body><main id="app">Loading</main><script type="module" src="/main.js"></script></body></html>');
await fs.write(join(root,'main.js'),"document.querySelector('#app').textContent='真实 Windows 预览😀'; if(import.meta.hot) import.meta.hot.accept();");
const require = createRequire(join(import.meta.dir,'../../../web/package.json'));
const ready=join(dir,'vite.json'), terminalReady=join(dir,'terminal.json'), config=join(dir,'terminal-config.json');
await Bun.write(config,JSON.stringify({node:Bun.which('node.exe'),vite:require.resolve('vite'),root,ready,terminalReady}));
const terminal=spawnNative([process.execPath,join(import.meta.dir,'../06-preview/terminal-worker.ts'),config],{cwd:root,job:true});
let ui:ReturnType<typeof spawnNative>|undefined;
const runtime=await loadBridgeGit(fs,git,join(dir,'bridge-git.js'));
const wire=(s:string)=>s.replaceAll('\\','/'); const caller={username:'gate',folders:[wire(root)],role:'owner',terminal:true,harnesses:null};
const metrics={http:0,websockets:0,hmrUpdates:0,rpc:[] as string[]};
const pendingHttp=new Map<string,{resolve:(r:Response)=>void;status:number;headers:[string,string][];body:Buffer[]}>();
const sockets=new Map<string,any>();
const proxy=new Proxy(frame=>{
  if(frame.t==='http_head'){const p=pendingHttp.get(frame.id);if(p){p.status=frame.status;p.headers=frame.headers.filter(([k])=>!['content-length','content-encoding','transfer-encoding','connection'].includes(k.toLowerCase()));}}
  else if(frame.t==='http_body')pendingHttp.get(frame.id)?.body.push(Buffer.from(frame.data,'base64'));
  else if(frame.t==='http_end'){const p=pendingHttp.get(frame.id);if(p){pendingHttp.delete(frame.id);p.resolve(frame.error?new Response(frame.error,{status:502}):new Response(Buffer.concat(p.body),{status:p.status,headers:p.headers}));}}
  else if(frame.t==='ws_msg'){if(typeof frame.data==='string'){try{if(JSON.parse(frame.data).type==='update')metrics.hmrUpdates++;}catch{}}sockets.get(frame.id)?.send(frame.binary?Buffer.from(frame.data,'base64'):frame.data);}
  else if(frame.t==='ws_close'){sockets.get(frame.id)?.close(1000);sockets.delete(frame.id);}
},()=>0);
let serverInfo:any;
const preview=Bun.serve<{id:string}>({hostname:'127.0.0.1',port:0,fetch(req,s){
  const url=new URL(req.url), id=crypto.randomUUID();
  if(req.headers.get('upgrade')?.toLowerCase()==='websocket'){
    if(s.upgrade(req,{data:{id},headers:{'sec-websocket-protocol':'vite-hmr'}}))return;
    return new Response('Upgrade failed',{status:400});
  }
  metrics.http++;
  return new Promise<Response>(resolve=>{
    pendingHttp.set(id,{resolve,status:502,headers:[],body:[]});
    proxy.handle({t:'http',id,port:serverInfo.port,target:`http://127.0.0.1:${serverInfo.port}`,path:url.pathname+url.search,method:req.method,headers:[...req.headers]});
  });
},websocket:{open(ws){metrics.websockets++;sockets.set(ws.data.id,ws);proxy.handle({t:'ws_open',id:ws.data.id,port:serverInfo.port,target:`http://127.0.0.1:${serverInfo.port}`,path:`/?token=${serverInfo.token}`,protocols:['vite-hmr'],headers:[['origin',`http://127.0.0.1:${serverInfo.port}`]]});},message(ws,data){proxy.handle({t:'ws_msg',id:ws.data.id,data:typeof data==='string'?data:Buffer.from(data).toString('base64'),binary:typeof data!=='string'});},close(ws){sockets.delete(ws.data.id);proxy.handle({t:'ws_close',id:ws.data.id,code:1000});}}});
const handle=async(method:string,params:any)=>{
  metrics.rpc.push(method);
  if(method==='machine.info')return{online:true,info:{home:wire(root),hostname:'Windows Gate 2',os:'win32',arch:'x64',user:'gate',bridgeVersion:'poc',harnesses:[]},scope:{role:'owner',terminal:true,folders:[wire(root)],harnesses:null}};
  if(['subscribe','unsubscribe'].includes(method))return{ok:true};
  if(['agent.sessions','agent.approvals','term.list'].includes(method))return[];
  if(method==='proxy.ports')return listeningPorts([terminal.pid]);
  if(method==='fs.home')return{home:wire(root),roots:[wire(root)]};
  if(method==='fs.list'){
    const path=await fs.authorize(params.path), entries=await fs.list(path);
    return{path:wire(path),parent:wire(root),entries:entries.filter(e=>params.hidden||!e.name.startsWith('.')).map(e=>({name:e.name,path:wire(join(path,e.name)),kind:e.isDirectory()?'dir':'file',size:Number(e.size),mtime:Number(e.mtimeNs/1000000n)})),truncated:false};
  }
  if(method==='fs.read'){
    const path=await fs.authorize(params.path),bytes=await fs.read(path);return{path:wire(path),content:bytes.toString('utf8'),encoding:'utf8',mime:'text/plain',truncated:false,size:bytes.length,mtime:Date.now()};
  }
  if(method==='fs.write'){await fs.write(params.path,params.content);return{ok:true};}
  if(method==='fs.mkdir'){await fs.mkdir(params.path);return{ok:true};}
  const mapping:Record<string,string>={'git.status':'status','git.diff':'diff','git.stage':'stage','git.unstage':'unstage','git.commit':'commit','git.branches':'branches','git.log':'log'};
  if(mapping[method])return runtime.handlers[mapping[method]](params,caller);
  throw new Error('Unsupported gate operation '+method);
};
const backend=Bun.serve({hostname:'127.0.0.1',port:0,async fetch(req,s){
  const path=new URL(req.url).pathname;
  if(path==='/gate/config')return Response.json({cwd:wire(root)});
  if(path==='/gate/metrics')return Response.json(metrics);
  if(path==='/api/machines/windows-gate2/preview'&&req.method==='POST'){
    const body=await req.json() as any, target=new URL(body.url);
    if(!['localhost','127.0.0.1'].includes(target.hostname)||Number(target.port)!==serverInfo.port)return new Response('Only the owned fixture can be previewed',{status:403});
    return Response.json({url:`http://127.0.0.1:${preview.port}${target.pathname}${target.search}`});
  }
  if(path==='/api/machines/windows-gate2/ws'&&s.upgrade(req))return;
  return new Response('Not found',{status:404});
},websocket:{async message(ws,data){const frame=JSON.parse(String(data));if(frame.t==='ping'){ws.send(JSON.stringify({t:'pong'}));return;}if(frame.t==='sub'||frame.t==='unsub')return;if(frame.t!=='req')return;try{ws.send(JSON.stringify({t:'res',id:frame.id,result:await handle(frame.method,frame.params??{})}));}catch(e:any){ws.send(JSON.stringify({t:'res',id:frame.id,error:{code:e.code??-32603,message:e.message}}));}}}});
try {
  await until(()=>existsSync(ready),30000,'Vite fixture ready');serverInfo=await Bun.file(ready).json();
  const uiReady=join(dir,'ui.json');ui=spawnNative([Bun.which('node.exe')!,join(import.meta.dir,'ui-server.mjs'),`http://127.0.0.1:${backend.port}`,uiReady],{cwd:root,job:true});
  await until(()=>existsSync(uiReady),30000,'Svelte component harness ready'); const info=await Bun.file(uiReady).json();
  const manifest={url:`http://127.0.0.1:${info.port}`,dir,root,previewPort:serverInfo.port,stop:join(dir,'stop.flag'),backendPort:backend.port};
  await Bun.write(join(artifacts,'web-gate-ready.json'),JSON.stringify(manifest));console.log(JSON.stringify(manifest));
  await until(()=>existsSync(manifest.stop),900000,'explicit gate harness stop');
  await Bun.write(join(artifacts,'web-gate-metrics.json'),JSON.stringify(metrics,null,2));
} finally {
  proxy.closeAll();backend.stop(true);preview.stop(true);ui?.dispose();terminal.dispose();fs.close();runtime.dispose();
  await assertGone([terminal.pid,...(ui?[ui.pid]:[])]);
  if(!contains(artifacts,dir)||!dir.includes('web-gate2-'))throw new Error('Unsafe harness cleanup');
  await rm(dir,{recursive:true});
}
