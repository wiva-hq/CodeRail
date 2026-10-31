// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Assemble the browser at build time. The shipped app never installs packages or downloads code.
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = join(import.meta.dir, '..');
const CACHE = join(ROOT, '.cache/browser');
const RELEASE = '152.0.4-beta.30';
const CAMOFOX = '1.18.1';
const IMPIT = '0.14.7';
const REVISION = '1';
const PLAYWRIGHT = '1.59.1';
const ENGINES: Record<string, { file: string; sha: string }> = {
  'darwin-arm64': { file: 'mac.arm64', sha: '3b43e766574f286a6a63296cf58b660b7a3120952086c869b4df4c9a71604bc3' },
  'darwin-x64': { file: 'mac.x86_64', sha: 'f12f90a3650478e670064a2f071c13b998fdd1125f79dc9f6cad5a9b9395b4bc' },
  'linux-arm64': { file: 'lin.arm64', sha: '60447260af8bebdb0ec3f2aa72f687b879e5598367303de2e3fdbc7a5be8c124' },
  'linux-x64': { file: 'lin.x86_64', sha: '5720d45b894ce1770543de024c6f10d514b38be560fa2dc3226b3d8586caf672' },
};

export async function command(cmd: string[], cwd = ROOT) {
  const p = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if (await p.exited !== 0) throw new Error(`Browser build failed: ${cmd.slice(0, 3).join(' ')}`);
}

export function browserDirectory(target: string) { return join(CACHE, `${CAMOFOX}-${RELEASE}-${REVISION}`, target, 'runtime'); }

export async function prepareBrowser(target: string) {
  const engine = ENGINES[target];
  if (!engine) throw new Error(`Unsupported browser target: ${target}`);
  const runtime = browserDirectory(target);
  const parent = dirname(runtime);
  const ready = join(parent, 'ready');
  const plugin = readFileSync(join(ROOT, 'src/camofox-plugin.js'));
  const stamp = `${PLAYWRIGHT}-${Bun.hash(plugin).toString(36)}`;
  if (existsSync(ready) && readFileSync(ready, 'utf8') === stamp) return runtime;
  rmSync(join(parent, 'browser.tar.gz'), { force: true });
  mkdirSync(parent, { recursive: true });
  const [os, arch] = target.split('-');
  const native = `impit-${target}${os === 'linux' ? '-gnu' : ''}`;
  writeFileSync(join(parent, 'package.json'), JSON.stringify({
    private: true, dependencies: { '@askjo/camofox-browser': CAMOFOX, [native]: IMPIT },
    overrides: { 'playwright-core': PLAYWRIGHT, impit: IMPIT },
  }));
  // Build dependencies only. Bun supplies SQLite at runtime; keep just the target's native N-API module.
  await command([process.execPath, 'install', '--production', '--ignore-scripts', '--omit=optional', '--linker=hoisted', `--os=${os}`, `--cpu=${arch}`], parent);
  rmSync(runtime, { recursive: true, force: true });
  mkdirSync(runtime, { recursive: true });
  cpSync(join(parent, 'node_modules'), join(runtime, 'node_modules'), { recursive: true, dereference: true });
  for (const name of ['better-sqlite3', '.bin']) rmSync(join(runtime, 'node_modules', name), { recursive: true, force: true });
  prune(join(runtime, 'node_modules'));
  const pkg = join(runtime, 'node_modules/@askjo/camofox-browser');
  mkdirSync(join(pkg, 'plugins/coderail'), { recursive: true });
  writeFileSync(join(pkg, 'plugins/coderail/index.js'), plugin);
  writeFileSync(join(pkg, 'camofox.config.json'), JSON.stringify({ plugins: { persistence: { enabled: true }, coderail: { enabled: true } } }));

  const zip = join(CACHE, `camoufox-${RELEASE}-${engine.file}.zip`);
  mkdirSync(CACHE, { recursive: true });
  if (!existsSync(zip)) {
    console.log(`bundling Camoufox for ${target}`);
    const response = await fetch(`https://github.com/daijro/camoufox/releases/download/v${RELEASE}/camoufox-${RELEASE}-${engine.file}.zip`);
    if (!response.ok) throw new Error(`Downloading Camoufox failed (${response.status})`);
    await Bun.write(zip, response);
  }
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(zip).stream()) hash.update(chunk);
  if (hash.digest('hex') !== engine.sha) { rmSync(zip); throw new Error('Camoufox download checksum does not match'); }
  const browser = join(runtime, 'camoufox');
  mkdirSync(browser);
  await command(['unzip', '-q', '-o', zip, '-d', browser]);
  writeFileSync(join(browser, 'version.json'), JSON.stringify({ version: '152.0.4', release: 'beta.30' }));
  makeExecutable(browser);
  // No extension manager or ad-blocker download is needed for the hub browser.
  writeFileSync(ready, stamp);
  return runtime;
}

function prune(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (['test', 'tests', '__tests__', 'docs', 'examples', '.github'].includes(e.name) || /\.(ts|map|md|ya?ml)$/.test(e.name) && !/^licen[cs]e/i.test(e.name)) rmSync(path, { recursive: true, force: true });
    else if (e.isDirectory()) prune(path);
  }
}
function makeExecutable(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) makeExecutable(path);
    else if (!e.isSymbolicLink()) chmodSync(path, 0o755);
  }
}

export async function browserArchive(target: string, output: string) {
  const runtime = await prepareBrowser(target);
  const cached = join(dirname(runtime), 'browser.tar.gz');
  if (!existsSync(cached)) {
    await command(['tar', '-czf', cached + '.tmp', '-C', runtime, '.']);
    renameSync(cached + '.tmp', cached);
  }
  cpSync(cached, output);
  return runtime;
}

// One universal browser inside the universal Mac app: shared fonts/resources are stored once.
export async function universalMacBrowser(output: string) {
  const arm = await prepareBrowser('darwin-arm64');
  const intel = await prepareBrowser('darwin-x64');
  cpSync(arm, output, { recursive: true, verbatimSymlinks: true });
  cpSync(join(intel, 'node_modules/impit-darwin-x64'), join(output, 'node_modules/impit-darwin-x64'), { recursive: true });
  const a = join(arm, 'camoufox/Camoufox.app');
  const b = join(intel, 'camoufox/Camoufox.app');
  const AdmZip = (await import(pathToFileURL(join(arm, 'node_modules/adm-zip/adm-zip.js')).href)).default;
  function sameArchive(left: string, right: string) {
    const x = new AdmZip(left), y = new AdmZip(right);
    if (x.getEntries().length !== y.getEntries().length) return false;
    return x.getEntries().every((e: any) => {
      const other = y.getEntry(e.entryName);
      if (!other) return false;
      if (e.header.crc === other.header.crc) return true;
      // The two upstream builds differ only in build timestamps and the about:buildconfig page.
      if (e.entryName === 'chrome/toolkit/content/global/buildconfig.html') return true;
      if (e.entryName !== 'modules/AppConstants.sys.mjs') return false;
      const normalize = (v: Buffer) => v.toString().replace(/MOZ_BUILDID: "\d+"/, 'MOZ_BUILDID: ""');
      return normalize(e.getData()) === normalize(other.getData());
    });
  }
  async function merge(rel: string) {
    for (const e of readdirSync(join(a, rel), { withFileTypes: true })) {
      const child = join(rel, e.name);
      if (e.isDirectory()) { await merge(child); continue; }
      if (e.isSymbolicLink()) continue;
      const left = join(a, child), right = join(b, child);
      if (!existsSync(right)) throw new Error(`Missing Intel browser resource: ${child}`);
      const magic = readFileSync(left).subarray(0, 4).toString('hex');
      if (['cffaedfe', 'cefaedfe', 'cafebabe', 'bebafeca'].includes(magic)) {
        await command(['lipo', '-create', left, right, '-output', join(output, 'camoufox/Camoufox.app', child)]);
      } else if (Bun.hash(Bun.file(left).size ? readFileSync(left) : '') !== Bun.hash(Bun.file(right).size ? readFileSync(right) : '')) {
        if (e.name === 'omni.ja' && sameArchive(left, right)) continue;
        // Architecture-specific configuration must never silently use the other chip's resources.
        if (!['Info.plist', 'application.ini', 'platform.ini', 'precomplete', 'removed-files'].includes(e.name)) throw new Error(`Different browser data for each chip: ${child}`);
      }
    }
  }
  await merge('');
}
