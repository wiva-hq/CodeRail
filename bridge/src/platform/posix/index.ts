// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { access as fsAccess, mkdir, rename, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, join, posix } from 'node:path';
import type { ListeningPort } from '../types';
import type { PlatformAdapter } from '../types';
import { createService } from './service';

const HOME = homedir();
const log = (...args: unknown[]) => {
  const line = `[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : a instanceof Error ? a.stack ?? a.message : JSON.stringify(a)).join(' ')}`;
  console.log(line);
};
let shellEnv: Record<string, string> | null = null;

/**
 * The environment of the user's login shell. A launchd/systemd service starts with a bare PATH, so the
 * harnesses, git, node and the user's tools are found the way they are in the user's own terminal.
 */
async function userEnv(options?: { refresh?: boolean }): Promise<Record<string, string>> {
  if (options?.refresh) shellEnv = null;
  if (shellEnv) return shellEnv;
  const base: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete base.BUN_BE_BUN;
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
  try {
    const marker = '__CODERAIL_ENV__';
    const p = Bun.spawn([shell, '-ilc', `printf '${marker}'; env -0`], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      env: { ...base, CODERAIL_PROBE: '1' },
    });
    const timer = setTimeout(() => p.kill(), 8000);
    const out = await new Response(p.stdout).text();
    clearTimeout(timer);
    const i = out.lastIndexOf(marker);
    if (i >= 0) {
      for (const pair of out.slice(i + marker.length).split('\0')) {
        const eq = pair.indexOf('=');
        if (eq > 0) base[pair.slice(0, eq)] = pair.slice(eq + 1);
      }
    }
  } catch (e) {
    log('could not read the login shell environment', e);
  }
  for (const k of ['CODERAIL_PROBE', 'SHLVL', '_', 'PWD', 'OLDPWD', 'BUN_BE_BUN']) delete base[k];
  const extra = [join(HOME, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  const parts = (base.PATH ?? '').split(':').filter(Boolean);
  for (const e of extra) if (!parts.includes(e)) parts.push(e);
  base.PATH = parts.join(':');
  base.HOME ??= HOME;
  base.LANG ??= 'en_US.UTF-8';
  shellEnv = base;
  return base;
}

export async function run(
  cmd: string[],
  opts: { cwd?: string; timeout?: number; input?: string; env?: Record<string, string> } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = opts.env ?? (await userEnv());
  const p = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env,
    stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timer = opts.timeout ? setTimeout(() => p.kill(), opts.timeout) : null;
  const [stdout, stderr] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  if (timer) clearTimeout(timer);
  return { code, stdout, stderr };
}

const FULL_DISK_PROBES = ['/Library/Application Support/com.apple.TCC/TCC.db', join(HOME, 'Library/Safari/Bookmarks.plist')];

export async function hasFullDiskAccess(): Promise<boolean | null> {
  if (process.platform !== 'darwin') return null;
  let refused = false;
  for (const p of FULL_DISK_PROBES) {
    try {
      await (await open(p, 'r')).close();
      return true;
    } catch (e: any) {
      if (e?.code === 'EPERM' || e?.code === 'EACCES') refused = true;
    }
  }
  return refused ? false : null;
}

async function ports(): Promise<ListeningPort[]> {
  const r = await run(['lsof', '-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn'], { timeout: 10_000 }).catch(() => null);
  if (!r) return [];
  const out = new Map<number, ListeningPort>();
  let pid = 0;
  let command = '';
  for (const line of r.stdout.split('\n')) {
    const k = line[0];
    const v = line.slice(1);
    if (k === 'p') pid = Number(v);
    else if (k === 'c') command = v;
    else if (k === 'n') {
      const m = v.match(/^(.*):(\d+)$/);
      if (!m) continue;
      const port = Number(m[2]);
      if (!out.has(port)) out.set(port, { port, pid, command, address: m[1] });
    }
  }
  return [...out.values()].sort((a, b) => a.port - b.port);
}

/** native realpath is deliberately asynchronous so OS permission waits do not block the bridge. */
function nativeRealpath(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    import('node:fs').then(({ realpath }) => realpath.native(path, (error, result) => error ? reject(error) : resolve(result)), reject);
  });
}

export function createPosixAdapter(os: 'darwin' | 'linux'): PlatformAdapter {
  return {
    os,
    path: {
      delimiter: ':', home: () => HOME,
      stateDir: () => process.env.CODERAIL_HOME ?? join(HOME, '.coderail'),
      expandUser: p => p === '~' ? HOME : p.startsWith('~/') ? join(HOME, p.slice(2)) : p,
      basename: posix.basename,
      contains(root, candidate) {
        const relative = posix.relative(root, candidate);
        return relative === '' || (relative !== '..' && !relative.startsWith('../') && !posix.isAbsolute(relative));
      },
      hasSegment: (path, segment) => path.split('/').some(part => part.toLowerCase() === segment.toLowerCase()),
    },
    process: {
      spawn: Bun.spawn,
      stopLegacy(child, kind) { child.kill(kind === 'terminal' ? 'SIGHUP' : undefined); },
      run,
      onShutdown(handler) {
        process.on('SIGINT', handler); process.on('SIGTERM', handler);
        return () => { process.off('SIGINT', handler); process.off('SIGTERM', handler); };
      },
    },
    shell: {
      userEnv,
      findExecutable: (name, env) => Bun.which(name, { PATH: env.PATH }) ?? null,
      defaultCommand: env => [env.SHELL || '/bin/zsh', '-l'],
      openExternal(url) { Bun.spawn([os === 'darwin' ? 'open' : 'xdg-open', url], { stdout: 'ignore', stderr: 'ignore' }); },
    },
    fs: {
      async canonicalize(input, intent) {
        try { return await nativeRealpath(input); }
        catch (error: any) {
          if (intent !== 'create' || error?.code !== 'ENOENT') throw error;
          // Never turn a dangling symlink into an apparently safe creation path.
          const { lstat, stat } = await import('node:fs/promises');
          const entry = await lstat(input).catch((statError: any) => {
            if (statError?.code !== 'ENOENT') throw statError;
            return null;
          });
          if (entry?.isSymbolicLink()) throw error;
          const parent = dirname(input);
          if (parent === input) throw error;
          const resolvedParent = await this.canonicalize(parent, 'create');
          const parentEntry = await stat(resolvedParent).catch((statError: any) => {
            if (statError?.code !== 'ENOENT') throw statError;
            return null;
          });
          if (parentEntry && !parentEntry.isDirectory()) throw Object.assign(new Error('Parent is not a directory'), { code: 'ENOTDIR' });
          return join(resolvedParent, basename(input));
        }
      },
      ensurePrivateDirectory(path) { mkdirSync(path, { recursive: true, mode: 0o700 }); },
      writePrivateFile(path, content) { writeFileSync(path, content, { encoding: 'utf8', mode: 0o600 }); chmodSync(path, 0o600); },
      async trash(path) {
        const exists = (p: string) => fsAccess(p).then(() => true, () => false);
  const dir = process.platform === 'darwin' ? join(HOME, '.Trash') : join(HOME, '.local/share/Trash/files');
  await mkdir(dir, { recursive: true });
  let target = join(dir, basename(path));
  for (let i = 2; await exists(target); i++) {
    const ext = extname(path);
    target = join(dir, `${basename(path, ext)} ${i}${ext}`);
  }
  await rename(path, target);
  return target;
      },
      hasFullDiskAccess,
    },
    net: { listeningPorts: ports },
    service: createService(os, run),
    git: {
      nullFile: '/dev/null',
      safeArguments: ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'core.sshCommand=ssh', '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'protocol.ext.allow=never'],
      environment: env => ({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_LITERAL_PATHSPECS: '1', LC_ALL: 'C' }),
    },
  };
}
