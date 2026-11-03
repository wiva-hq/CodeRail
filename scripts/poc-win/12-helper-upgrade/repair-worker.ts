// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {repairHelper} from './repair';
import {UserAutorun} from '../../../bridge/src/platform/win32/autorun';
const [root,image,startup,step]=process.argv.slice(2),bytes=await Bun.file(image).bytes();
if(step==='inside'){
  let refused=false;
  try{await repairHelper(root,bytes,new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),{startup:new UserAutorun(startup)});}
  catch(cause:any){if(cause.code!=='EACCES')throw cause;refused=true;}
  await Bun.write(root+'/inside-result.json',JSON.stringify({refused}));
}else await repairHelper(root,bytes,new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),{startup:new UserAutorun(startup),step:label=>{if(label===step)process.exit(42);}});
