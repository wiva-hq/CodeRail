// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { gitArguments, gitEnvironment, clearGitEnvironment } from '../../../bridge/src/platform/win32/git';
import { runWindows } from './process';
export { findGit, gitEnvironment } from '../../../bridge/src/platform/win32/git';
export class WindowsGit {
  constructor(readonly executable: string) {}
  async run(args: string[], cwd: string, options: { restricted?: boolean; input?: string; timeout?: number; envPatch?: Record<string, string> } = {}) {
    return runWindows([this.executable, ...gitArguments(args, options.restricted !== false)], {
      cwd, clearEnv: clearGitEnvironment, envPatch: { ...gitEnvironment, ...options.envPatch }, input: options.input, timeout: options.timeout ?? 30000,
    });
  }
}
