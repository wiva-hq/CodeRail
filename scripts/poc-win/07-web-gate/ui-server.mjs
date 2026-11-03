// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
const require = createRequire(resolve(dirname(fileURLToPath(import.meta.url)), '../../../web/package.json'));
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href);
const { svelte } = await import(pathToFileURL(require.resolve('@sveltejs/vite-plugin-svelte')).href);
const [backend, ready] = process.argv.slice(2);
const root = dirname(fileURLToPath(import.meta.url));
const sveltePackage=require.resolve('svelte/package.json'), exportsMap=JSON.parse(readFileSync(sveltePackage,'utf8')).exports;
const workspaceSvelte={name:'gate-workspace-svelte',enforce:'pre',resolveId(id){
 if(id!=='svelte'&&!id.startsWith('svelte/'))return;
 let value=exportsMap[id==='svelte'?'.':'./'+id.slice(7)];
 while(value&&typeof value==='object')value=value.browser??value.import??value.default;
 if(typeof value==='string')return resolve(dirname(sveltePackage),value);
}};
const server = await createServer({ root, configFile:false, logLevel:'error', plugins:[workspaceSvelte,svelte()], server:{host:'127.0.0.1',port:0,fs:{allow:[resolve(root,'../../..')]},proxy:{'/api':{target:backend,ws:true},'/gate':{target:backend}}} });
await server.listen(); writeFileSync(ready,JSON.stringify({port:server.httpServer.address().port,pid:process.pid}),'utf8');
