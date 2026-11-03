// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {ProcessRef} from '../../../bridge/src/platform/win32/job';
import {baseline} from '../common';
import {memory} from './memory';
baseline();
test('native memory counters use a pinned process handle and return bounded working/private bytes',()=>{
  const ref=ProcessRef.open(process.pid)!;try{const result=memory(ref)!;expect(result.workingSetBytes).toBeGreaterThan(0);expect(result.privateBytes).toBeGreaterThan(0);console.log(JSON.stringify({memoryCounters:true,workingSetBytes:result.workingSetBytes,privateBytes:result.privateBytes}));}finally{ref.close();}
});
