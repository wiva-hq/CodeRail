// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { lstat } from 'node:fs/promises';
import { win32 as p } from 'node:path';
import { canonicalize, contains, containsCanonical, error, nativeRealpath, normalize, retry } from './paths';
import { NativeFile } from './native';

/** A root is pinned for the lifetime of the capability. Dispose when its caller disconnects. */
export class ScopedWindowsFs {
  private closed = false;
  private constructor(readonly root: string, private rootLease: NativeFile, readonly denied: readonly string[]) {}
  static async create(root: string, denied: readonly string[] = []) {
    const resolved = await nativeRealpath(normalize(root));
    const lease = new NativeFile(resolved, true);
    try {
      if (lease.finalPath().toLowerCase() !== resolved.toLowerCase()) throw error('EACCES', 'Root changed during authorization');
      const fs = new ScopedWindowsFs(resolved, lease, await Promise.all(denied.map(d => canonicalize(d, 'create'))));
      fs.check(resolved, true); return fs;
    } catch (e) { lease.close(); throw e; }
  }
  private check(path: string, physical = false) {
    if (this.closed) throw error('EBADF', 'Filesystem capability is closed');
    const within = physical ? containsCanonical : contains;
    if (!within(this.root, path) || this.denied.some(d => within(d, path))) throw error('EACCES', 'Path is outside the authorized folders');
  }
  async authorize(input: string, intent: 'existing' | 'create' = 'existing') {
    const resolved = await canonicalize(input, intent); this.check(resolved, true); return resolved;
  }
  /** Pin every existing lexical and physical parent: junctions cannot be swapped
   * between authorization and I/O. Final reads additionally verify the open handle. */
  private async withPath<T>(input: string, intent: 'existing' | 'create', work: (path: string) => Promise<T>): Promise<T> {
    const leases: NativeFile[] = [];
    const pinParents = async (path: string, allowReparse: boolean) => {
      const parents: string[] = [];
      for (let d = p.dirname(path); contains(this.root, d); d = p.dirname(d)) { parents.unshift(d); if (d.toLowerCase() === this.root.toLowerCase()) break; }
      for (const d of parents) {
        try { leases.push(new NativeFile(d, true, allowReparse)); }
        catch (e: any) { if (intent === 'create' && e.code === 'ENOENT') break; throw e; }
      }
    };
    try {
      const lexical = normalize(input); this.check(lexical);
      await pinParents(lexical, true);
      const resolved = await this.authorize(lexical, intent);
      await pinParents(resolved, false);
      if ((await canonicalize(lexical, intent)).toLowerCase() !== resolved.toLowerCase()) throw error('EACCES', 'Path changed during authorization');
      return await work(resolved);
    } finally { for (const lease of leases.reverse()) lease.close(); }
  }
  async read(input: string, max = 700 * 1024, observation = false): Promise<Buffer> {
    if (!Number.isSafeInteger(max) || max < 0 || max > 64 * 1024 * 1024) throw error('EINVAL', 'Read limit must be 0..64 MiB');
    return retry(() => this.withPath(input, 'existing', path => this.withParent(path, async (parent, name) => {
      // Observers permit write/delete sharing instead of explicitly denying
      // editors' writes. Windows replacement may still require bounded retries.
      // The no-follow relative open and handle path check remain unchanged.
      const file = parent.child(name, false, false, false, observation ? 7 : 1);
      try { return file.read(this.root, max); } finally { file.close(); }
    })));
  }
  private async withParent<T>(path: string, work: (parent: NativeFile, name: string) => Promise<T>): Promise<T> {
    const relative = p.relative(this.root, path); this.check(path, true);
    const parts = relative.split('\\').filter(Boolean), name = parts.pop();
    if (!name) throw error('EACCES', 'Operation needs a child of the authorized root');
    const leases: NativeFile[] = []; let parent = this.rootLease;
    try {
      for (const part of parts) { parent = parent.child(part, true); leases.push(parent); }
      this.check(parent.finalPath(), true);
      return await work(parent, name);
    } finally { for (const lease of leases.reverse()) lease.close(); }
  }
  async write(input: string, content: string | Uint8Array, onRetry?: (attempt: number, cause: unknown) => void) {
    return retry(() => this.withPath(input, 'create', async path => {
      const entry = await lstat(path).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
      if (entry && !entry.isFile()) throw error('EINVAL', 'Write requires a regular file');
      return this.withParent(path, async (parent, name) => {
        const file = parent.child(`.coderail-${crypto.randomUUID()}.tmp`, false, true, true);
        try {
          file.write(typeof content === 'string' ? Buffer.from(content, 'utf8') : content);
          file.renameTo(parent, name, true);
        } catch (e) { file.unlink(); throw e; }
        finally { file.close(); }
        return path;
      });
    }), onRetry);
  }
  async mkdir(input: string) {
    return this.withPath(input, 'create', async path => {
      const parts = p.relative(this.root, path).split('\\').filter(Boolean);
      const leases: NativeFile[] = []; let parent = this.rootLease;
      try {
        for (const part of parts) {
          try { parent = parent.child(part, true); }
          catch (e: any) { if (e.code !== 'ENOENT') throw e; parent = parent.child(part, true, true); }
          leases.push(parent); this.check(parent.finalPath(), true);
        }
        return await this.authorize(path);
      } finally { for (const lease of leases.reverse()) lease.close(); }
    });
  }
  async list(input: string) {
    return this.withPath(input, 'existing', async path => {
      if (path.toLowerCase() === this.root.toLowerCase()) { this.check(this.rootLease.finalPath()); return this.rootLease.entries(); }
      return this.withParent(path, async (parent, name) => {
        const directory = parent.child(name, true);
        try { this.check(directory.finalPath()); return directory.entries(); } finally { directory.close(); }
      });
    });
  }
  async stat(input:string) {
    return this.withPath(input,'existing',async path=>{
      if(path.toLowerCase()===this.root.toLowerCase())return this.rootLease.details();
      return this.withParent(path,async(parent,name)=>{
        // authorize() already returned native realpath spelling. Unicode folding
        // can merge two different directory entries on Windows.
        const entry=parent.entries().find(e=>e.name===name);
        if(!entry)throw error('ENOENT','File no longer exists');
        return{kind:entry.isSymbolicLink()?'link' as const:entry.isDirectory()?'dir' as const:'file' as const,size:Number(entry.size),mtime:Number(entry.mtimeNs/1000000n)};
      });
    });
  }
  async move(from: string, to: string) {
    return retry(() => this.withPath(from, 'existing', source => this.withPath(to, 'create', async target => {
      if (source.toLowerCase() === this.root.toLowerCase()) throw error('EACCES', 'Cannot move the authorized root');
      const present = await lstat(target).catch((e: any) => { if (e.code === 'ENOENT') return null; throw e; });
      if (present) throw error('EEXIST', 'Destination exists');
      const entry = await lstat(source);
      return this.withParent(source, (sourceParent, sourceName) => this.withParent(target, async (targetParent, targetName) => {
        const file = sourceParent.child(sourceName, entry.isDirectory(), false, true);
        try { file.renameTo(targetParent, targetName, false); return target; } finally { file.close(); }
      }));
    })));
  }
  async recycle(input: string, send: (path: string) => Promise<void>) {
    return retry(() => this.withPath(input, 'existing', async path => {
      if (path.toLowerCase() === this.root.toLowerCase()) throw error('EACCES', 'Cannot recycle the authorized root');
      await send(path); return path;
    }));
  }
  close() { this.closed = true; this.rootLease.close(); }
}
