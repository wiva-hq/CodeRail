// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { join } from 'node:path';
import { artifacts } from '../common';
import { ScopedWindowsFs } from '../04-filesystem/fs';
import { contains } from '../04-filesystem/paths';
const manifest=await Bun.file(join(artifacts,'web-gate-ready.json')).json();
if(!contains(artifacts,manifest.root)||!manifest.root.includes('web-gate2-'))throw new Error('Only the generated web gate fixture can be changed');
const fs=await ScopedWindowsFs.create(manifest.root);
try{await fs.write(join(fs.root,'main.js'),"document.querySelector('#app').textContent='HMR 已更新 中文😀'; if(import.meta.hot) import.meta.hot.accept();");}
finally{fs.close();}
