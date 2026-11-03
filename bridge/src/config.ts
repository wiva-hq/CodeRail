// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_PATH, STATE_DIR } from './env';
import { platform } from './platform';

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
  platform.fs.ensurePrivateDirectory(STATE_DIR);
  platform.fs.writePrivateFile(CONFIG_PATH, JSON.stringify(c, null, 2) + '\n');
}
