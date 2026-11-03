// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { existsSync, realpathSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { win32 as p } from 'node:path';
import { canonicalize, containsCanonical, error, normalize } from './paths';
import { ensurePrivateDirectory, writePrivateFile } from './private-fs';
import { NativeFile } from './native';

export interface Installation {
  schema: 1; id: string; root: string; version: string; executable: string; sha256: string;
}
const allowed = new Set(['bin','runtime','adapters','updates','browser','config.json','state.json','access.json','bridge.log','bridge.log.1','supervisor.cs','cleanup.cs','update.cs','owned-log.cs','startup.cs','update.json','supervisor.exe','supervisor.lock','supervisor.txt','supervisor-error.txt','installation.json','ownership.txt']);
export function readInstallation(root: string): Installation | null {
  if (!existsSync(root)) return null;
  const parent = new NativeFile(realpathSync.native(root), true);
  try {
    let file: NativeFile;
    try { file = parent.child('installation.json', false); } catch (cause: any) { if (cause.code === 'ENOENT') return null; throw cause; }
    let record: Installation; try { if(file.details().size>16384)throw error('EINVAL','Installation marker exceeds 16 KiB');record = JSON.parse(file.read(realpathSync.native(root), 16384).toString('utf8')); } finally { file.close(); }
    if (!record || record.schema !== 1 || typeof record.version!=='string' || record.version.length>64 || !/^\d+\.\d+\.\d+\+\d+$/.test(record.version) || record.executable!==p.join(root,'bin/current/coderail.exe') || !/^[a-f0-9]{32}$/.test(record.id) || !/^[a-f0-9]{64}$/.test(record.sha256) || !containsCanonical(root, record.root) || !containsCanonical(record.root, root)) throw error('EINVAL', 'Invalid CodeRail installation ownership');
    // Missing current is a recoverable update layout. Existing images must be
    // exactly the expected physical file, never a Junction/Symlink redirect.
    if(existsSync(record.executable)&&realpathSync.native(record.executable)!==record.executable)throw error('EACCES','Installed image is not its owned physical path');
    return record;
  } finally { parent.close(); }
}
export async function guardInstallationRoot(input: string) {
  const requested = normalize(input); if (requested.startsWith('\\\\')) throw error('ENOTSUP', 'Install into a local user directory');
  const root = await canonicalize(requested, 'create');
  if (p.parse(root).root === root) throw error('EACCES', 'Refuse installing into a volume root');
  for (const known of [homedir(), tmpdir(), process.env.LOCALAPPDATA, process.env.APPDATA, process.env.SystemRoot, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
    if (!known || !existsSync(known)) continue;
    const physical = realpathSync.native(known);
    if (containsCanonical(root, physical) && containsCanonical(physical, root)) throw error('EACCES', 'Refuse using a shared/profile/system root as installation directory');
  }
  if (existsSync(requested) && normalize(realpathSync.native(requested)) !== requested) throw error('EACCES', 'Installation root must be its physical path');
  if (existsSync(root) && !readInstallation(root)) {
    const entries = await readdir(root);
    const unknown = entries.filter(name => !allowed.has(name) && !/^(?:stop|restart|bridge-stop)-[a-f0-9]{32}$/.test(name) && !/^browser-mcp-[a-z0-9]+\.js$/.test(name));
    if (unknown.length) throw error('EEXIST', 'Directory contains files not owned by CodeRail');
    if (entries.length) {
      const directory = new NativeFile(root, true);
      try {
        let legacy = false;
        try {
          const config = directory.child('config.json', false);
          try { const value = JSON.parse(config.read(root, 16384).toString('utf8')); legacy = typeof value.server === 'string' && /^https?:\/\//.test(value.server) && typeof value.machineId === 'string' && typeof value.token === 'string' && value.token.length >= 16; }
          finally { config.close(); }
        } catch (cause: any) { if (cause.code !== 'ENOENT') throw cause; }
        if (!legacy) for (const entry of entries) {
          if (!['bin','runtime','adapters'].includes(entry)) throw error('EEXIST', 'Nonempty unowned installation directory');
          const child = directory.child(entry, true);
          try { if (child.entries().length) throw error('EEXIST', 'Nonempty unowned installation directory'); }
          finally { child.close(); }
        }
      } finally { directory.close(); }
    }
  }
  return root;
}
export async function deployBinary(input: string, source: string, version: string): Promise<Installation> {
  if (!/^\d+\.\d+\.\d+\+\d+$/.test(version)) throw error('EINVAL', 'Invalid build version');
  const root = await guardInstallationRoot(input), physicalSource = realpathSync.native(source), previous = readInstallation(root);
  if (!previous && containsCanonical(root, physicalSource)) throw error('EACCES', 'Installation cannot own an ancestor of its source binary');
  const bytes = new Uint8Array(await Bun.file(physicalSource).arrayBuffer());
  if (bytes.length < 64 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) throw error('EINVAL', 'Installation requires a compiled Windows executable');
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), pe = header.readUInt32LE(0x3c);
  if (pe + 6 > bytes.length || header.readUInt32LE(pe) !== 0x4550 || header.readUInt16LE(pe + 4) !== 0x8664) throw error('EINVAL', 'Installation requires a Windows x64 PE image');
  const sha256 = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  ensurePrivateDirectory(root); const current = p.join(root, 'bin/current'); ensurePrivateDirectory(current);
  const executable = p.join(current, 'coderail.exe');
  const target = existsSync(executable) ? realpathSync.native(executable) : executable;
  if (!(containsCanonical(physicalSource, target) && containsCanonical(target, physicalSource))) writePrivateFile(executable, bytes);
  const record: Installation = { schema: 1, id: previous?.id ?? crypto.randomUUID().replaceAll('-', ''), root, version, executable, sha256 };
  writePrivateFile(p.join(root, 'installation.json'), JSON.stringify(record, null, 2)); return record;
}
