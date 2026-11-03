// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { createPosixAdapter } from './posix';
import { createWindowsAdapter } from './win32';
import { PlatformUnsupportedError, type PlatformAdapter } from './types';

export function createPlatformAdapter(os: string): PlatformAdapter {
  if (os === 'darwin' || os === 'linux') return createPosixAdapter(os);
  if (os === 'win32') return createWindowsAdapter();
  throw new PlatformUnsupportedError(os, 'platform');
}

export const platform = createPlatformAdapter(process.platform);
