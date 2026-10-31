// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A computer's files over plain HTTP, for the browser's own viewers and downloads. GET /api/machines/<id>/files
// streams one by the bridge's fs.chunk, a few parts ahead, and answers Range requests (a video seeks, a PDF opens);
// POST /zip zips a folder on the computer and GET /zip/<id> streams that the same way. The caller's scope goes to
// the bridge exactly as a socket call's would, so its folder checks apply. These bytes come from the app's own
// address: nothing in them may run there (see headers()).
import { type Caller, ERR } from '@coderail/protocol';
import type { Machine } from './machine';
import { HttpError, json } from './util';

const PART = 512 * 1024;
const AHEAD = 4;
const ZIP_TIMEOUT = 10 * 60_000;

/** Shown in the page only when a browser draws it without running anything in it; the rest is saved. */
const INLINE = /^(image\/(png|apng|jpeg|gif|webp|avif|bmp|x-icon|tiff|heic|heif|jxl)|video\/|audio\/|application\/pdf$|font\/)/;

type Part = { size: number; mtime: number; mime: string; data: string };

export async function fileRoute(req: Request, m: Machine, caller: Caller, url: URL): Promise<Response> {
  const path = url.searchParams.get('path');
  if (!path) throw new HttpError(400, 'A path is needed');
  const download = url.searchParams.has('download');
  if (download) m.record(caller, 'fs.download', { path });
  return stream(req, m, caller, { path }, path.split('/').filter(Boolean).pop() || 'file', download);
}

/** A folder zipped on the computer: {zip, name, size}, then GET /zip/<zip> for its bytes. */
export async function zipStart(m: Machine, caller: Caller, path: unknown): Promise<Response> {
  if (typeof path !== 'string' || !path) throw new HttpError(400, 'A path is needed');
  const r = await m.call('fs.zip', { path }, caller, ZIP_TIMEOUT).catch(httpError);
  m.record(caller, 'fs.zip', { path, size: r.size });
  return json(r);
}

export async function zipRoute(req: Request, m: Machine, caller: Caller, zip: string, url: URL): Promise<Response> {
  const name = (url.searchParams.get('name') || 'folder.zip').slice(0, 200);
  return stream(req, m, caller, { zip }, name, true);
}

async function stream(req: Request, m: Machine, caller: Caller, src: { path?: string; zip?: string }, name: string, download: boolean): Promise<Response> {
  const call = (offset: number, length: number) => m.call('fs.chunk', { ...src, offset, length }, caller).catch(httpError) as Promise<Part>;
  const etagAsked = req.headers.get('if-none-match');
  let range = parseRange(req.headers.get('range'));
  // (A first part read right away, unless only the size is wanted first.)
  const sizeFirst = req.method === 'HEAD' || !!etagAsked || (range && range.start == null);
  const at = range?.start ?? 0;
  const head = await call(at, sizeFirst ? 0 : PART);
  const size = head.size;
  const etag = `"${size.toString(36)}-${Math.round(head.mtime).toString(36)}"`;
  if (etagAsked && etagAsked === etag && !range) return new Response(null, { status: 304, headers: { etag } });
  // (If-Range: a range of the version the browser holds, else the whole file again.)
  const ifRange = req.headers.get('if-range');
  if (range && ifRange && ifRange !== etag) range = null;

  let start = 0;
  let end = size - 1;
  if (range) {
    if (range.start == null) start = Math.max(0, size - (range.suffix ?? 0));
    else {
      start = range.start;
      if (range.end != null) end = Math.min(range.end, size - 1);
    }
    if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
  }
  const length = Math.max(0, end - start + 1);
  const headers = fileHeaders(head.mime, name, download);
  headers.set('content-length', String(length));
  headers.set('etag', etag);
  headers.set('last-modified', new Date(head.mtime).toUTCString());
  const status = range ? 206 : 200;
  if (range) headers.set('content-range', `bytes ${start}-${end}/${size}`);
  if (req.method === 'HEAD' || !length) return new Response(null, { status, headers });

  // (The parts after this one asked for a few at a time, so a slow link to the computer isn't paid once per part.)
  const queue: Promise<Uint8Array>[] = [];
  let next = start;
  if (!sizeFirst && at === start && head.data) {
    const b = Buffer.from(head.data, 'base64');
    queue.push(Promise.resolve(b));
    next = start + b.length;
  }
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      while (queue.length < AHEAD && next <= end) {
        const off = next;
        const want = Math.min(PART, end - off + 1);
        next += want;
        queue.push(call(off, want).then((p) => Buffer.from(p.data, 'base64')));
      }
      const part = queue.shift();
      if (!part) return ctl.close();
      try {
        let b = await part;
        if (!b.length) throw new Error('The file got shorter while it was read');
        if (sent + b.length > length) b = b.subarray(0, length - sent);
        sent += b.length;
        ctl.enqueue(b);
        if (sent >= length) ctl.close();
      } catch (e) {
        ctl.error(e);
      }
    },
  });
  return new Response(body, { status, headers });
}

/** What keeps a computer's file from acting as the app's own page. */
function fileHeaders(mime: string, name: string, download: boolean): Headers {
  const inline = !download && INLINE.test(mime);
  const ascii = name.replace(/[^\x20-\x7e]|["\\%]/g, '_');
  const h = new Headers({
    'content-type': mime || 'application/octet-stream',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-cache',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
    'referrer-policy': 'no-referrer',
    // (Framed only by the app itself; main.ts leaves these as they are.)
    'x-frame-options': 'SAMEORIGIN',
    // (A sandbox: no script, no same-origin, whatever the file is. Chrome won't show a PDF in one, and a PDF can't
    // reach the page's cookies or script either way.)
    'content-security-policy':
      mime === 'application/pdf'
        ? "frame-ancestors 'self'"
        : "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; font-src 'self'; frame-ancestors 'self'",
  });
  return h;
}

/** bytes=a-b, bytes=a-, bytes=-n (one range only; several read as the whole file). */
function parseRange(v: string | null): { start?: number; end?: number; suffix?: number } | null {
  const m = v?.match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  if (!m[1]) return { suffix: Number(m[2]) };
  return { start: Number(m[1]), end: m[2] ? Number(m[2]) : undefined };
}

const STATUS: Record<number, number> = {
  [ERR.notFound]: 404, [ERR.forbidden]: 403, [ERR.invalid]: 400, [ERR.offline]: 503, [ERR.timeout]: 504, [ERR.method]: 501,
};
function httpError(e: any): never {
  throw new HttpError(STATUS[e?.code] ?? 502, e?.message ?? String(e));
}
