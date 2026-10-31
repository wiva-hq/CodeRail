// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A machine's pane tree (Forest's, kept per machine): the conversation and the tool cards in horizontal and vertical
// splits with relative sizes; a card is a group of tabs. Kept in localStorage, so a machine opens as it was left. The
// default is the chat on the left and Files on the right.
import { kept, keep } from './kept';

export type Kind = 'files' | 'changes' | 'browser' | 'terminal' | 'background';
export type Side = 'left' | 'right' | 'top' | 'bottom';
/** A tab: `sub` is what a terminal runs (`shell`, or a harness id: its own command), `num` a shell's number. */
/** A terminal tab with `login` runs its harness's (`sub`) sign-in (`harness.login`) instead of a shell. */
export interface Tab { id: string; kind: Kind; url?: string; term?: string; /** A browser card's address to open now (a link clicked in the chat); the card takes it and clears it. */ open?: string; title?: string; sub?: string; num?: number; login?: boolean }
export interface Group { id: string; tabs: Tab[]; active: string }
export type Node = { t: 'chat' } | { t: 'group'; id: string } | { t: 'split'; v: boolean; items: Node[]; w: number[] };
export interface Layout { root: Node; groups: Group[]; parked: Tab[]; expanded: string | null; spots: Record<string, { beside?: string; side?: Side }> }

export const KINDS: Kind[] = ['files', 'changes', 'terminal', 'browser', 'background'];
/** One of each per project (a second click shows it); browsers and terminals have as many tabs as you open. */
export const SINGLE = new Set<Kind>(['files', 'changes', 'background']);
export const TITLE: Record<Kind, string> = { files: 'Files', changes: 'Changes', browser: 'Browser', terminal: 'Terminal', background: 'Background' };
export const GLYPH: Record<Kind, string> = { files: 'folder', changes: 'diff', browser: 'globe', terminal: 'terminal', background: 'activity' };

/** The gap between cards (the divider's width). */
export const GAP = 8;
/** The least a node takes: the chat keeps room to read; a card its header and a little under it. */
export function minSize(n: Node): { w: number; h: number } {
  if (n.t === 'chat') return { w: 380, h: 400 };
  if (n.t === 'group') return { w: 260, h: 160 };
  const m = n.items.map(minSize), gaps = GAP * (n.items.length - 1);
  return n.v ? { w: Math.max(...m.map((x) => x.w)), h: m.reduce((a, x) => a + x.h, 0) + gaps }
    : { w: m.reduce((a, x) => a + x.w, 0) + gaps, h: Math.max(...m.map((x) => x.h)) };
}
/** The smallest a narrow window squeezes a card to before the chat gives up any room. */
export const FLOOR = 160;
/** What a node can be squeezed to by the window (the chat its minimum, cards to FLOOR). */
export function floorSize(n: Node): { w: number; h: number } {
  if (n.t === 'chat') return minSize(n);
  if (n.t === 'group') return { w: FLOOR, h: 120 };
  const m = n.items.map(floorSize), gaps = GAP * (n.items.length - 1);
  return n.v ? { w: Math.max(...m.map((x) => x.w)), h: m.reduce((a, x) => a + x.h, 0) + gaps }
    : { w: m.reduce((a, x) => a + x.w, 0) + gaps, h: Math.max(...m.map((x) => x.h)) };
}
/** The size a node is comfortable at: a new card gets at least this when there is room. */
function comfortable(n: Node): { w: number; h: number } {
  if (n.t === 'chat') return { w: 440, h: 400 };
  if (n.t === 'group') return { w: 340, h: 240 };
  const m = n.items.map(comfortable), gaps = GAP * (n.items.length - 1);
  return n.v ? { w: Math.max(...m.map((x) => x.w)), h: m.reduce((a, x) => a + x.h, 0) + gaps }
    : { w: m.reduce((a, x) => a + x.w, 0) + gaps, h: Math.max(...m.map((x) => x.h)) };
}
/** Sizes along an axis for `avail`: by weight, none under its minimum. */
function distribute(w: number[], avail: number, mins: number[]): number[] {
  const n = w.length;
  const fixed = new Array(n).fill(false), out = new Array(n).fill(0);
  for (let k = 0; k < n; k++) {
    const fixedSum = mins.reduce((a, m, i) => a + (fixed[i] ? m : 0), 0);
    const free = Math.max(avail - fixedSum, 0);
    const wsum = Math.max(w.reduce((a, x, i) => a + (fixed[i] ? 0 : Math.max(x, 0.001)), 0), 0.001);
    let changed = false;
    for (let i = 0; i < n; i++) if (!fixed[i]) { out[i] = (free * Math.max(w[i], 0.001)) / wsum; if (out[i] < mins[i]) { fixed[i] = true; changed = true; } }
    if (!changed) break;
  }
  for (let i = 0; i < n; i++) if (fixed[i]) out[i] = mins[i];
  return out;
}
/** The tree with room made for the cards `ids` (one just docked, opened or split, and the card it went beside): where
 * one would be smaller than comfortable, the cards beside it with room to spare give it some (makingRoom). */
export function makingRoom(n: Node, ids: Set<string>, rect: { w: number; h: number }): Node {
  if (n.t !== 'split' || rect.w <= 0 || rect.h <= 0) return n;
  const k = n.items.length;
  const avail = (n.v ? rect.h : rect.w) - GAP * (k - 1);
  const mins = n.items.map((x) => (n.v ? minSize(x).h : minSize(x).w));
  const sizes = distribute(n.w, avail, mins);
  const comfy = n.items.map((x) => (n.v ? comfortable(x).h : comfortable(x).w));
  const wants = n.items.map((x) => leaves(x).some((id) => ids.has(id)));
  const deficit = n.items.map((_, i) => (wants[i] ? Math.max(comfy[i] - sizes[i], 0) : 0));
  const need = deficit.reduce((a, b) => a + b, 0);
  let changed = false;
  if (need > 0.5) {
    const slack = n.items.map((_, i) => (wants[i] ? 0 : Math.max(sizes[i] - Math.max(comfy[i], mins[i]), 0)));
    const room = slack.reduce((a, b) => a + b, 0);
    const give = Math.min(need, room);
    if (give > 0.5) {
      for (let i = 0; i < k; i++) sizes[i] += wants[i] ? (give * deficit[i]) / need : room > 0 ? -(give * slack[i]) / room : 0;
      changed = true;
    }
  }
  const items = n.items.map((x, i) => (wants[i] ? makingRoom(x, ids, n.v ? { w: rect.w, h: sizes[i] } : { w: sizes[i], h: rect.h }) : x));
  return { t: 'split', v: n.v, items, w: changed ? sizes : n.w };
}

/** A rectangle in the tree's own coordinates (PaneHost's area). */
export interface Box { x: number; y: number; w: number; h: number }
/** A divider between items `i` and `i + 1` of the split at `path`, with the two items' boxes. */
export interface Gap { path: number[]; i: number; v: boolean; box: Box; a: Box; b: Box; node: Extract<Node, { t: 'split' }> }
/** Where everything goes in `box`: each card's (and the chat's) box by id, and the dividers. Sizes by weight, none under
 * what the window may squeeze it to (floorSize). */
export function place(n: Node, box: Box, path: number[] = [], out: { leaves: Record<string, Box>; gaps: Gap[] } = { leaves: {}, gaps: [] }) {
  if (n.t !== 'split') { out.leaves[leafId(n)!] = box; return out; }
  const k = n.items.length;
  const avail = (n.v ? box.h : box.w) - GAP * (k - 1);
  const sizes = distribute(n.w, avail, n.items.map((x) => (n.v ? floorSize(x).h : floorSize(x).w)));
  let at = n.v ? box.y : box.x;
  const boxes = sizes.map((s) => { const b = n.v ? { x: box.x, y: at, w: box.w, h: s } : { x: at, y: box.y, w: s, h: box.h }; at += s + GAP; return b; });
  boxes.forEach((b, i) => {
    if (i > 0) {
      const p = boxes[i - 1];
      const g = n.v ? { x: box.x, y: p.y + p.h, w: box.w, h: GAP } : { x: p.x + p.w, y: box.y, w: GAP, h: box.h };
      out.gaps.push({ path, i: i - 1, v: n.v, box: g, a: p, b, node: n });
    }
    place(n.items[i], b, [...path, i], out);
  });
  return out;
}

const vertical = (s: Side) => s === 'top' || s === 'bottom';
const first = (s: Side) => s === 'left' || s === 'top';

export function leafId(n: Node): string | null { return n.t === 'chat' ? 'chat' : n.t === 'group' ? n.id : null; }
export function leaves(n: Node): string[] { return n.t === 'split' ? n.items.flatMap(leaves) : [leafId(n)!]; }
export function contains(n: Node, id: string) { return leaves(n).includes(id); }
const leafNode = (id: string): Node => (id === 'chat' ? { t: 'chat' } : { t: 'group', id });

/** A split inside a split of the same direction joins it (its cards keep their share). */
export function flattened(n: Node): Node {
  if (n.t !== 'split') return n;
  const items: Node[] = [], w: number[] = [];
  n.items.forEach((it, i) => {
    const f = flattened(it);
    if (f.t === 'split' && f.v === n.v) {
      const total = Math.max(f.w.reduce((a, b) => a + b, 0), 0.001);
      f.items.forEach((c, j) => { items.push(c); w.push((f.w[j] / total) * n.w[i]); });
    } else { items.push(f); w.push(n.w[i]); }
  });
  return { t: 'split', v: n.v, items, w };
}
/** The tree without a card; a split left with one card becomes that card. */
export function removing(n: Node, id: string): Node | null {
  if (n.t !== 'split') return leafId(n) === id ? null : n;
  const items: Node[] = [], w: number[] = [];
  n.items.forEach((it, i) => { const r = removing(it, id); if (r) { items.push(r); w.push(n.w[i]); } });
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  return flattened({ t: 'split', v: n.v, items, w });
}
/** `leaf` docked beside the card `id` on a side; it takes half of that card's share. */
export function inserting(n: Node, leaf: Node, id: string, side: Side): Node {
  if (n.t !== 'split') {
    if (leafId(n) !== id) return n;
    return { t: 'split', v: vertical(side), items: first(side) ? [leaf, n] : [n, leaf], w: [1, 1] };
  }
  const i = n.items.findIndex((x) => leafId(x) === id);
  if (i >= 0 && n.v === vertical(side)) {
    const items = [...n.items], w = [...n.w];
    const half = w[i] / 2;
    w[i] = half;
    const at = first(side) ? i : i + 1;
    items.splice(at, 0, leaf); w.splice(at, 0, half);
    return { t: 'split', v: n.v, items, w };
  }
  return { t: 'split', v: n.v, items: n.items.map((x) => (contains(x, id) ? inserting(x, leaf, id, side) : x)), w: n.w };
}
/** Where a card is, told by the card beside it (to put a hidden card back where it was). */
export function neighbor(n: Node, id: string): { beside: string; side: Side } | null {
  if (n.t !== 'split') return null;
  const i = n.items.findIndex((x) => leafId(x) === id);
  if (i >= 0) {
    if (i > 0) return { beside: leaves(n.items[i - 1]).at(-1)!, side: n.v ? 'bottom' : 'right' };
    if (n.items.length > 1) return { beside: leaves(n.items[1])[0], side: n.v ? 'top' : 'left' };
    return null;
  }
  for (const x of n.items) { const r = neighbor(x, id); if (r) return r; }
  return null;
}
/** A valid tree from whatever was saved: weights per card, no card twice, the chat once. */
function normalized(n: Node, seen: Set<string>): Node | null {
  if (n.t === 'chat') return seen.has('chat') ? null : (seen.add('chat'), n);
  if (n.t === 'group') return !n.id || n.id === 'chat' || seen.has(n.id) ? null : (seen.add(n.id), n);
  if (n.t !== 'split' || !Array.isArray(n.items)) return null;
  const items: Node[] = [], w: number[] = [];
  n.items.forEach((it, i) => { const x = normalized(it, seen); if (x) { items.push(x); const wi = n.w?.[i]; w.push(Number.isFinite(wi) && wi > 0 ? wi : 1); } });
  if (!items.length) return null;
  if (items.length === 1) return items[0];
  return { t: 'split', v: !!n.v, items, w };
}
/** The split at `path` gets new weights. */
function setWeights(n: Node, path: number[], w: number[]): Node {
  if (n.t !== 'split') return n;
  if (!path.length) return w.length === n.items.length ? { ...n, w: w.map((x) => (Number.isFinite(x) && x > 0 ? x : 1)) } : n;
  const items = [...n.items];
  items[path[0]] = setWeights(items[path[0]], path.slice(1), w);
  return { ...n, items };
}

/** The first card's share beside the chat: 380 pt of the tree (ToolPanels.defaultWidth). */
function firstWeights(): number[] {
  const tree = (typeof window === 'undefined' ? 1180 : window.innerWidth) - 272 - 8;
  return [Math.max(tree - 420 - 8, 420), 420];
}

let seq = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

const KEY = (conv: string) => `coderail.panes.${conv}`;

class Panes {
  layouts = $state<Record<string, Layout>>({});
  /** The tree's size on screen (PaneHost): a new card's room is worked out in it. */
  rect = { w: 0, h: 0 };
  /** A divider being dragged (its cursor; web pages and terminals don't take the pointer meanwhile). */
  resizing = $state<'row' | 'col' | null>(null);
  /** A card or tab being dragged, and where it would land. */
  // (Only what changes rarely is state: what is held and where it would land. The pointer itself is not: PaneHost moves
  // the held card under it frame by frame, without a render.)
  drag = $state<{ conv: string; item: { type: 'pane' | 'tab'; id: string }; x: number; y: number; drop: Drop | null } | null>(null);
  /** The tree to draw: while a card (or the chat) is held over a side of another, the tree as it will be once it lands,
   * so the others move out of its way before it is let go. */
  view(conv: string): Node {
    const l = this.get(conv), d = this.drag;
    if (!d || d.conv !== conv || d.item.type !== 'pane' || d.drop?.kind !== 'dock') return l.root;
    const without = removing(l.root, d.item.id);
    return without && contains(without, d.drop.target) ? inserting(without, leafNode(d.item.id), d.drop.target, d.drop.side) : l.root;
  }

  /** Layouts read from storage, before their first change (reading one never writes state: it is read in views). */
  private read = new Map<string, Layout>();
  get(conv: string): Layout {
    const live = this.layouts[conv];
    if (live) return live;
    let l = this.read.get(conv);
    if (!l) {
      l = this.clean(kept(KEY(conv), null)) ?? undefined;
      if (!l) {
        const g: Group = { id: newId('g'), tabs: [{ id: newId('t'), kind: 'files' }], active: '' };
        g.active = g.tabs[0].id;
        l = { root: { t: 'split', v: false, items: [{ t: 'chat' }, { t: 'group', id: g.id }], w: firstWeights() }, groups: [g], parked: [], expanded: null, spots: {} };
      }
      this.read.set(conv, l);
    }
    return l;
  }
  private clean(raw: any): Layout | null {
    if (!raw || typeof raw !== 'object') return null;
    const groups: Group[] = (raw.groups ?? []).filter((g: Group) => g?.id && Array.isArray(g.tabs))
      .map((g: Group) => ({ ...g, tabs: g.tabs.filter((t) => KINDS.includes(t.kind)) })).filter((g: Group) => g.tabs.length);
    for (const g of groups) if (!g.tabs.some((t) => t.id === g.active)) g.active = g.tabs[0].id;
    const parked: Tab[] = (raw.parked ?? []).filter((t: Tab) => KINDS.includes(t.kind));
    let root = normalized(raw.root ?? { t: 'chat' }, new Set()) ?? { t: 'chat' };
    for (const id of leaves(root)) if (id !== 'chat' && !groups.some((g) => g.id === id)) root = removing(root, id) ?? { t: 'chat' };
    if (!contains(root, 'chat')) root = { t: 'chat' };
    for (const g of groups) if (!contains(root, g.id)) root = this.place(root, g.id);
    return { root: flattened(root), groups, parked, expanded: groups.some((g) => g.id === raw.expanded) ? raw.expanded : null, spots: raw.spots ?? {} };
  }
  /** A new card: beside `beside` when it is there, else under the last card, else at the chat's right. */
  private place(root: Node, id: string, beside?: string, side: Side = 'bottom'): Node {
    if (beside && contains(root, beside)) return inserting(root, { t: 'group', id }, beside, side);
    const anchor = leaves(root).filter((x) => x !== 'chat').at(-1);
    if (anchor) return inserting(root, { t: 'group', id }, anchor, 'bottom');
    return { t: 'split', v: false, items: [root, { t: 'group', id }], w: firstWeights() };
  }
  /** A change to a layout; the cards named in the `room` it fills get a comfortable size where there is room. */
  private edit(conv: string, f: (l: Layout, room: Set<string>) => void) {
    const l = $state.snapshot(this.get(conv)) as Layout;
    const room = new Set<string>();
    f(l, room);
    // Empty cards go; the tree keeps only the cards there are.
    l.groups = l.groups.filter((g) => g.tabs.length);
    for (const g of l.groups) if (!g.tabs.some((t) => t.id === g.active)) g.active = g.tabs[0].id;
    for (const id of leaves(l.root)) if (id !== 'chat' && !l.groups.some((g) => g.id === id)) l.root = removing(l.root, id) ?? { t: 'chat' };
    for (const g of l.groups) if (!contains(l.root, g.id)) l.root = this.place(l.root, g.id);
    l.root = flattened(l.root);
    if (room.size && this.rect.w > 0) l.root = makingRoom(l.root, room, this.rect);
    if (l.expanded && !l.groups.some((g) => g.id === l.expanded)) l.expanded = null;
    this.layouts[conv] = l;
    keep(KEY(conv), l);
  }

  // ---- lookups
  tabs(conv: string) { return this.get(conv).groups.flatMap((g) => g.tabs); }
  group(conv: string, id: string) { return this.get(conv).groups.find((g) => g.id === id); }
  /** A tool is open: a tab of its kind is in a card (the toolbar's icon is lit). */
  isOpen(conv: string, kind: Kind) { return this.get(conv).groups.some((g) => g.tabs.some((t) => t.kind === kind)); }
  /** A tool shows: a tab of its kind is the front tab of its card. */
  isVisible(conv: string, kind: Kind) { return this.get(conv).groups.some((g) => g.tabs.some((t) => t.kind === kind && t.id === g.active)); }
  /** A new tab of a kind: a shell terminal takes the lowest free number. */
  private makeTab(l: Layout, kind: Kind, sub?: string): Tab {
    const t: Tab = { id: newId('t'), kind };
    if (kind !== 'terminal') return t;
    t.sub = sub ?? 'shell';
    if (t.sub === 'shell') {
      const used = new Set([...l.groups.flatMap((g) => g.tabs), ...l.parked].filter((x) => x.kind === 'terminal' && (x.sub ?? 'shell') === 'shell').map((x) => x.num));
      let n = 1;
      while (used.has(n)) n++;
      t.num = n;
    }
    return t;
  }
  canSplit(conv: string, group: string) {
    const g = this.group(conv, group);
    const t = g?.tabs.find((x) => x.id === g.active);
    return !!t && (!SINGLE.has(t.kind) || g!.tabs.length > 1);
  }

  // ---- the toolbar
  /** Opens a tool as a card (or brings it to the front), and hides it when it is showing. */
  toggle(conv: string, kind: Kind) { if (this.isVisible(conv, kind)) this.park(conv, kind); else this.show(conv, kind); }
  show(conv: string, kind: Kind) {
    const t = this.tabs(conv).find((x) => x.kind === kind);
    if (t) return this.activate(conv, t.id);
    this.edit(conv, (l, room) => {
      const back = l.parked.filter((x) => x.kind === kind);
      const tabs = back.length ? back : [this.makeTab(l, kind)];
      l.parked = l.parked.filter((x) => x.kind !== kind);
      const spot = l.spots[kind];
      delete l.spots[kind];
      const g: Group = { id: newId('g'), tabs, active: tabs[0].id };
      l.groups.push(g);
      l.root = this.place(l.root, g.id, spot?.beside, spot?.side);
      room.add(g.id);
      if (spot?.beside) room.add(spot.beside);
    });
  }
  /** Hides every tab of a kind (its terminals keep running; the next click brings the same tabs back). */
  park(conv: string, kind: Kind) {
    this.edit(conv, (l) => {
      const g = l.groups.find((x) => x.tabs.every((t) => t.kind === kind));
      const n = g ? neighbor(l.root, g.id) : null;
      l.spots[kind] = n ? { beside: n.beside, side: n.side } : {};
      for (const x of l.groups) { l.parked.push(...x.tabs.filter((t) => t.kind === kind)); x.tabs = x.tabs.filter((t) => t.kind !== kind); }
    });
  }

  // ---- a card's controls
  addTab(conv: string, kind: Kind, group?: string, sub?: string) {
    this.edit(conv, (l, room) => {
      let tab: Tab | undefined;
      if (SINGLE.has(kind)) {
        for (const x of l.groups) { const i = x.tabs.findIndex((t) => t.kind === kind); if (i >= 0) tab = x.tabs.splice(i, 1)[0]; }
        const pi = l.parked.findIndex((t) => t.kind === kind);
        if (!tab && pi >= 0) tab = l.parked.splice(pi, 1)[0];
      }
      tab ??= this.makeTab(l, kind, sub);
      const g = l.groups.find((x) => x.id === group);
      if (g) { g.tabs.push(tab); g.active = tab.id; }
      else { const ng: Group = { id: newId('g'), tabs: [tab], active: tab.id }; l.groups.push(ng); l.root = this.place(l.root, ng.id); room.add(ng.id); }
    });
  }
  /** A new card beside this one with a new tab of the kind showing (a single tool moves out instead). With `kind`, that
   *  tool in the new card: a new one, or a single one moved from its card (or brought back). */
  split(conv: string, group: string, side: Side, kind?: Kind) {
    if (!kind && !this.canSplit(conv, group)) return;
    this.edit(conv, (l, room) => {
      const g = l.groups.find((x) => x.id === group)!;
      const i = g.tabs.findIndex((t) => t.id === g.active);
      const cur = g.tabs[i];
      let tab: Tab | undefined;
      if (kind && SINGLE.has(kind)) {
        for (const x of l.groups) { const j = x.tabs.findIndex((t) => t.kind === kind); if (j >= 0) tab = x.tabs.splice(j, 1)[0]; }
        const pi = l.parked.findIndex((t) => t.kind === kind);
        if (!tab && pi >= 0) tab = l.parked.splice(pi, 1)[0];
      }
      if (kind) tab ??= this.makeTab(l, kind);
      else tab = SINGLE.has(cur.kind) ? g.tabs.splice(i, 1)[0] : this.makeTab(l, cur.kind, cur.kind === 'terminal' ? cur.sub : undefined);
      const ng: Group = { id: newId('g'), tabs: [tab], active: tab.id };
      l.groups.push(ng);
      l.root = inserting(l.root, { t: 'group', id: ng.id }, group, side);
      room.add(ng.id); room.add(group);
    });
  }
  activate(conv: string, tab: string) { this.edit(conv, (l) => { for (const g of l.groups) if (g.tabs.some((t) => t.id === tab)) g.active = tab; }); }
  setTab(conv: string, tab: string, fields: Partial<Tab>) { this.edit(conv, (l) => { for (const g of l.groups) for (const t of g.tabs) if (t.id === tab) Object.assign(t, fields); }); }
  closeTab(conv: string, tab: string) {
    const t = this.tabs(conv).find((x) => x.id === tab);
    this.edit(conv, (l) => { for (const g of l.groups) g.tabs = g.tabs.filter((x) => x.id !== tab); });
    return t ? [t] : [];
  }
  closePane(conv: string, group: string) {
    const ended = this.group(conv, group)?.tabs ?? [];
    this.edit(conv, (l) => { l.groups = l.groups.filter((g) => g.id !== group); });
    return ended;
  }
  toggleExpanded(conv: string, group: string) { this.edit(conv, (l) => { l.expanded = l.expanded === group ? null : group; }); }
  /** Back to the default: the chat on the left, every open tab in one card on the right. */
  reset(conv: string) {
    this.edit(conv, (l) => {
      const tabs = l.groups.flatMap((g) => g.tabs);
      if (!tabs.length) { l.root = { t: 'chat' }; return; }
      const g: Group = { id: l.groups[0].id, tabs, active: l.groups[0].active };
      l.groups = [g]; l.expanded = null;
      l.root = { t: 'split', v: false, items: [{ t: 'chat' }, { t: 'group', id: g.id }], w: firstWeights() };
    });
  }
  /** A layout with just these tools, each a card (the screenshots' scenes). */
  fresh(conv: string, kinds: Kind[]) {
    this.edit(conv, (l) => {
      l.groups = []; l.parked = []; l.expanded = null; l.spots = {}; l.root = { t: 'chat' };
      for (const kind of kinds) {
        const g: Group = { id: newId('g'), tabs: [this.makeTab(l, kind)], active: '' };
        g.active = g.tabs[0].id;
        l.groups.push(g);
        l.root = this.place(l.root, g.id);
      }
    });
  }
  weights(conv: string, path: number[], w: number[]) { this.edit(conv, (l) => { l.root = setWeights(l.root, path, w); }); }

  // ---- dragging
  /** A card (or the chat) docked beside another card. */
  dockPane(conv: string, id: string, side: Side, target: string) {
    if (id === target) return;
    this.edit(conv, (l, room) => {
      const without = removing(l.root, id);
      if (!without || !contains(without, target) || !contains(l.root, id)) return;
      l.root = inserting(without, leafNode(id), target, side);
      l.expanded = null;
      room.add(id); room.add(target);
    });
  }
  /** A tab dragged out into a card of its own beside another card (a lone tab moves its whole card). */
  dockTab(conv: string, tab: string, side: Side, target: string) {
    const src = this.get(conv).groups.find((g) => g.tabs.some((t) => t.id === tab));
    if (!src) return;
    if (src.tabs.length === 1) return this.dockPane(conv, src.id, side, target);
    this.edit(conv, (l, room) => {
      const g = l.groups.find((x) => x.id === src.id)!;
      const moved = g.tabs.splice(g.tabs.findIndex((t) => t.id === tab), 1)[0];
      const ng: Group = { id: newId('g'), tabs: [moved], active: moved.id };
      l.groups.push(ng);
      l.root = inserting(l.root, { t: 'group', id: ng.id }, target, side);
      room.add(ng.id); room.add(target);
    });
  }
  /** A card's tabs (or one tab) join another card, at `index` in its tabs (the end without one); a tab dropped in its
   * own card's tabs moves there. */
  merge(conv: string, item: { type: 'pane' | 'tab'; id: string }, into: string, index?: number) {
    this.edit(conv, (l) => {
      const dst = l.groups.find((g) => g.id === into);
      if (!dst) return;
      const at = (n: number) => Math.max(0, Math.min(index ?? n, n));
      if (item.type === 'pane') {
        if (item.id === into || item.id === 'chat') return;
        const src = l.groups.find((g) => g.id === item.id);
        if (!src) return;
        dst.tabs.splice(at(dst.tabs.length), 0, ...src.tabs); dst.active = src.active; src.tabs = [];
      } else {
        const src = l.groups.find((g) => g.tabs.some((t) => t.id === item.id));
        if (!src) return;
        const from = src.tabs.findIndex((t) => t.id === item.id);
        if (src.id === into) {
          if (index == null) return;
          const moved = src.tabs.splice(from, 1)[0];
          const to = Math.max(0, Math.min(index - (from < index ? 1 : 0), src.tabs.length));
          src.tabs.splice(to, 0, moved);
          src.active = moved.id;
          return;
        }
        const moved = src.tabs.splice(from, 1)[0];
        dst.tabs.splice(at(dst.tabs.length), 0, moved); dst.active = moved.id;
      }
    });
  }
  land() {
    const d = this.drag;
    this.drag = null;
    if (!d?.drop) return;
    const { conv, item, drop } = d;
    if (drop.kind === 'merge') this.merge(conv, item, drop.target);
    else if (drop.kind === 'tabs') this.merge(conv, item, drop.target, drop.index);
    else if (item.type === 'pane') this.dockPane(conv, item.id, drop.side, drop.target);
    else this.dockTab(conv, item.id, drop.side, drop.target);
  }
}

export type Drop = { kind: 'dock'; side: Side; target: string; rect: DOMRect } | { kind: 'merge'; target: string; rect: DOMRect }
  | { kind: 'tabs'; target: string; index: number; rect: DOMRect };

export const panes = new Panes();
