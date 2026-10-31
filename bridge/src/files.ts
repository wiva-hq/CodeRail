// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type Caller, type DirEntry, ERR, type FileContent } from '@coderail/protocol';
import { access, appendFile, lstat, mkdir, open, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { HOME, RpcError, STATE_DIR } from './env';
import { callerFolders, checkPath, checkWrite } from './scope';

const MAX_ENTRIES = 5000;
const READ_MAX = 700 * 1024;
/** fs.chunk's most bytes per answer (base64 in one JSON frame). */
const CHUNK_MAX = 1024 * 1024;

/** Whether something is there, off the main thread (a protected folder can hold the call; see guarded). */
const exists = (p: string) => access(p).then(() => true, () => false);

export async function home(caller: Caller) {
  return { home: HOME, roots: await callerFolders(caller) ?? [HOME] };
}

async function entry(path: string): Promise<DirEntry> {
  const l = await lstat(path);
  let kind: DirEntry['kind'] = l.isDirectory() ? 'dir' : 'file';
  let size = l.size;
  let mtime = l.mtimeMs;
  if (l.isSymbolicLink()) {
    try {
      const s = await stat(path);
      kind = s.isDirectory() ? 'dir' : 'file';
      size = s.size;
      mtime = s.mtimeMs;
    } catch {
      kind = 'link';
    }
  }
  return { name: basename(path), path, kind, size, mtime: Math.round(mtime) };
}

export async function list(p: { path: string; hidden?: boolean }, caller: Caller) {
  const path = await checkPath(p.path, caller);
  let names: string[];
  try {
    names = await readdir(path);
  } catch (e: any) {
    throw new RpcError(e.code === 'ENOENT' ? ERR.notFound : e.code === 'EACCES' || e.code === 'EPERM' ? ERR.forbidden : ERR.internal, e.message);
  }
  if (!p.hidden) names = names.filter((n) => !n.startsWith('.'));
  const truncated = names.length > MAX_ENTRIES;
  const entries = (await Promise.all(names.slice(0, MAX_ENTRIES).map((n) => entry(join(path, n)).catch(() => null)))).filter(Boolean) as DirEntry[];
  entries.sort((a, b) => (a.kind === 'dir') !== (b.kind === 'dir') ? (a.kind === 'dir' ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  let parent: string | null = dirname(path);
  if (parent === path) parent = null;
  else {
    try {
      await checkPath(parent, caller);
    } catch {
      parent = null;
    }
  }
  return { path, parent, entries, truncated };
}

export async function read(p: { path: string; max?: number }, caller: Caller): Promise<FileContent> {
  const path = await checkPath(p.path, caller);
  const f = Bun.file(path);
  let s;
  try {
    s = await stat(path);
  } catch {
    throw new RpcError(ERR.notFound, 'No such file');
  }
  if (s.isDirectory()) throw new RpcError(ERR.invalid, 'That is a folder');
  const max = Math.min(Math.max(Number(p.max) || READ_MAX, 1), READ_MAX);
  const bytes = new Uint8Array(await f.slice(0, max).arrayBuffer());
  const mime = mimeOf(path);
  const text = !mime.startsWith('image/') && !mime.startsWith('audio/') && !mime.startsWith('video/') && mime !== 'application/pdf' && isText(bytes);
  return {
    path,
    size: s.size,
    mtime: Math.round(s.mtimeMs),
    mime: text && mime === 'application/octet-stream' ? 'text/plain' : mime,
    encoding: text ? 'utf8' : 'base64',
    content: text ? new TextDecoder().decode(bytes) : Buffer.from(bytes).toString('base64'),
    truncated: s.size > max,
  };
}

/**
 * Bytes of a file (or of a folder's zip from fs.zip), for downloads: the server's /files and /zip routes stream a
 * file by these, a Range at a time. length 0 answers only its size.
 */
export async function chunk(p: { path?: string; zip?: string; offset?: number; length?: number }, caller: Caller) {
  let path: string;
  if (p.zip) {
    const z = zips.get(String(p.zip));
    if (!z || z.userId !== caller.userId) throw new RpcError(ERR.notFound, 'That download is gone; start it again');
    path = z.path;
  } else {
    path = await checkPath(p.path, caller);
  }
  let s;
  try {
    s = await stat(path);
  } catch {
    throw new RpcError(ERR.notFound, 'No such file');
  }
  if (s.isDirectory()) throw new RpcError(ERR.invalid, 'That is a folder');
  const offset = Math.max(0, Math.floor(Number(p.offset) || 0));
  const length = Math.min(Math.max(0, Math.floor(Number(p.length) || 0)), CHUNK_MAX, Math.max(0, s.size - offset));
  let data = '';
  if (length > 0) {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(length);
      const { bytesRead } = await fh.read(buf, 0, length, offset);
      data = buf.subarray(0, bytesRead).toString('base64');
    } finally {
      await fh.close();
    }
  }
  return { size: s.size, mtime: Math.round(s.mtimeMs), mime: p.zip ? 'application/zip' : mimeOf(path), data };
}

/** append: add to the end (an upload in parts; the first part writes it new). */
export async function write(p: { path: string; content: string; encoding?: 'utf8' | 'base64'; append?: boolean }, caller: Caller) {
  const path = await checkWrite(p.path, caller);
  if (typeof p.content !== 'string') throw new RpcError(ERR.invalid, 'No content');
  if (!await exists(dirname(path))) throw new RpcError(ERR.notFound, 'The folder does not exist');
  const data = p.encoding === 'base64' ? Buffer.from(p.content, 'base64') : p.content;
  if (p.append) await appendFile(path, data);
  else await writeFile(path, data);
  return entry(path);
}

// ---- A folder as a .zip, for its download

/** Zips made and not yet read to the end, by id: in the system's temp folder, gone after a while. */
const zips = new Map<string, { path: string; userId: string; timer: ReturnType<typeof setTimeout> }>();
const ZIP_DIR = join(tmpdir(), 'coderail-zips');
const ZIP_KEEP = 15 * 60_000;
const ZIP_FILES = 50_000;
// (fflate writes no ZIP64: an archive stays under 4 GB.)
const ZIP_BYTES = 3.5 * 1024 ** 3;
/** Kinds already compressed: stored as they are, not deflated again. */
const PACKED = /\.(zip|gz|tgz|bz2|xz|zst|7z|rar|jar|png|jpe?g|gif|webp|avif|heic|mp4|mov|m4v|webm|mkv|mp3|m4a|aac|ogg|opus|flac|woff2?|pdf|docx|xlsx|pptx)$/i;

/** The folder zipped: {zip, name, size}; its bytes are read with chunk({zip}). Links are left out (they could
 *  point anywhere), and so is CodeRail's own folder. */
export async function zipFolder(p: { path: string }, caller: Caller) {
  const root = await checkPath(p.path, caller);
  if (!(await stat(root)).isDirectory()) throw new RpcError(ERR.invalid, 'That is not a folder');
  // (Zips take the computer's disk: two made at a time, and a person keeps their last three.)
  if (making >= 2) throw new RpcError(ERR.invalid, 'Another folder is being zipped; try again in a moment');
  making++;
  try {
    return await makeZip(root, caller);
  } finally {
    making--;
  }
}

let making = 0;

async function makeZip(root: string, caller: Caller) {
  const state = STATE_DIR;
  const list: { abs: string; rel: string; size: number; mtime: number }[] = [];
  const dirs: string[] = [];
  let total = 0;
  const walk = async (dir: string, rel: string) => {
    let names: string[];
    try { names = await readdir(dir); } catch { return; }
    for (const n of names) {
      const abs = join(dir, n);
      if (abs === state || abs.startsWith(state + '/')) continue;
      const l = await lstat(abs).catch(() => null);
      if (!l || l.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${n}` : n;
      if (l.isDirectory()) {
        dirs.push(r);
        await walk(abs, r);
      } else if (l.isFile()) {
        list.push({ abs, rel: r, size: l.size, mtime: l.mtimeMs });
        total += l.size;
        if (list.length > ZIP_FILES) throw new RpcError(ERR.invalid, `Too many files to zip (over ${ZIP_FILES.toLocaleString('en-US')})`);
        if (total > ZIP_BYTES) throw new RpcError(ERR.invalid, 'Too large to zip here (over 3.5 GB)');
      }
    }
  };
  await walk(root, '');
  await mkdir(ZIP_DIR, { recursive: true, mode: 0o700 });
  await sweepZips();
  const mine = [...zips.entries()].filter(([, z]) => z.userId === caller.userId);
  for (const [id] of mine.slice(0, Math.max(0, mine.length - 2))) await dropZip(id);
  const id = crypto.randomUUID();
  const out = join(ZIP_DIR, `${id}.zip`);
  const sink = Bun.file(out).writer();
  const top = basename(root) || 'folder';
  let failed: Error | null = null;
  const done = new Promise<void>((resolve, reject) => {
    const zip = new Zip((err, data, final) => {
      if (err) { failed = err; return reject(err); }
      sink.write(data);
      if (final) resolve();
    });
    (async () => {
      for (const d of dirs) {
        const e = new ZipPassThrough(`${top}/${d}/`);
        zip.add(e);
        e.push(new Uint8Array(0), true);
      }
      for (const f of list) {
        if (failed) return;
        const e = PACKED.test(f.rel) ? new ZipPassThrough(`${top}/${f.rel}`) : new ZipDeflate(`${top}/${f.rel}`, { level: 6 });
        e.mtime = f.mtime;
        zip.add(e);
        try {
          const reader = Bun.file(f.abs).stream().getReader();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            e.push(value, false);
            await sink.flush();
          }
        } catch {
          // (A file that can't be read (gone, locked): left empty rather than failing the whole folder.)
        }
        e.push(new Uint8Array(0), true);
      }
      zip.end();
    })().catch(reject);
  });
  try {
    await done;
    await sink.end();
  } catch (e: any) {
    await Promise.resolve(sink.end()).catch(() => {});
    await rm(out, { force: true });
    throw new RpcError(ERR.internal, `Could not zip the folder: ${e?.message ?? e}`);
  }
  const timer = setTimeout(() => void dropZip(id), ZIP_KEEP);
  zips.set(id, { path: out, userId: caller.userId, timer });
  return { zip: id, name: `${top}.zip`, size: (await stat(out)).size };
}

async function dropZip(id: string) {
  const z = zips.get(id);
  if (!z) return;
  clearTimeout(z.timer);
  zips.delete(id);
  await rm(z.path, { force: true });
}

/** Zips left by an earlier run of the bridge, or older than they're kept. */
async function sweepZips() {
  const known = new Set([...zips.values()].map((z) => z.path));
  for (const n of await readdir(ZIP_DIR).catch(() => [] as string[])) {
    const f = join(ZIP_DIR, n);
    if (known.has(f)) continue;
    const s = await stat(f).catch(() => null);
    if (s && Date.now() - s.mtimeMs > ZIP_KEEP) await rm(f, { force: true });
  }
}

export async function makeDir(p: { path: string }, caller: Caller) {
  const path = await checkWrite(p.path, caller);
  await mkdir(path, { recursive: true });
  return entry(path);
}

export async function renamePath(p: { from: string; to: string }, caller: Caller) {
  const from = await checkWrite(p.from, caller);
  const to = await checkWrite(p.to, caller);
  if (await exists(to)) throw new RpcError(ERR.invalid, 'Something already has that name');
  await rename(from, to);
  return entry(to);
}

/** Into the system's trash, never deleted outright. */
export async function trash(p: { path: string }, caller: Caller) {
  const path = await checkPath(p.path, caller);
  if (!await exists(path)) throw new RpcError(ERR.notFound, 'No such file');
  const dir = process.platform === 'darwin' ? join(HOME, '.Trash') : join(HOME, '.local/share/Trash/files');
  await mkdir(dir, { recursive: true });
  let target = join(dir, basename(path));
  for (let i = 2; await exists(target); i++) {
    const ext = extname(path);
    target = join(dir, `${basename(path, ext)} ${i}${ext}`);
  }
  await rename(path, target);
  return { ok: true, trashed: target };
}

function isText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return false;
  return true;
}

/** By extension: what a browser is told a file is. Text kinds not here are found by their bytes (isText). */
const MIME: Record<string, string> = {
  // pictures
  '.png': 'image/png', '.apng': 'image/apng', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.pjpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.cur': 'image/x-icon',
  '.svg': 'image/svg+xml', '.svgz': 'image/svg+xml', '.tif': 'image/tiff', '.tiff': 'image/tiff', '.heic': 'image/heic', '.heif': 'image/heif',
  '.jxl': 'image/jxl', '.psd': 'image/vnd.adobe.photoshop', '.icns': 'image/icns',
  // video and sound
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.ogv': 'video/ogg',
  '.avi': 'video/x-msvideo', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg', '.3gp': 'video/3gpp', '.m2ts': 'video/mp2t',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.mid': 'audio/midi', '.midi': 'audio/midi', '.weba': 'audio/webm',
  // documents
  '.pdf': 'application/pdf', '.rtf': 'application/rtf', '.epub': 'application/epub+zip',
  '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text', '.ods': 'application/vnd.oasis.opendocument.spreadsheet', '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.pages': 'application/vnd.apple.pages', '.numbers': 'application/vnd.apple.numbers', '.key': 'application/vnd.apple.keynote',
  // fonts
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.woff': 'font/woff', '.woff2': 'font/woff2',
  // archives
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tgz': 'application/gzip', '.tar': 'application/x-tar', '.bz2': 'application/x-bzip2',
  '.xz': 'application/x-xz', '.zst': 'application/zstd', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  '.jar': 'application/java-archive', '.dmg': 'application/x-apple-diskimage', '.iso': 'application/x-iso9660-image',
  '.wasm': 'application/wasm', '.sqlite': 'application/vnd.sqlite3', '.db': 'application/vnd.sqlite3',
  // text and code
  '.md': 'text/markdown', '.markdown': 'text/markdown', '.mdx': 'text/markdown', '.txt': 'text/plain', '.log': 'text/plain',
  '.csv': 'text/csv', '.tsv': 'text/tab-separated-values', '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml',
  '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.jsx': 'text/javascript',
  '.tsx': 'text/typescript', '.mts': 'text/typescript', '.cts': 'text/typescript', '.json': 'application/json', '.jsonc': 'application/json',
  '.ipynb': 'application/x-ipynb+json', '.yaml': 'text/yaml', '.yml': 'text/yaml', '.toml': 'text/plain', '.ini': 'text/plain',
  '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go', '.rs': 'text/x-rust', '.java': 'text/x-java', '.kt': 'text/x-kotlin',
  '.swift': 'text/x-swift', '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++', '.cs': 'text/x-csharp',
  '.php': 'text/x-php', '.sh': 'text/x-shellscript', '.zsh': 'text/x-shellscript', '.bash': 'text/x-shellscript', '.sql': 'text/x-sql',
  '.svelte': 'text/plain', '.vue': 'text/plain', '.lua': 'text/x-lua', '.r': 'text/x-r', '.dart': 'text/x-dart', '.ex': 'text/plain',
};

export function mimeOf(path: string): string {
  // (.ts: TypeScript, far more often than a video stream in a code folder.)
  const ext = extname(path).toLowerCase();
  return ext === '.ts' ? 'text/typescript' : MIME[ext] ?? 'application/octet-stream';
}
