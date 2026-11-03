// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {realpathSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import {homedir,tmpdir} from 'node:os';
import {UserService} from './service-stop';
import {readInstallation} from '../09-user-service/install-files';
import {baseline} from '../common';
baseline();
const base=realpathSync.native(resolve(process.argv[2]??''));
assert.equal(dirname(base),realpathSync.native(tmpdir()));assert(basename(base).startsWith('crrootupdate-'));
const root=realpathSync.native(join(base,'CodeRail'));assert.equal(root,join(base,'CodeRail'));assert(readInstallation(root));
const service=new UserService(),spec={command:[],home:homedir(),stateDir:root,logPath:join(root,'bridge.log')};
await service.stop(spec);assert.equal((await service.status(spec)).running,false);
console.log(JSON.stringify({probeServiceStoppedThroughOwnedControl:true,remaining:0,filesPreservedForDiagnostics:true}));
