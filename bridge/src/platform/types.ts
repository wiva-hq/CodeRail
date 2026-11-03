// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/** A local TCP listener (status details and port discovery). */
export interface ListeningPort { port: number; pid: number; command: string; address: string }

export type Env = Record<string, string>;
export interface RunOptions { cwd?: string; timeout?: number; input?: string; env?: Env }
export interface RunResult { code: number; stdout: string; stderr: string }
export interface ServiceSpec { command: string[]; home: string; stateDir: string; logPath: string; quiet?: boolean }

export class PlatformUnsupportedError extends Error {
  constructor(os: string, feature: string) {
    super(`${feature} is not implemented on ${os} yet`);
    this.name = 'PlatformUnsupportedError';
  }
}

/** Phase 0 compatibility boundary. Bun handles stay here until the Windows PoCs
 * establish the managed-process and ConPTY contracts; no tree-cleanup claim is
 * made for the existing POSIX child.kill implementation. */
export interface PlatformAdapter {
  readonly os: 'darwin' | 'linux' | 'win32';
  readonly path: {
    readonly delimiter: ':' | ';';
    home(): string;
    stateDir(): string;
    expandUser(input: string): string;
    basename(path: string): string;
    contains(root: string, candidate: string): boolean;
    hasSegment(path: string, segment: string): boolean;
  };
  readonly process: {
    spawn: typeof Bun.spawn;
    /** Windows Job-owned asynchronous stream/ConPTY startup; absent on POSIX. */
    spawnManaged?: typeof import('./win32/stream').spawnStream;
    stopLegacy(child: ReturnType<typeof Bun.spawn>, kind: 'agent' | 'terminal'): void;
    run(command: string[], options?: RunOptions): Promise<RunResult>;
    onShutdown(handler: () => void): () => void;
  };
  readonly shell: {
    userEnv(options?: { refresh?: boolean }): Promise<Env>;
    findExecutable(name: string, env: Env): string | null;
    defaultCommand(env: Env): string[];
    openExternal(url: string): void;
  };
  readonly fs: {
    /** Compare already-native-canonical physical paths without Unicode folding. */
    containsCanonical?(root: string, candidate: string): boolean;
    /** Optional handle-based capability; POSIX retains its existing I/O path. */
    openScope?: typeof import('./win32/fs').ScopedWindowsFs.create;
    canonicalize(input: string, intent: 'existing' | 'create'): Promise<string>;
    ensurePrivateDirectory(path: string): void;
    writePrivateFile(path: string, content: string): void;
    trash(path: string): Promise<string>;
    hasFullDiskAccess(): Promise<boolean | null>;
  };
  readonly net: { listeningPorts(): Promise<ListeningPort[]>; proxyFor?(url: string): string | undefined };
  readonly service: {
    status(): Promise<string>;
    /** Optional native process-tree sample; absent on existing POSIX adapters. */
    details?(): Promise<{ running: boolean; rootPid?: number; sampledAt?: string; workingSetBytes?: number; privateBytes?: number; processes?: { pid: number; created: string; name: string; workingSetBytes: number; privateBytes: number }[]; ports?: ListeningPort[] }>;
    install(spec: ServiceSpec): Promise<void>;
    uninstall(spec: ServiceSpec): Promise<void>;
    followLogs(path: string): Promise<void>;
  };
  readonly git: { readonly nullFile: string; safeArguments: readonly string[]; environment(env: Env): Env; executable?():Promise<string>; arguments?(args:string[],restricted:boolean):string[] };
}
