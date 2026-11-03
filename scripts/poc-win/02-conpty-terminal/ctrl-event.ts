// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Run in an isolated helper: never detach or signal the invoking Codex console.
import { k, checked } from './win32';
const target = Number(process.argv[2]);
if (!Number.isInteger(target) || target <= 0) throw new Error('Dedicated fixture PID required');
k.FreeConsole();
checked(k.AttachConsole(target), 'AttachConsole dedicated target');
checked(k.SetConsoleCtrlHandler(null, true), 'Ignore Ctrl+C in helper');
checked(k.GenerateConsoleCtrlEvent(0, 0), 'GenerateConsoleCtrlEvent CTRL_C_EVENT');
await Bun.sleep(300);
k.FreeConsole();
console.log(JSON.stringify({ generated: true, target }));
