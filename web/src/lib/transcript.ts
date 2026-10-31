// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A session's log (LogEntry, kept by the machine's hub on the server) folded into what the transcript draws: a prompt,
// the agent's words (its message chunks merged), its thinking, each tool call (its updates merged in by toolCallId),
// the plan (the latest of a turn, in place), approvals (with their answer), a turn's end, errors and notices.
// Folding is incremental: `add` changes the items array in place, so a streamed word only touches the last item.
import type { Approval, LogEntry } from '@coderail/protocol';

export interface ImagePart { mimeType: string; data: string }
export type Item =
  | { k: 'user'; key: string; at: number; text: string; images: ImagePart[]; by: string | null }
  | { k: 'agent'; key: string; at: number; text: string }
  | { k: 'thought'; key: string; at: number; text: string }
  | { k: 'tool'; key: string; at: number; id: string; title: string; kind: string; status: string; content: any[]; locations: { path: string; line?: number }[]; rawInput?: any; rawOutput?: any }
  | { k: 'plan'; key: string; at: number; entries: { content: string; status: string; priority?: string }[] }
  | { k: 'approval'; key: string; at: number; approval: Approval; answer: { optionId: string | null; by: string | null } | null }
  | { k: 'turn'; key: string; at: number; stopReason: string; usage?: any }
  | { k: 'error'; key: string; at: number; message: string }
  | { k: 'notice'; key: string; at: number; text: string };

/** The text of an ACP content block (or a list of them). */
export function textOf(c: any): string {
  if (!c) return '';
  if (Array.isArray(c)) return c.map(textOf).join('');
  if (typeof c === 'string') return c;
  if (c.type === 'text') return c.text ?? '';
  if (c.type === 'resource_link') return `[${c.name ?? c.uri}](${c.uri})`;
  if (c.type === 'resource') return c.resource?.text ?? '';
  return '';
}

export class Folder {
  private tools = new Map<string, Extract<Item, { k: 'tool' }>>();
  private approvals = new Map<string, Extract<Item, { k: 'approval' }>>();
  /** The plan item of the turn in progress (a new plan replaces it). */
  private plan: Extract<Item, { k: 'plan' }> | null = null;

  constructor(private items: Item[]) {}

  private lastItem() { return this.items[this.items.length - 1]; }
  private push<T extends Item>(it: T): T {
    this.items.push(it);
    // (The array is a reactive proxy: the stored element is its proxied copy.)
    return this.items[this.items.length - 1] as T;
  }

  add(e: LogEntry) {
    const key = `s${e.seq}`, at = e.at;
    const d = e.data ?? {};
    switch (e.kind) {
      case 'user': {
        const prompt: any[] = d.prompt ?? [];
        this.plan = null;
        this.push({ k: 'user', key, at, text: textOf(prompt.filter((b) => b?.type !== 'image')), images: prompt.filter((b) => b?.type === 'image').map((b) => ({ mimeType: b.mimeType, data: b.data })), by: d.by ?? null });
        return;
      }
      case 'update': return this.update(d, key, at);
      case 'approval': {
        const a = d as Approval;
        if (this.approvals.has(a.id)) return;
        this.approvals.set(a.id, this.push({ k: 'approval', key, at, approval: a, answer: null }));
        return;
      }
      case 'answer': {
        const it = this.approvals.get(d.approvalId);
        if (it) it.answer = { optionId: d.optionId ?? null, by: d.by ?? null };
        return;
      }
      case 'turn':
        this.plan = null;
        this.push({ k: 'turn', key, at, stopReason: d.stopReason ?? 'end_turn', usage: d.usage });
        return;
      case 'error': this.push({ k: 'error', key, at, message: d.message ?? 'Error' }); return;
      case 'notice': this.push({ k: 'notice', key, at, text: d.text ?? '' }); return;
    }
  }

  private update(u: any, key: string, at: number) {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk':
      case 'user_message_chunk': {
        const k = u.sessionUpdate === 'agent_message_chunk' ? 'agent' : u.sessionUpdate === 'agent_thought_chunk' ? 'thought' : 'user';
        const last = this.lastItem();
        const t = textOf(u.content);
        const img = u.content?.type === 'image' ? [{ mimeType: u.content.mimeType, data: u.content.data }] : [];
        if (last && last.k === k) {
          if (t) last.text += t;
          if (img.length && last.k === 'user') last.images.push(...img);
          return;
        }
        if (k === 'user') this.push({ k: 'user', key, at, text: t, images: img, by: null });
        else this.push({ k, key, at, text: t } as Item);
        return;
      }
      case 'tool_call': {
        const id = String(u.toolCallId ?? key);
        const existing = this.tools.get(id);
        if (existing) { merge(existing, u); return; }
        const it = this.push({ k: 'tool', key, at, id, title: u.title ?? 'Tool', kind: u.kind ?? 'other', status: u.status ?? 'pending', content: u.content ?? [], locations: u.locations ?? [], rawInput: u.rawInput, rawOutput: u.rawOutput });
        this.tools.set(id, it);
        return;
      }
      case 'tool_call_update': {
        const id = String(u.toolCallId ?? '');
        let it = this.tools.get(id);
        if (!it) {
          it = this.push({ k: 'tool', key, at, id, title: u.title ?? 'Tool', kind: u.kind ?? 'other', status: u.status ?? 'in_progress', content: [], locations: [] });
          this.tools.set(id, it);
        }
        merge(it, u);
        return;
      }
      case 'plan': {
        const entries = (u.entries ?? []).map((x: any) => ({ content: x.content ?? '', status: x.status ?? 'pending', priority: x.priority }));
        if (this.plan) this.plan.entries = entries;
        else this.plan = this.push({ k: 'plan', key, at, entries });
        return;
      }
      case 'current_mode_update':
        this.push({ k: 'notice', key, at, text: `Mode: ${u.currentModeId}` });
        return;
      default:
        return; // (commands, options, usage, info: SessionView's side effects)
    }
  }
}

function merge(it: Extract<Item, { k: 'tool' }>, u: any) {
  if (u.title != null) it.title = u.title;
  if (u.kind != null) it.kind = u.kind;
  if (u.status != null) it.status = u.status;
  if (u.content != null) it.content = u.content;
  if (u.locations != null) it.locations = u.locations;
  if (u.rawInput !== undefined) it.rawInput = u.rawInput;
  if (u.rawOutput !== undefined) it.rawOutput = u.rawOutput;
}

