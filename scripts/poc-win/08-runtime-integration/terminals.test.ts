// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from 'bun:test';
import { stripVTControlCharacters } from 'node:util';
import { Terminals } from '../../../bridge/src/terminals';
import type { Caller } from '../../../protocol/src';
import { artifacts, baseline, cmd, until } from '../common';

baseline();
test('production terminal RPC: PowerShell/CMD UTF-8, resize, detached replay and closed sessions stay closed', async () => {
  const events: any[] = [], terminals = new Terminals((topic, event) => events.push({ topic, event }));
  const caller: Caller = { userId: 'gate', username: 'gate', role: 'owner', terminal: true, folders: [artifacts], harnesses: null };
  const power = await terminals.open({ cwd: artifacts }, caller);
  try {
    terminals.resize({ id: power.id, cols: 117, rows: 35 });
    terminals.write({ id: power.id, data: "[Console]::WriteLine('SIZE:'+ $Host.UI.RawUI.WindowSize.Width);[Console]::WriteLine('远程 中文😀');\r" });
    await until(() => Buffer.from(terminals.attach({ id: power.id }).scrollback, 'base64').toString('utf8').includes('SIZE:117'));
    expect(Buffer.from(terminals.attach({ id: power.id }).scrollback, 'base64').toString('utf8')).toContain('远程 中文😀');
    // The browser subscription is absent while the OS terminal continues to run.
    terminals.write({ id: power.id, data: "Start-Sleep -Milliseconds 100;[Console]::WriteLine('断线 后继续😀');\r" });
    await Bun.sleep(200);
    await until(() => Buffer.from(terminals.attach({ id: power.id }).scrollback, 'base64').toString('utf8').includes('断线 后继续😀'));
    const command = await terminals.open({ cwd: artifacts, command: [cmd] }, caller);
    terminals.write({ id: command.id, data: 'chcp\recho CMD中文😀\r' });
    try { await until(() => {
      const raw = Buffer.from(terminals.attach({ id: command.id }).scrollback, 'base64').toString('utf8');
      // ConPTY may position the next prompt with CSI H instead of a newline.
      // The command echo includes '>echo', so require an actual output-line start.
      return stripVTControlCharacters(raw).includes('65001') && /\r?\nCMD中文😀(?=\r?\n|\x1b\[)/u.test(raw);
    }, 15000, 'CMD codepage response and actual UTF-8 echo output, not its window title or input'); }
    catch(cause) { console.error(JSON.stringify({cmdScrollback:Buffer.from(terminals.attach({id:command.id}).scrollback,'base64').toString('utf8')}));throw cause; }
    expect(Buffer.from(terminals.attach({ id: command.id }).scrollback, 'base64').toString('utf8')).toContain('CMD中文😀');
    terminals.close({ id: command.id }); terminals.close({ id: power.id });
    await Bun.sleep(200); expect(terminals.list()).toEqual([]);
    expect(events.slice(events.findLastIndex(row => row.event.type === 'terminal_closed') + 1).some(row => row.event.type === 'terminal')).toBe(false);
  } finally { terminals.shutdown(); }
}, 30000);
