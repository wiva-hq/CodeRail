// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A computer's files beyond fs.read: their address for the browser's own viewers (GET /api/machines/<id>/files,
// which streams them by Range: a video seeks, a PDF opens), downloads (a folder as a .zip, made on the computer),
// uploads in parts over fs.write, and what kind a file is, for which viewer shows it.
import type { MachineConn } from './machine.svelte';
import { b64 } from './b64';
import { join } from './machineText';

/** The file's bytes over HTTP, as the page's own viewers and downloads read them. */
export function fileUrl(machineId: string, path: string, download = false) {
  return `/api/machines/${encodeURIComponent(machineId)}/files?path=${encodeURIComponent(path)}${download ? '&download=1' : ''}`;
}

/** Saves what a URL answers, as the browser saves a link (its own progress, no copy in memory). */
function save(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
}

/** A file to this device. Asked first, so a file that's gone says so instead of saving an error as a file. */
export async function downloadFile(machineId: string, path: string) {
  const r = await fetch(fileUrl(machineId, path), { method: 'HEAD', credentials: 'same-origin' });
  if (!r.ok) throw new Error(r.status === 404 ? 'That file is gone' : r.status === 403 ? 'That file is outside your folders' : r.status === 503 ? 'The computer is offline' : `Could not download it (${r.status})`);
  save(fileUrl(machineId, path, true));
}

/** A folder to this device, zipped on the computer first (this waits for that). */
export async function downloadFolder(machineId: string, path: string) {
  const r = await fetch(`/api/machines/${encodeURIComponent(machineId)}/zip`, {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path }),
  });
  const z = await r.json().catch(() => null);
  if (!r.ok || !z?.zip) throw new Error(z?.error ?? `Could not zip it (${r.status})`);
  save(`/api/machines/${encodeURIComponent(machineId)}/zip/${encodeURIComponent(z.zip)}?name=${encodeURIComponent(z.name)}`);
  return z as { zip: string; name: string; size: number };
}

// ---- Uploads

const PART = 512 * 1024;

export type Upload = { id: number; name: string; dir: string; size: number; sent: number; error?: string; cancel: boolean };
let nextId = 1;

/** A name not taken in the folder: "name 2.ext", "name 3.ext"… as the Trash names them. */
function freeName(taken: Set<string>, name: string) {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
  for (let i = 2; ; i++) if (!taken.has(`${stem} ${i}${ext}`)) return `${stem} ${i}${ext}`;
}

export function newUpload(file: File, dir: string): Upload {
  return { id: nextId++, name: file.name, dir, size: file.size, sent: 0, cancel: false };
}

/**
 * One file into a folder on the computer: written in parts to a hidden name beside it, then given its name (one
 * that's free: nothing there is replaced). `u` is updated as it goes; set u.cancel to stop it. → the path.
 */
export async function upload(conn: MachineConn, file: File, u: Upload, changed: () => void): Promise<string> {
  const tmp = join(u.dir, `.${u.name}.${u.id}.uploading`);
  try {
    for (let at = 0; at < file.size || at === 0; at += PART) {
      if (u.cancel) throw new Error('Cancelled');
      const bytes = new Uint8Array(await file.slice(at, at + PART).arrayBuffer());
      await conn.call('fs.write', { path: tmp, content: b64(bytes), encoding: 'base64', append: at > 0 }, 120_000);
      u.sent = Math.min(file.size, at + bytes.length);
      changed();
      if (!file.size) break;
    }
    // (Named last, after the folder is read again: a file with that name may have come meanwhile.)
    for (let tries = 0; ; tries++) {
      const l = await conn.call<{ entries: { name: string }[] }>('fs.list', { path: u.dir, hidden: true });
      const name = freeName(new Set(l.entries.map((e) => e.name)), u.name);
      try {
        await conn.call('fs.rename', { from: tmp, to: join(u.dir, name) });
        return join(u.dir, name);
      } catch (e) {
        if (tries >= 3) throw e;
      }
    }
  } catch (e) {
    // (A part written stays out of sight; it goes to the Trash, where it can still be found.)
    await conn.call('fs.trash', { path: tmp }).catch(() => {});
    throw e;
  }
}

// ---- What a file is, for its viewer

export type Kind =
  | 'image' | 'svg' | 'video' | 'audio' | 'pdf' | 'markdown' | 'html' | 'table' | 'json' | 'notebook' | 'font'
  | 'docx' | 'sheet' | 'zip' | 'text' | 'unknown';

const BY_EXT: Record<string, Kind> = {
  png: 'image', apng: 'image', jpg: 'image', jpeg: 'image', jfif: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image',
  ico: 'image', cur: 'image', tif: 'image', tiff: 'image', heic: 'image', heif: 'image', jxl: 'image',
  svg: 'svg',
  mp4: 'video', m4v: 'video', mov: 'video', webm: 'video', ogv: 'video', mkv: 'video',
  mp3: 'audio', wav: 'audio', m4a: 'audio', aac: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', flac: 'audio', weba: 'audio', aif: 'audio', aiff: 'audio',
  pdf: 'pdf',
  md: 'markdown', markdown: 'markdown', mdx: 'markdown',
  html: 'html', htm: 'html',
  csv: 'table', tsv: 'table',
  json: 'json', jsonc: 'json', geojson: 'json', webmanifest: 'json',
  ipynb: 'notebook',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  docx: 'docx',
  xlsx: 'sheet', xlsm: 'sheet', xls: 'sheet', ods: 'sheet', numbers: 'unknown',
  zip: 'zip', jar: 'zip', epub: 'zip', pptx: 'zip',
};

/** By name first; a name it doesn't know is text when its first bytes are (the bridge tells: encoding utf8). */
export function kindOf(path: string): Kind {
  const ext = extOf(path);
  return BY_EXT[ext] ?? 'unknown';
}

export function extOf(path: string) {
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : name.toLowerCase();
}

/** Kinds read by URL (any size, streamed) rather than as fs.read's text. */
export const BY_URL = new Set<Kind>(['image', 'video', 'audio', 'pdf', 'font', 'docx', 'sheet', 'zip']);

/** CSV or TSV rows, quotes understood. At most `max` rows. */
export function parseDelimited(text: string, sep: string, max = 5000): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
      } else cell += c;
    } else if (c === '"' && cell === '') q = true;
    else if (c === sep) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      rows.push(row); row = [];
      if (rows.length >= max) return rows;
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
