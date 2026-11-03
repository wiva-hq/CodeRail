// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, lstatSync, readFileSync, realpathSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Bridge } from './bridge';
import { type Config, loadConfig, saveConfig } from './config';
import { CONFIG_PATH, HOME, LOG_PATH, STATE_DIR, STATE_PATH, VERSION, hasFullDiskAccess, log, machineBasics, setFullDiskAccess } from './env';
import { detect } from './agents';
import { HARNESSES } from '@coderail/protocol';
import { platform } from './platform';
declare global { var __CODERAIL_COMPILED__: boolean | undefined; }

const HELP = `CodeRail bridge ${VERSION}: puts this computer's coding agents on your CodeRail site.

Usage:
  coderail install         Windows: install this binary for the current user; then pair
  coderail uninstall       Windows: unregister and schedule removal after this CLI exits
  coderail update [--manifest <url>]
                          Windows: verify and stage an update, then let the supervisor activate it
  coderail link <https://your-coderail-site> [--name <name>] [--no-service] [--json]
                          Link this computer (you approve it in the browser), then run as a service
  coderail pair <https://your-coderail-site>
                          Alias for link
  coderail restart        Windows: restart the Bridge through its persistent supervisor
  coderail run            Run in the foreground
  coderail status [--json]
                          Show the link and the service
  coderail logs [-f]      Windows: recent service log; -f follows new output
  coderail service install|uninstall|restart
  coderail unlink         Stop the service and forget the link
  coderail access [--wait <seconds>]
                          macOS: whether this has Full Disk Access (waits for it, with --wait)
  coderail version
`;

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'install':
      if (platform.os === 'win32') {
        if (!globalThis.__CODERAIL_COMPILED__) throw new Error('Install using the compiled Windows executable');
        const { installPrepared } = await import('./platform/win32/install-transaction');
        const result = await installPrepared(STATE_DIR, process.execPath, VERSION);
        console.log(`Installed ${VERSION}: ${result.installed.executable}`);
        if (result.notification?.status === 'unavailable') console.warn(`Environment notification unavailable (${result.notification.reason}); open a new login session if PATH is stale.`);
        console.log(`Pair next: "${result.installed.executable}" pair https://your-coderail-site`);
        console.log('Network: allow outbound HTTPS/WebSocket to your site. No inbound firewall rule or administrator access is required by the bridge.');
        return;
      }
      break;
    case 'uninstall':
      if (platform.os === 'win32') {
        const { uninstallOwned } = await import('./platform/win32/lifecycle');
        const result = await uninstallOwned(STATE_DIR);
        console.log(`Startup and owned PATH entry removed. Cleanup scheduled after this CLI exits: ${result.installationRoot}`);
        if (result.notification?.status === 'unavailable') console.warn(`Environment notification unavailable (${result.notification.reason}); existing terminals keep their old PATH.`);
        console.log(`If the directory remains, inspect cleanup-error-${result.actor.nonce}.txt there.`);
        return;
      }
      break;
    case 'update':
      if (platform.os === 'win32') {
        const {readInstallation,guardInstallationRoot}=await import('./platform/win32/install-files');
        const root=await guardInstallationRoot(STATE_DIR),installed=readInstallation(root);
        if(!installed)throw new Error('Install the Windows package before updating');
        const config=loadConfig(),index=args.indexOf('--manifest');
        const url=index>=0?args[index+1]:config?`${config.server}/api/version/windows-x64`:null;
        if(!url)throw new Error('Pair this installation, or provide --manifest <https-url>');
        const {fetchManifest,downloadAndStage}=await import('./platform/win32/update-manifest');
        const manifest=await fetchManifest(url);
        if(manifest.version===installed.version){console.log(`Already up to date: ${installed.version}`);return;}
        const components=(version:string)=>version.split(/[.+]/).map(BigInt);
        const current=components(installed.version),next=components(manifest.version);
        let newer=false;for(let i=0;i<4;i++){if(next[i]>current[i]){newer=true;break;}if(next[i]<current[i])break;}
        if(!newer)throw new Error('Refusing a manifest downgrade; automatic rollback uses the owned previous generation');
        const {UserService}=await import('./platform/win32/service');
        const service=new UserService(),spec=await serviceSpec();
        if(!(await service.status(spec)).running){if(!config)throw new Error('Pair and start this installation before updating');await service.start(spec);}
        const {assertUpdateSupport,requestUpdate}=await import('./platform/win32/update-request');
        await assertUpdateSupport(root);
        const staged=await downloadAndStage(root,manifest),result=await requestUpdate(root,staged);
        console.log(`Update ${result.version} scheduled after this CLI exits.`);
        console.log(`Result: ${join(root,'update-result-'+result.nonce)}; failures: ${join(root,'update-error-'+result.nonce+'.txt')}`);
        return;
      }
      break;
    case 'link':
    case 'pair':
      return link(args);
    case 'run':
      return runBridge();
    case 'status':
      return status(args.includes('--json'));
    case 'logs':
      if (platform.os === 'win32' && !args.includes('-f')) {
        const { printLogs } = await import('./platform/win32/logs');
        return printLogs(LOG_PATH);
      }
      return platform.service.followLogs(LOG_PATH);
    case 'service':
      if (args[0] === 'install' || args[0] === 'restart') return installService();
      if (args[0] === 'uninstall') return uninstallService();
      break;
    case 'restart':
      if (platform.os === 'win32') {
        const { UserService } = await import('./platform/win32/service');
        return new UserService().restart(await serviceSpec());
      }
      return installService();
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
      platform.shell.openExternal(start.url);
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
  const res = await fetch(server + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), ...(platform.net.proxyFor ? { proxy: platform.net.proxyFor(server) } : {}) });
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
  let stopping = false;
  let control: ReturnType<typeof setInterval> | undefined;
  bridge.start();
  const stop = () => {
    if (stopping) return;
    stopping = true;
    if (control) clearInterval(control);
    log('stopping');
    bridge.stop();
    setTimeout(() => process.exit(0), 300);
  };
  platform.process.onShutdown(stop);
  const request = platform.os === 'win32' ? process.env.CODERAIL_STOP_FILE : undefined;
  if (request) {
    const root = realpathSync.native(STATE_DIR), parent = realpathSync.native(dirname(request));
    if (root.toLowerCase() !== parent.toLowerCase() || !/^bridge-stop-[a-f0-9]{32}$/.test(basename(request))) throw new Error('Invalid supervisor shutdown path');
    control = setInterval(() => {
      try {
        const entry = lstatSync(request);
        if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Supervisor shutdown request must be a regular file');
        const real = realpathSync.native(request);
        if (dirname(real).toLowerCase() !== root.toLowerCase()) throw new Error('Supervisor shutdown request escaped private directory');
        stop();
      } catch (error: any) { if (error.code !== 'ENOENT') { log('supervisor control failed', error); } }
    }, 100);
  }
}

async function status(json: boolean) {
  const config = loadConfig();
  const service = await platform.service.status();
  let resources: Awaited<ReturnType<NonNullable<typeof platform.service.details>>> | undefined;
  let resourcesError: string | undefined;
  try { resources = await platform.service.details?.(); }
  catch (error) { resourcesError = error instanceof Error ? error.message : String(error); }
  if (json) {
    let state: unknown = null;
    try {
      state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
    } catch {}
    const link = config && { server: config.server, name: config.name, machineId: config.machineId };
    console.log(JSON.stringify({ version: VERSION, link, service, state, log: LOG_PATH, resources, resourcesError }));
    return;
  }
  console.log(config ? `Linked to ${config.server} as "${config.name}" (${config.machineId})` : 'Not linked');
  console.log(`Service: ${service}`);
  if (resources?.running) {
    console.log(`Processes: ${resources.processes?.map(item => item.pid).join(', ')}`);
    console.log(`Memory: working set ${resources.workingSetBytes} bytes; private ${resources.privateBytes} bytes (tree sum)`);
    console.log(`Listening: ${resources.ports?.map(item => `${item.address}:${item.port} (pid ${item.pid})`).join(', ') || 'none'}`);
  }
  if (resourcesError) console.log(`Resources unavailable: ${resourcesError}`);
  console.log(`Log: ${LOG_PATH}`);
}

/** How to start this bridge again: the built binary, or bun with this script in development. */
function selfCommand(): string[] {
  if (globalThis.__CODERAIL_COMPILED__) return [process.execPath];
  const script = process.argv[1];
  const embedded = script && (/^\/\$bunfs[\\/]/.test(script) || /^[a-z]:[\\/]~BUN[\\/]/i.test(script));
  if (script && /\.(ts|js)$/.test(script) && !embedded) return [process.execPath, script];
  return [process.execPath];
}

async function serviceSpec(quiet = false) {
  let command=selfCommand();
  if(platform.os==='win32'){
    const {readInstallation,guardInstallationRoot}=await import('./platform/win32/install-files');
    const root=await guardInstallationRoot(STATE_DIR),installed=readInstallation(root);
    if(installed){if(installed.executable!==join(root,'bin/current/coderail.exe'))throw new Error('Invalid installed command ownership');command=[installed.executable];}
  }
  return { command: [...command, 'run'], home: HOME, stateDir: STATE_DIR, logPath: LOG_PATH, quiet };
}

async function installService(quiet = false) {
  await platform.service.install(await serviceSpec(quiet));
}

async function uninstallService() {
  await platform.service.uninstall(await serviceSpec());
}

main().catch((e) => {
  console.error(process.env.CODERAIL_DEBUG ? (e?.stack ?? e) : (e?.message ?? e));
  process.exit(1);
});
