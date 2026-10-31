// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Bridge } from './bridge';
import { type Config, loadConfig, saveConfig } from './config';
import { CONFIG_PATH, HOME, LOG_PATH, STATE_DIR, STATE_PATH, VERSION, hasFullDiskAccess, log, machineBasics, run, setFullDiskAccess } from './env';
import { detect } from './agents';
import { HARNESSES } from '@coderail/protocol';

const HELP = `CodeRail bridge ${VERSION}: puts this computer's coding agents on your CodeRail site.

Usage:
  coderail link <https://your-coderail-site> [--name <name>] [--no-service] [--json]
                          Link this computer (you approve it in the browser), then run as a service
  coderail run            Run in the foreground
  coderail status [--json]
                          Show the link and the service
  coderail logs           Follow the service's log
  coderail service install|uninstall|restart
  coderail unlink         Stop the service and forget the link
  coderail access [--wait <seconds>]
                          macOS: whether this has Full Disk Access (waits for it, with --wait)
  coderail version
`;

const LABEL = 'codes.coderail.bridge';

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'link':
      return link(args);
    case 'run':
      return runBridge();
    case 'status':
      return status(args.includes('--json'));
    case 'logs':
      return void (await Bun.spawn(['tail', '-n', '100', '-f', LOG_PATH], { stdout: 'inherit', stderr: 'inherit' }).exited);
    case 'service':
      if (args[0] === 'install' || args[0] === 'restart') return installService();
      if (args[0] === 'uninstall') return uninstallService();
      break;
    case 'unlink':
      await uninstallService();
      if (existsSync(CONFIG_PATH)) unlinkSync(CONFIG_PATH);
      rmSync(join(STATE_DIR, 'adapters'), { recursive: true, force: true });
      console.log('Unlinked. Remove the machine on the site too if it is still listed.');
      return;
    case 'access':
      return access(args);
    case 'version':
    case '--version':
    case '-v':
      return console.log(VERSION);
  }
  console.log(HELP);
  if (cmd && cmd !== 'help' && cmd !== '--help' && cmd !== '-h') process.exit(1);
}

/**
 * With --json (for the menu bar app), progress is one JSON object per line instead of text:
 * {event:'code', code, url}, {event:'linked', name, server}, {event:'error', message}.
 */
async function link(args: string[]) {
  const json = args.includes('--json');
  const say = (text: string, event: Record<string, unknown>) => (json ? console.log(JSON.stringify(event)) : console.log(text));
  const fail = (message: string): never => {
    if (json) console.log(JSON.stringify({ event: 'error', message }));
    else console.error(message);
    process.exit(1);
  };
  let server = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--name');
  const nameIdx = args.indexOf('--name');
  const name = nameIdx >= 0 ? args[nameIdx + 1] : machineBasics().hostname;
  if (!server) fail('Name your CodeRail site: coderail link https://coderail.example.com');
  if (!/^https?:\/\//.test(server!)) server = 'https://' + server;
  server = server!.replace(/\/+$/, '');
  // (The machine's token goes to the server: never in the clear, except to this computer itself.)
  if (/^http:\/\//.test(server) && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(server)) fail('Your CodeRail site must use https://');

  const harnesses = await Promise.all(HARNESSES.map((h) => detect(h.id)));
  const info = { ...machineBasics(), bridgeVersion: VERSION, harnesses };
  let start: any;
  try {
    start = await post(server, '/api/pair/start', { name, info });
  } catch (e: any) {
    fail(`Could not reach ${server}: ${e.message}`);
  }
  say(`\nTo link "${name}", open this link and approve it:\n\n  ${start.url}\n\nCode: ${start.code}\n`, {
    event: 'code',
    code: start.code,
    url: start.url,
  });
  if (!process.env.CODERAIL_NO_OPEN) {
    try {
      Bun.spawn([process.platform === 'darwin' ? 'open' : 'xdg-open', start.url], { stdout: 'ignore', stderr: 'ignore' });
    } catch {}
  }

  if (!json) process.stdout.write('Waiting for approval');
  const deadline = Date.now() + 15 * 60_000;
  while (Date.now() < deadline) {
    await Bun.sleep(2000);
    if (!json) process.stdout.write('.');
    let r: any;
    try {
      r = await post(server, '/api/pair/poll', { code: start.code, secret: start.secret });
    } catch (e: any) {
      fail(`\n${e.message}`);
    }
    if (r.token) {
      const config: Config = { server, machineId: r.machineId, token: r.token, name: r.name };
      saveConfig(config);
      if (args.includes('--no-service')) {
        say(`\n\nLinked as "${r.name}".`, { event: 'linked', name: r.name, server });
        return runBridge();
      }
      await installService(json);
      say(
        `\n\nLinked as "${r.name}".\nThe bridge now runs in the background and starts when you log in.\nOpen ${server} to use this computer.`,
        { event: 'linked', name: r.name, server },
      );
      return;
    }
  }
  fail('\nThe code expired. Run coderail link again.');
}

/**
 * macOS: whether this program has Full Disk Access, into the state file (the Mac app's permission screen runs this
 * under launchd, so the answer is the bridge's own, as its service will run). With --wait, checks each second until
 * it's allowed or the time is up.
 */
async function access(args: string[]) {
  const i = args.indexOf('--wait');
  const until = Date.now() + (i >= 0 ? Number(args[i + 1]) || 0 : 0) * 1000;
  for (;;) {
    const v = await hasFullDiskAccess();
    setFullDiskAccess(v);
    if (v !== false || Date.now() >= until) {
      console.log(JSON.stringify({ fullDiskAccess: v }));
      return;
    }
    await Bun.sleep(1000);
  }
}

async function post(server: string, path: string, body: unknown) {
  const res = await fetch(server + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data;
}

function runBridge() {
  const config = loadConfig();
  if (!config) {
    console.error('This computer is not linked yet. Run: coderail link https://your-coderail-site');
    process.exit(2);
  }
  log(`CodeRail bridge ${VERSION} for "${config.name}" (${config.machineId})`);
  const bridge = new Bridge(config);
  bridge.start();
  const stop = () => {
    log('stopping');
    bridge.stop();
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function status(json: boolean) {
  const config = loadConfig();
  let service: string;
  if (process.platform === 'darwin') {
    const r = await run(['launchctl', 'print', `gui/${process.getuid!()}/${LABEL}`]);
    service = r.code === 0 ? (r.stdout.match(/state = (\w+)/)?.[1] ?? 'loaded') : 'not installed';
  } else {
    const r = await run(['systemctl', '--user', 'is-active', 'coderail']);
    service = r.stdout.trim() || 'not installed';
  }
  if (json) {
    let state: unknown = null;
    try {
      state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    } catch {}
    const link = config && { server: config.server, name: config.name, machineId: config.machineId };
    console.log(JSON.stringify({ version: VERSION, link, service, state, log: LOG_PATH }));
    return;
  }
  console.log(config ? `Linked to ${config.server} as "${config.name}" (${config.machineId})` : 'Not linked');
  console.log(`Service: ${service}`);
  console.log(`Log: ${LOG_PATH}`);
}

/** How to start this bridge again: the built binary, or bun with this script in development. */
function selfCommand(): string[] {
  const script = process.argv[1];
  if (script && /\.(ts|js)$/.test(script) && !script.startsWith('/$bunfs')) return [process.execPath, script];
  return [process.execPath];
}

async function installService(quiet = false) {
  mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  const cmd = [...selfCommand(), 'run'];
  if (process.platform === 'darwin') {
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
    const domain = `gui/${process.getuid!()}`;
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
  } else if (process.platform === 'linux') {
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

async function uninstallService() {
  if (process.platform === 'darwin') {
    await run(['launchctl', 'bootout', `gui/${process.getuid!()}/${LABEL}`]);
    const plist = join(HOME, 'Library/LaunchAgents', `${LABEL}.plist`);
    if (existsSync(plist)) unlinkSync(plist);
  } else if (process.platform === 'linux') {
    await run(['systemctl', '--user', 'disable', '--now', 'coderail']);
    rmSync(join(HOME, '.config/systemd/user/coderail.service'), { force: true });
  }
}

main().catch((e) => {
  console.error(e?.message ?? e);
  process.exit(1);
});
