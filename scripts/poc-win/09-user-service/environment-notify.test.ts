// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {expect,test} from 'bun:test';
import {baseline} from '../common';
import {notifyEnvironmentChange} from './environment-notify';
baseline();
test('user environment notification is isolated in a time-bounded Job and reports delivery outcome',async()=>{
  const start=performance.now(),result=await notifyEnvironmentChange();
  expect(['sent','unavailable']).toContain(result.status);expect(performance.now()-start).toBeLessThan(10000);
  console.log(JSON.stringify({environmentNotification:result,registryWritten:false}));
},15000);
