// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { realpathSync, statSync } from 'node:fs';
import { win32 } from 'node:path';
import { homedir } from 'node:os';
import type { Env } from '../types';
import { npmCodex } from './npm-codex';
import { desktopCodex } from './desktop-codex';

/** Windows environment keys are case-insensitive. Never emit both Path and PATH. */
export function normalizeEnvironment(input: NodeJS.ProcessEnv): Env {
  const out: Env = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || ['BUN_BE_BUN', 'CODERAIL_STOP_FILE'].includes(key.toUpperCase())) continue;
    out[key.toUpperCase()] = value;
  }
  out.HOME ??= out.USERPROFILE ?? homedir();
  return out;
}

export function mergePath(env: Env, registeredPaths: readonly string[]): Env {
  const result = normalizeEnvironment(env), parts: string[] = [], seen = new Set<string>();
  for (const path of [result.PATH ?? '', ...registeredPaths]) {
    const expanded = path.replace(/%([^%]+)%/g, (original, name: string) => result[name.toUpperCase()] ?? original);
    for (const entry of expanded.split(';').map(s => s.trim()).filter(Boolean)) {
      const key = entry.replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '').toLowerCase();
      if (!seen.has(key)) { seen.add(key); parts.push(entry); }
    }
  }
  result.PATH = parts.join(';');
  return result;
}

export async function userEnv(): Promise<Env> {
  const env = normalizeEnvironment(process.env);
  // Read each time: a background process can predate a new Git/Node installation.
  const { environmentPaths } = await import('./registry');
  return mergePath(env, environmentPaths());
}

/** Only native executables are returned. .cmd/.bat require an explicit shell
 * policy and must never accidentally be interpreted as executable images. */
export function findExecutable(name: string, input: Env): string | null {
  const env = normalizeEnvironment(input);
  if (!name || /[\0\r\n]/.test(name)) throw new Error('Invalid executable name');
  const extension = win32.extname(name).toLowerCase();
  if (extension && !['.exe', '.com'].includes(extension)) return null;
  const direct = /[\\/]/.test(name);
  if (!direct && /^codex(?:\.exe)?$/i.test(name) && env.CODEX_PATH) {
    if (!win32.isAbsolute(env.CODEX_PATH)) throw new Error('CODEX_PATH must name an absolute native executable');
    const explicit = findExecutable(env.CODEX_PATH, { ...env, CODEX_PATH: '' });
    if (!explicit) throw new Error('CODEX_PATH native executable was not found');
    return explicit;
  }
  // Do not search cwd: a remote workspace must not shadow an installed tool.
  if (direct && !win32.isAbsolute(name)) return null;
  const directories = direct ? [''] : (env.PATH ?? '').split(';').map(s => s.trim().replace(/^"(.*)"$/, '$1')).filter(s => win32.isAbsolute(s));
  for (const directory of directories) for (const suffix of extension ? [''] : ['.exe', '.com']) {
    const candidate = direct ? name + suffix : win32.join(directory, name + suffix);
    try {
      const real = realpathSync.native(candidate);
      if (statSync(real).isFile()) return real;
    } catch (e: any) {
      if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
    }
  }
  if (!direct && /^codex(?:\.exe)?$/i.test(name)) {
    const packages = directories.map(directory => win32.join(directory, 'node_modules/@openai/codex'));
    if (env.APPDATA) packages.push(win32.join(env.APPDATA, 'npm/node_modules/@openai/codex'));
    packages.push(win32.join(env.BUN_INSTALL ?? win32.join(env.HOME, '.bun'), 'install/global/node_modules/@openai/codex'));
    for (const root of new Set(packages)) { const executable = npmCodex(root); if (executable) return executable; }
    return desktopCodex(env.LOCALAPPDATA);
  }
  if (!direct && /^claude(?:\.exe)?$/i.test(name)) {
    // npm's claude.cmd only starts the native image the package ships: use that image, never the shim.
    const packages = directories.map(directory => win32.join(directory, 'node_modules/@anthropic-ai/claude-code'));
    if (env.APPDATA) packages.push(win32.join(env.APPDATA, 'npm/node_modules/@anthropic-ai/claude-code'));
    packages.push(win32.join(env.BUN_INSTALL ?? win32.join(env.HOME, '.bun'), 'install/global/node_modules/@anthropic-ai/claude-code'));
    for (const root of new Set(packages)) {
      try {
        const real = realpathSync.native(win32.join(root, 'bin/claude.exe'));
        if (statSync(real).isFile()) return real;
      } catch (e: any) {
        if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e;
      }
    }
  }
  return null;
}

export const utf8 = '[Console]::InputEncoding=[Console]::OutputEncoding=$OutputEncoding=[System.Text.UTF8Encoding]::new($false);';
export function defaultCommand(input: Env): string[] {
  const env = normalizeEnvironment(input);
  const shell = findExecutable('pwsh', env) ?? findExecutable(win32.join(env.SYSTEMROOT ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), env);
  if (!shell) throw new Error('PowerShell is unavailable');
  return [shell, '-NoLogo', '-NoProfile', '-NoExit', '-Command', utf8];
}
