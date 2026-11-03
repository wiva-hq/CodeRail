// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { error } from './paths';
export async function until(check: () => boolean | Promise<boolean>, timeout = 15000, label = 'condition') {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) { if (await check()) return; await Bun.sleep(50); }
  throw error('ETIMEDOUT', `Timeout waiting for ${label}`);
}
