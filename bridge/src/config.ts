// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH, STATE_DIR } from './env';

export interface Config {
  server: string; // https://coderail.example.com
  machineId: string;
  token: string;
  name: string;
}

export function loadConfig(): Config | null {
  if (!existsSync(CONFIG_PATH)) return null;
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
}

export function saveConfig(c: Config) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
  chmodSync(CONFIG_PATH, 0o600);
}
