// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { baseName, join, parentOf, tilde } from '../../../web/src/lib/machineText';
test('web path helpers preserve drive/UNC roots and work with native Windows separators', () => {
  expect(baseName('C:\\Users\\中文 空格\\file.txt')).toBe('file.txt');
  expect(parentOf('C:\\Users')).toBe('C:/');
  expect(parentOf('C:/')).toBe('C:/');
  expect(parentOf('\\\\server\\share\\folder')).toBe('//server/share');
  expect(parentOf('\\\\server\\share')).toBe('//server/share');
  expect(join('C:\\Users\\中文', 'file.txt')).toBe('C:/Users/中文/file.txt');
  expect(tilde('c:\\Users\\ALVIN\\project', 'C:/Users/Alvin')).toBe('~/project');
  expect(tilde('C:/Users/Alvin-more', 'C:/Users/Alvin')).toBe('C:/Users/Alvin-more');
});
test('POSIX roots, case sensitivity and literal backslash filenames retain their meaning', () => {
  expect(baseName('/work/file\\name')).toBe('file\\name');
  expect(parentOf('/work')).toBe('/');
  expect(parentOf('/')).toBe('/');
  expect(join('/work/', '/file')).toBe('/work/file');
  expect(tilde('/home/user/app', '/home/user')).toBe('~/app');
  expect(tilde('/Home/User/app', '/home/user')).toBe('/Home/User/app');
});
