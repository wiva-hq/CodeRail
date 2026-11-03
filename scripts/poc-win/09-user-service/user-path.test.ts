// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { addPath, removePath, UserEnvironmentValue } from './user-path';
import { baseline } from '../common';
baseline();
test('HKCU environment strings preserve REG_EXPAND_SZ literally; real PATH remains unchanged',()=>{
  const real=new UserEnvironmentValue(),before=real.read(),value=new UserEnvironmentValue(`CodeRail-PoC-${crypto.randomUUID()}`);
  expect(value.read()).toBeNull();
  try{value.write({text:'%USERPROFILE%\\中文 工具;C:\\Other',type:2});expect(value.read()).toEqual({text:'%USERPROFILE%\\中文 工具;C:\\Other',type:2});}
  finally{value.write(null);}
  expect(real.read()).toEqual(before);expect(value.read()).toBeNull();
});
test('PATH ownership: exact restoration, preexisting path preservation, preserve later third-party edits',()=>{
  const old={text:'%USERPROFILE%\\bin;C:\\Tools;',type:2 as const},entry='C:\\CodeRail\\bin\\current';
  const change=addPath(old,entry);
  expect(change.added).toBe(true);expect(removePath(change.installed,change)).toEqual(old);
  expect(removePath({...change.installed,text:change.installed.text+';C:\\Other'},change)?.text).toBe('%USERPROFILE%\\bin;C:\\Tools;C:\\Other');
  const preexisting=addPath({text:'c:/CODERAIL/bin/current/;C:\\Tools',type:1},entry);
  expect(preexisting.added).toBe(false);expect(removePath(preexisting.installed,preexisting)).toEqual(preexisting.old);
  expect(removePath(addPath(null,entry).installed,addPath(null,entry))).toBeNull();
  const unicode=addPath({text:'C:\\İ-project',type:1},'C:\\i\u0307-project');
  expect(unicode.added).toBe(true);
  expect(removePath({...change.installed,text:change.installed.text+';'+entry},change)?.text).toBe(old.text+entry);
});
