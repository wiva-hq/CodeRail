// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Builds the bridge: each ACP adapter bundled to one JavaScript file, embedded in a single binary per
// platform. `bun scripts/build.ts [target...]`, targets like darwin-arm64 (default: all). The build
// number comes from CODERAIL_BUILD (the release pipeline's run number), else 0.
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { browserArchive } from './browser';
import { platform } from '../src/platform';

const root = join(import.meta.dir, '..');
const out = join(root, 'build');
const ALL = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'linux-arm64'];
const targets = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
for (const target of targets) if (![...ALL, 'windows-x64'].includes(target)) throw new Error(`Unsupported build target: ${target}; Windows ARM64 native layouts are not validated`);
const windows = targets.includes('windows-x64');
if (windows && Bun.version !== '1.4.4') throw new Error('Windows builds require Bun 1.4.4');
const providedSupervisor = process.env.CODERAIL_SUPERVISOR_BINARY;
const csc = process.platform === 'win32' ? join(process.env.SystemRoot!, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe') : null;
if (windows && !providedSupervisor && (!csc || !existsSync(csc))) throw new Error('Windows build needs a Windows C# compiler or CODERAIL_SUPERVISOR_BINARY from a verified Windows build');

// Validate the exact build directory before recursive deletion; never follow a Junction.
const physicalRoot = realpathSync.native(root);
const physicalOut = existsSync(out) ? realpathSync.native(out) : join(physicalRoot, 'build');
const rel = relative(physicalRoot, physicalOut);
if (rel !== 'build' || isAbsolute(rel) || (existsSync(out) && lstatSync(out).isSymbolicLink())) throw new Error('Unsafe build output directory');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'adapters'), { recursive: true });
if (windows) {
  if (providedSupervisor) await Bun.write(join(out, 'supervisor.exe'), Bun.file(realpathSync.native(providedSupervisor)));
  else {
    const compiled = await platform.process.run([csc!, '/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/r:System.Web.Extensions.dll', '/main:Supervisor', '/out:' + join(out, 'supervisor.exe'), join(root, 'src/platform/win32/supervisor.cs'), join(root, 'src/platform/win32/cleanup.cs'), join(root, 'src/platform/win32/update.cs'),join(root, 'src/platform/win32/owned-log.cs'),join(root, 'src/platform/win32/startup.cs')], { cwd: root, timeout: 60000 });
    if (compiled.code) throw new Error(compiled.stderr || compiled.stdout);
  }
  const bytes = Buffer.from(await Bun.file(join(out, 'supervisor.exe')).arrayBuffer());
  const pe = bytes.readUInt32LE(0x3c);
  if (bytes.readUInt16LE(pe + 4) !== 0x8664 || bytes.readUInt16LE(pe + 24 + 68) !== 2) throw new Error('Supervisor must be a Windows x64 GUI image');
}

const adapters: Record<string, string> = {
  'claude-code': '@agentclientprotocol/claude-agent-acp/dist/index.js',
  codex: '@agentclientprotocol/codex-acp/dist/index.js',
};

for (const [id, entry] of Object.entries(adapters)) {
  const r = await Bun.build({
    entrypoints: [Bun.resolveSync(entry, root)],
    target: 'bun',
    format: 'esm',
    minify: false,
    // The harnesses' own binaries: CodeRail runs the machine's installed claude / codex instead.
    external: ['@anthropic-ai/claude-agent-sdk-*', '@openai/codex-*', '@openai/codex'],
  });
  if (!r.success) {
    for (const m of r.logs) console.error(m);
    process.exit(1);
  }
  await Bun.write(join(out, 'adapters', `${id}.js`), r.outputs[0]);
  console.log(`bundled ${id}: ${(r.outputs[0].size / 1e6).toFixed(1)} MB`);
}

const entry = `import claude from './adapters/claude-code.js' with { type: 'file' };
import codex from './adapters/codex.js' with { type: 'file' };
globalThis.__CODERAIL_ADAPTERS__ = { 'claude-code': claude, codex };
globalThis.__CODERAIL_COMPILED__ = true;
`;

for (const t of targets) {
  const win = t.startsWith('windows');
  async function compile(output: string, source: string) {
    const command = [process.execPath, 'build', source, '--compile', '--minify', `--target=bun-${t}`, '--define', `CODERAIL_BUILD=${JSON.stringify(process.env.CODERAIL_BUILD ?? '0')}`, '--outfile', output, ...(win ? ['--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig'] : [])];
    if (process.platform === 'win32') {
      const result = await platform.process.run(command, { cwd: root, timeout: 180000 });
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
      if (result.code) process.exit(result.code);
    } else if (await Bun.spawn(command, { cwd: root, stdout: 'inherit', stderr: 'inherit' }).exited !== 0) process.exit(1);
    if (t.startsWith('darwin') && process.platform === 'darwin') {
      if (await Bun.spawn(['codesign', '--force', '--sign', '-', output]).exited !== 0) process.exit(1);
    }
    console.log(`built ${output} (${(Bun.file(output).size / 1e6).toFixed(1)} MB)`);
  }
  const archive = join(out, `browser-${t}.tar.gz`);
  await browserArchive(t, archive);
  const hash = new Bun.CryptoHasher('sha256');
  for await (const chunk of Bun.file(archive).stream()) hash.update(chunk);
  writeFileSync(join(out, 'entry.ts'), entry + `
import browser from './browser-${t}.tar.gz' with { type: 'file' };
globalThis.__CODERAIL_BROWSER__ = { archive: browser, hash: '${hash.digest('hex').slice(0, 24)}' };
${win ? `import supervisor from './supervisor.exe' with { type: 'file' };
globalThis.__CODERAIL_SUPERVISOR__ = supervisor;
` : ''}await import('../src/main.ts');
`);
  await compile(join(out, `coderail-${t}${win ? '.exe' : ''}`), join(out, 'entry.ts'));
  if (t.startsWith('darwin')) {
    // The Mac app carries its browser as signed resources, once, outside the universal bridge binary.
    mkdirSync(join(out, 'app'), { recursive: true });
    writeFileSync(join(out, 'app-entry.ts'), entry + "await import('../src/main.ts');\n");
    await compile(join(out, 'app', `coderail-${t}`), join(out, 'app-entry.ts'));
  }
  rmSync(archive);
}
