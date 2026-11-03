// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PlatformAdapter, ServiceSpec, RunOptions, RunResult } from '../types';

const LABEL = 'codes.coderail.bridge';

export function createService(os: 'darwin' | 'linux', run: (cmd: string[], options?: RunOptions) => Promise<RunResult>, uid = () => process.getuid!()): PlatformAdapter['service'] {
  async function install(spec: ServiceSpec) {
    const { home: HOME, stateDir: STATE_DIR, logPath: LOG_PATH, command: cmd, quiet = false } = spec;
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    if (os === 'darwin') {
      const plist = join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`);
      mkdirSync(join(HOME, 'Library/LaunchAgents'), { recursive: true });
      const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
      writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>${cmd.map((c) => `<string>${esc(c)}</string>`).join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>${esc(HOME)}</string>
  <key>StandardOutPath</key><string>${esc(LOG_PATH)}</string>
  <key>StandardErrorPath</key><string>${esc(LOG_PATH)}</string>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`,
      );
      const domain = `gui/${uid()}`;
      // bootout returns before the old service has stopped, and bootstrap fails while it's still there.
      await run(['launchctl', 'bootout', `${domain}/${LABEL}`]);
      for (let i = 0; i < 50 && (await run(['launchctl', 'print', `${domain}/${LABEL}`])).code === 0; i++) await Bun.sleep(100);
      let r = await run(['launchctl', 'bootstrap', domain, plist]);
      for (let i = 0; i < 5 && r.code !== 0; i++) {
        await Bun.sleep(500);
        r = await run(['launchctl', 'bootstrap', domain, plist]);
      }
      if (r.code !== 0) {
        console.error(`launchctl could not start the service: ${r.stderr.trim()}`);
        process.exit(1);
      }
      if (!quiet) console.log('Service installed (launchd).');
    } else if (os === 'linux') {
      const dir = join(HOME, '.config/systemd/user');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'coderail.service'),
        `[Unit]
Description=CodeRail bridge
After=network-online.target

[Service]
ExecStart=${cmd.map((c) => `"${c.replace(/[\\"]/g, '\\$&').replace(/%/g, '%%')}"`).join(' ')}
Restart=on-failure
RestartSec=5
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}

[Install]
WantedBy=default.target
`,
      );
      await run(['systemctl', '--user', 'daemon-reload']);
      const r = await run(['systemctl', '--user', 'enable', '--now', 'coderail']);
      if (r.code !== 0) {
        console.error(`systemctl could not start the service: ${r.stderr.trim()}`);
        process.exit(1);
      }
      await run(['systemctl', '--user', 'restart', 'coderail']);
      if (!quiet) console.log('Service installed (systemd --user). For it to run while you are logged out: loginctl enable-linger');
    } else {
      console.error('Running as a service is not supported here yet; use coderail run.');
    }
  }

  async function uninstall(spec: ServiceSpec) {
    const HOME = spec.home;
    if (os === 'darwin') {
      await run(['launchctl', 'bootout', `gui/${uid()}/${LABEL}`]);
      const plist = join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`);
      if (existsSync(plist)) unlinkSync(plist);
    } else if (os === 'linux') {
      await run(['systemctl', '--user', 'disable', '--now', 'coderail']);
      rmSync(join(HOME, '.config/systemd/user/coderail.service'), { force: true });
    }
  }

  return {
    install,
    uninstall,
    async status() {
      let service: string;
      if (os === 'darwin') {
        const r = await run(['launchctl', 'print', `gui/${uid()}/${LABEL}`]);
        service = r.code === 0 ? (r.stdout.match(/state = (\w+)/)?.[1] ?? 'loaded') : 'not installed';
      } else {
        const r = await run(['systemctl', '--user', 'is-active', 'coderail']);
        service = r.stdout.trim() || 'not installed';
      }
      return service;
    },
    async followLogs(path) {
      await Bun.spawn(['tail', '-n', '100', '-f', path], { stdout: 'inherit', stderr: 'inherit' }).exited;
    },
  };
}
