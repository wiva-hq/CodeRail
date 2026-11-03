// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {win32 as p} from 'node:path';
import {NativeFile} from './native';
import {error} from './paths';
import {ensurePrivateDirectory} from './private-fs';
import {guardInstallationRoot,readInstallation} from './install-files';
import {stageUpdate,type UpdateArtifact} from './update-stage';
import {proxyFor} from './system-proxy';

export interface WindowsManifest extends UpdateArtifact {schema:1;target:'windows-x64';helperProtocol:1;url:string}
function safeURL(value:string) {
  const url=new URL(value);
  if(url.username||url.password||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&['127.0.0.1','[::1]','localhost'].includes(url.hostname)))throw error('EINVAL','Updates require HTTPS; HTTP is allowed only for loopback fixtures');
  return url;
}
export function validateManifest(value:any):WindowsManifest {
  if(!value||value.schema!==1||value.target!=='windows-x64'||value.helperProtocol!==1||typeof value.version!=='string'||!/^\d+\.\d+\.\d+\+\d+$/.test(value.version)||typeof value.sha256!=='string'||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.size)||value.size<64||value.size>1024*1024*1024||typeof value.url!=='string')throw error('EINVAL','Incompatible or invalid Windows manifest');
  safeURL(value.url);return value;
}
async function fetchSafe(input:string,signal:AbortSignal) {
  let url=safeURL(input);
  for(let redirects=0;redirects<=5;redirects++){
    const proxy=proxyFor(url.href),response=await fetch(url,{signal,redirect:'manual',headers:{'accept-encoding':'identity'},...(proxy?{proxy}:{})});
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');await response.body?.cancel();
    if(!location||redirects===5)throw error('EIO','Invalid or excessive update redirects');url=safeURL(new URL(location,url).href);
  }
  throw error('EIO','Update redirect limit');
}
export async function fetchManifest(url:string,timeout=10000):Promise<WindowsManifest> {
  const response=await fetchSafe(url,AbortSignal.timeout(timeout));
  if(response.status!==200){await response.body?.cancel();throw error('EIO',`Manifest HTTP ${response.status}`);}
  if(!response.body)throw error('EIO','Empty manifest response');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0,complete=false;
  try {
    for(;;){const part=await reader.read();if(part.done){complete=true;break;}size+=part.value.length;if(size>16384)throw error('EFBIG','Manifest exceeds 16 KiB');chunks.push(part.value);}
    return validateManifest(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks))));
  }finally{if(!complete)await reader.cancel();reader.releaseLock();}
}
// (The timeout covers the whole body: about 611 MiB with the browser, so it allows slow links.)
export async function downloadAndStage(input:string,value:WindowsManifest,timeout=60*60000) {
  const manifest=validateManifest(value),root=await guardInstallationRoot(input);
  if(!readInstallation(root))throw error('EACCES','Owned installation required before downloading');
  const updates=p.join(root,'updates');ensurePrivateDirectory(updates);
  const parent=new NativeFile(updates,true),name='download-'+crypto.randomUUID().replaceAll('-','')+'.exe',path=p.join(updates,name);
  let file:NativeFile|undefined,created=false,response:Response|undefined,reader:{cancel():Promise<void>;releaseLock():void}|undefined,complete=false;
  try {
    response=await fetchSafe(manifest.url,AbortSignal.timeout(timeout));
    const declared=response.headers.get('content-length');
    if(response.status!==200||declared!==null&&(!/^\d+$/.test(declared)||Number(declared)!==manifest.size))throw error('EIO','Artifact HTTP status or declared size mismatch');
    if(!response.body)throw error('EIO','Empty artifact response');
    file=parent.child(name,false,true,true);created=true;const stream=response.body.getReader();reader=stream;let size=0;const hash=new Bun.CryptoHasher('sha256');
    for(;;){const part=await stream.read();if(part.done){complete=true;break;}size+=part.value.length;if(size>manifest.size)throw error('EFBIG','Artifact exceeds manifest size');hash.update(part.value);file.write(part.value);}
    if(size!==manifest.size||hash.digest('hex')!==manifest.sha256)throw error('EACCES','Downloaded artifact size/SHA256 mismatch');
    file.close();file=undefined;
    return await stageUpdate(root,path,manifest);
  }finally{
    try {
      if(reader){try{if(!complete)await reader.cancel();}finally{reader.releaseLock();}}
      else if(response?.body)await response.body.cancel();
    }finally{
      try{if(file){try{file.unlink();}finally{file.close();}}else if(created){const temporary=parent.child(name,false,false,true);try{temporary.unlink();}finally{temporary.close();}}}
      finally{parent.close();}
    }
  }
}
