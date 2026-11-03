// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { connect, type Socket } from 'node:net';
import { baseline } from '../common';
import { currentUserProxy, manualProxy, proxyFor } from './system-proxy';

baseline();
test('native current-user proxy configuration is readable without modifying system settings',()=>{
  const config=currentUserProxy(); expect(typeof config.autoDetect).toBe('boolean');
  expect(config.proxy===null||typeof config.proxy==='string').toBe(true);
  console.log(JSON.stringify({nativeUserProxy:true,manualConfigured:!!config.proxy,pacConfigured:!!config.pac,autoDetect:config.autoDetect}));
});

test('manual proxy parsing respects per-protocol mappings, Windows bypass and local previews',()=>{
  const config={autoDetect:false,pac:null,proxy:'http=127.0.0.1:8080;https=127.0.0.1:8443',bypass:'<local>;*.example.test'};
  expect(manualProxy('https://remote.invalid',config)).toBe('http://127.0.0.1:8443/');
  expect(manualProxy('ws://remote.invalid',config)).toBe('http://127.0.0.1:8080/');
  expect(manualProxy('wss://remote.invalid',config)).toBe('http://127.0.0.1:8443/');
  expect(manualProxy('http://intranet',config)).toBeUndefined(); expect(manualProxy('https://app.example.test',config)).toBeUndefined();
  expect(manualProxy('http://127.0.0.1:5173',config)).toBeUndefined();
  expect(()=>manualProxy('https://remote.invalid',{...config,proxy:'socks5://localhost:1080'})).toThrow('HTTP(S)');
  expect(proxyFor('https://remote.invalid',{https_proxy:'http://explicit.invalid'},()=>{throw new Error('Must preserve explicit environment');})).toBeUndefined();
  expect(proxyFor('https://remote.invalid',{NO_PROXY:'*'},()=>{throw new Error('Must preserve explicit bypass');})).toBeUndefined();
  expect(proxyFor('https://remote.invalid',{},()=>config)).toBe('http://127.0.0.1:8443/');
  expect(proxyFor('https://remote.invalid',{NO_PROXY:'remote.invalid:443'},()=>{throw new Error('Bypass must not read proxy');})).toBeUndefined();
  expect(proxyFor('https://sub.remote.invalid',{NO_PROXY:'.remote.invalid'},()=>config)).toBeUndefined();
  expect(proxyFor('https://notremote.invalid',{NO_PROXY:'.remote.invalid'},()=>config)).toBe('http://127.0.0.1:8443/');
  expect(proxyFor('https://remote.invalid:8443',{NO_PROXY:'remote.invalid:443'},()=>config)).toBe('http://127.0.0.1:8443/');
  expect(()=>proxyFor('https://remote.invalid',{NO_PROXY:'10.0.0.0/8'},()=>config)).toThrow('CIDR');
  expect(proxyFor('https://remote.invalid',{NO_PROXY:'10.0.0.0/8'},()=>({...config,proxy:null}))).toBeUndefined();
  expect(proxyFor('https://remote.invalid',{HTTP_PROXY:'http://explicit.invalid'},()=>{throw new Error('Preserve Bun protocol rules');})).toBeUndefined();
  expect(manualProxy('https://[2001:db8::1]',config)).toBe('http://127.0.0.1:8443/');
  expect(manualProxy('https://remote.invalid',{...config,bypass:'remote.invalid:443'})).toBeUndefined();
  expect(()=>manualProxy('https://remote.invalid',{...config,proxy:'socks=localhost:1080'})).toThrow('SOCKS');
});

test('Bun 1.4.4 fetch and WebSocket actually traverse an explicit local HTTP proxy', async()=>{
  let httpHits=0,tunnelHits=0;
  const peers=new Set<Socket>();
  const target=Bun.serve({hostname:'127.0.0.1',port:0,fetch(req,server){if(server.upgrade(req))return;return new Response('direct');},websocket:{message(ws,message){ws.send(message);}}});
  const authority=`127.0.0.1:${target.port}`;
  const proxy=createServer((_req,res)=>{httpHits++;res.end('proxy 中文😀');});
  proxy.on('connection',socket=>{peers.add(socket);socket.on('close',()=>peers.delete(socket));});
  proxy.on('connect',(req,socket,head)=>{
    if(req.url!==authority){socket.destroy();return;}
    tunnelHits++;const upstream=connect(target.port!,'127.0.0.1',()=>{socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');if(head.length)upstream.write(head);socket.pipe(upstream);upstream.pipe(socket);});
    peers.add(upstream);upstream.on('close',()=>peers.delete(upstream));upstream.on('error',()=>socket.destroy());socket.on('error',()=>upstream.destroy());socket.on('close',()=>upstream.destroy());
  });
  await new Promise<void>(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const port=(proxy.address() as {port:number}).port,proxyUrl=`http://127.0.0.1:${port}`;
  let ws:WebSocket|undefined;
  try {
    expect(await (await fetch('http://proxy-target.invalid/test',{proxy:proxyUrl,signal:AbortSignal.timeout(5000)})).text()).toBe('proxy 中文😀');
    const echoed=await new Promise<string>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Proxy WebSocket timed out')),5000);
      ws=new WebSocket(`ws://${authority}/socket`,{proxy:proxyUrl});
      ws.onopen=()=>ws!.send('双向😀'); ws.onmessage=event=>{clearTimeout(timer);resolve(String(event.data));};ws.onerror=()=>{clearTimeout(timer);reject(new Error('Proxy WebSocket failed'));};
    });
    expect(echoed).toBe('双向😀');expect(httpHits).toBe(1);expect(tunnelHits).toBe(1);
  } finally {ws?.close();for(const peer of peers)peer.destroy();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await target.stop(true);}
},15000);
