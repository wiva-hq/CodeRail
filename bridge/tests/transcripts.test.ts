// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { afterAll, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appended, forkTail, forksOf, hungOff, mirrored, sizeOf, tipOf, transcriptPath, uuidsOf } from '../src/transcripts';

const dir = mkdtempSync(join(tmpdir(), 'coderail-transcripts-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const line = (o: any) => JSON.stringify(o) + '\n';
const user = (uuid: string, text = 'hi') => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'text', text }] } });
const assistant = (uuid: string, id: string, stop: string | null) => line({ type: 'assistant', uuid, message: { id, role: 'assistant', stop_reason: stop, content: [{ type: 'text', text: 'ok' }] } });

describe('transcriptPath', () => {
  test('finds the file under the cwd folder name, and by search when that name was shortened', () => {
    const root = join(dir, 'cfg');
    mkdirSync(join(root, 'projects', 'E--Citrus-Cafe-Wiva'), { recursive: true });
    writeFileSync(join(root, 'projects', 'E--Citrus-Cafe-Wiva', 's1.jsonl'), '');
    expect(transcriptPath(root, 'E:\\Citrus Cafe\\Wiva', 's1')).toBe(join(root, 'projects', 'E--Citrus-Cafe-Wiva', 's1.jsonl'));
    mkdirSync(join(root, 'projects', 'shortened-abc123'), { recursive: true });
    writeFileSync(join(root, 'projects', 'shortened-abc123', 's2.jsonl'), '');
    expect(transcriptPath(root, '/some/very/long/path', 's2')).toBe(join(root, 'projects', 'shortened-abc123', 's2.jsonl'));
    expect(transcriptPath(root, '/x', 'missing')).toBeNull();
  });
});

describe('appended', () => {
  test('ids of the new messages, whether the turn ended, and only whole lines', () => {
    const f = join(dir, 't.jsonl');
    writeFileSync(f, user('u1') + assistant('a1', 'msg_1', 'end_turn'));
    const mark = sizeOf(f);
    appendFileSync(f, line({ type: 'last-prompt' }) + user('u2') + assistant('a2', 'msg_2', 'tool_use'));
    let a = appended(f, mark);
    expect([...a.ids].sort()).toEqual(['a2', 'msg_2', 'u2']);
    expect(a.turnDone).toBe(false);
    expect(a.end).toBe(sizeOf(f));

    const mid = sizeOf(f);
    appendFileSync(f, user('u3', 'tool result') + assistant('a3', 'msg_3', 'end_turn') + line({ type: 'ai-title' }) + '{"type":"user","uu');
    a = appended(f, mid);
    expect(a.turnDone).toBe(true);
    expect(a.ids.has('msg_3')).toBe(true);
    expect(a.end).toBe(sizeOf(f) - '{"type":"user","uu'.length);
  });

  test('nothing new, and a line still being written', () => {
    const f = join(dir, 'p.jsonl');
    writeFileSync(f, user('u1'));
    expect(appended(f, sizeOf(f))).toEqual({ end: sizeOf(f), ids: new Set(), turnDone: false });
    const mark = sizeOf(f);
    appendFileSync(f, '{"partial');
    expect(appended(f, mark).end).toBe(mark);
  });
});

describe('forks', () => {
  test("a fork's new turn goes back to the session with its id, once, and other sessions are no forks", () => {
    const d = join(dir, 'forks');
    mkdirSync(d, { recursive: true });
    const s = join(d, 'S.jsonl');
    const as = (o: string, sid: string, parent: string | null = null) => o.replace(/"type"/, `"sessionId":"${sid}","parentUuid":${JSON.stringify(parent)},"type"`);
    writeFileSync(s, as(user('u1'), 'S') + as(assistant('a1', 'msg_1', 'end_turn'), 'S', 'u1'));
    const since = Date.now() - 60_000;
    const f = join(d, 'F.jsonl');
    writeFileSync(f, as(user('u1'), 'S') + as(assistant('a1', 'msg_1', 'end_turn'), 'S', 'u1') + line({ type: 'custom-title', sessionId: 'F' })
      + as(user('u2', 'from the app'), 'F', 'a1'));
    writeFileSync(join(d, 'other.jsonl'), as(user('x1'), 'X'));
    expect(forksOf(s, 'S', since)).toEqual([f]);
    expect(forksOf(s, 'S', Date.now() + 60_000)).toEqual([]);

    let t = forkTail(f, uuidsOf(s), 'S');
    expect(t.uuids).toEqual(['u2']);
    expect(t.turnDone).toBe(false);
    appendFileSync(f, as(assistant('a2', 'msg_2', 'end_turn'), 'F', 'u2') + '{"partial');
    t = forkTail(f, uuidsOf(s), 'S');
    expect(t.uuids).toEqual(['u2', 'a2']);
    expect(t.turnDone).toBe(true);
    expect(t.lines.every((l) => JSON.parse(l).sessionId === 'S')).toBe(true);
    appendFileSync(s, t.lines.join('\n') + '\n');
    expect(forkTail(f, uuidsOf(s), 'S').lines).toEqual([]);
  });
});

describe('tipOf and a fork from an earlier point', () => {
  test("the fork's parent is the session's tip only while the session has not gone on", () => {
    const d = join(dir, 'tip');
    mkdirSync(d, { recursive: true });
    const s = join(d, 'S.jsonl');
    const chain = (o: string, parent: string | null) => o.replace(/"type"/, `"parentUuid":${JSON.stringify(parent)},"type"`);
    writeFileSync(s, chain(user('u1'), null) + chain(assistant('a1', 'msg_1', 'end_turn'), 'u1') + line({ type: 'ai-title' }));
    expect(tipOf(s)).toBe('a1');
    const f = join(d, 'F.jsonl');
    writeFileSync(f, chain(user('u1'), null) + chain(assistant('a1', 'msg_1', 'end_turn'), 'u1') + chain(user('u2'), 'a1') + chain(assistant('a2', 'msg_2', 'end_turn'), 'u2'));
    expect(forkTail(f, uuidsOf(s), 'S').parent).toBe(tipOf(s));
    appendFileSync(s, chain(user('c1'), 'a1') + chain(assistant('c2', 'msg_3', 'end_turn'), 'c1'));
    expect(forkTail(f, uuidsOf(s), 'S').parent).not.toBe(tipOf(s));
  });
});

describe('forkTail and branches left behind', () => {
  test('takes only the chain back from the last message, not an older branch the file also holds', () => {
    const d = join(dir, 'branches');
    mkdirSync(d, { recursive: true });
    const chain = (o: string, parent: string | null) => o.replace(/"type"/, `"parentUuid":${JSON.stringify(parent)},"type"`);
    const s = join(d, 'S.jsonl');
    // a1 is shared; x1/x2 is a branch left behind; u2/a2 hang off a1 and are where the conversation goes on.
    writeFileSync(s, chain(user('u1'), null) + chain(assistant('a1', 'msg_1', 'end_turn'), 'u1')
      + chain(user('x1'), 'a1') + chain(assistant('x2', 'msg_x', 'end_turn'), 'x1')
      + chain(user('u2', 'go on'), 'a1') + chain(assistant('a2', 'msg_2', 'end_turn'), 'u2'));
    const f = join(d, 'F.jsonl');
    writeFileSync(f, chain(user('u1'), null) + chain(assistant('a1', 'msg_1', 'end_turn'), 'u1'));
    const t = forkTail(s, uuidsOf(f), 'F');
    expect(t.uuids).toEqual(['u2', 'a2']);
    expect(t.parent).toBe(tipOf(f));
    expect(JSON.parse(t.lastPrompt!)).toMatchObject({ type: 'last-prompt', leafUuid: 'u2', sessionId: 'F' });
  });
});

describe('both went on from the same message', () => {
  test("the fork's turns go after the session's, and the fork is made the session's conversation", () => {
    const d = join(dir, 'diverged');
    mkdirSync(d, { recursive: true });
    const chain = (o: string, parent: string | null) => o.replace(/"type"/, `"parentUuid":${JSON.stringify(parent)},"type"`);
    const shared = chain(user('u1'), null) + chain(assistant('a1', 'msg_1', 'end_turn'), 'u1');
    const s = join(d, 'S.jsonl');
    const f = join(d, 'F.jsonl');
    // CodeRail went on with w1/w2, the app (not having loaded them) with p1/p2, both from a1.
    writeFileSync(s, shared + chain(user('w1', 'from the web'), 'a1') + chain(assistant('w2', 'msg_w', 'end_turn'), 'w1'));
    writeFileSync(f, shared + line({ type: 'custom-title', sessionId: 'F' }) + chain(user('p1', 'from the app'), 'a1') + chain(assistant('p2', 'msg_p', 'end_turn'), 'p1'));

    const t = forkTail(f, uuidsOf(s), 'S');
    expect(t.parent).toBe('a1');
    appendFileSync(s, [...hungOff(t, tipOf(s)), t.lastPrompt!].join('\n') + '\n');
    const sLines = readFileSync(s, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((o) => o.uuid);
    expect(sLines.map((o) => `${o.uuid}<${o.parentUuid}`)).toEqual(['u1<null', 'a1<u1', 'w1<a1', 'w2<w1', 'p1<w2', 'p2<p1']);

    writeFileSync(f, mirrored(f, s, 'F')!);
    const fAll = readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(fAll.filter((o) => o.uuid).map((o) => `${o.uuid}<${o.parentUuid}`)).toEqual(['u1<null', 'a1<u1', 'w1<a1', 'w2<w1', 'p1<w2', 'p2<p1']);
    expect(fAll.every((o) => o.sessionId === undefined || o.sessionId === 'F')).toBe(true);
    expect(fAll.some((o) => o.type === 'custom-title')).toBe(true);
    expect(fAll.at(-1)).toMatchObject({ type: 'last-prompt', leafUuid: 'p1' });
    expect(tipOf(f)).toBe('p2');
    expect(mirrored(f, s, 'F')).toBeNull();
    expect(forkTail(f, uuidsOf(s), 'S').lines).toEqual([]);
  });
});
