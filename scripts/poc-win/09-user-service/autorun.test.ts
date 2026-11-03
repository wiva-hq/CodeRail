// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { UserAutorun } from './autorun';
import { baseline } from '../common';
baseline();
test('HKCU Run: non-elevated Unicode round-trip, idempotent install, ownership conflict and precise removal', () => {
  const value = new UserAutorun(`CodeRail-PoC-${crypto.randomUUID()}`);
  // Only this UUID value is touched. It is removed synchronously in finally;
  // no logoff/restart is performed and no unrelated startup value is changed.
  const command = '"C:\\CodeRail PoC 中文\\supervisor.exe" "C:\\CodeRail PoC 中文\\state"';
  expect(value.read()).toBeNull();
  try {
    value.install(command); expect(value.read()).toBe(command);
    value.install(command); expect(value.read()).toBe(command);
    expect(() => value.install('different installation')).toThrow('different installation');
    expect(() => value.uninstall('wrong ownership')).toThrow('another installation');
    expect(() => value.install('x'.repeat(261))).toThrow('260-character');
    value.uninstall(command); expect(value.read()).toBeNull();
  } finally { value.uninstall(command); }
});
