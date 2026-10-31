// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { type FSWatcher, watch } from 'node:fs';

// Folders someone has open in Files: each one listed (`fs.list`) is watched, not its subfolders, and a change in it is
// sent as {type:"changed"} on the topic "fs:<path as asked>", at most twice a second, so the open trees list it again.
// The hub answers a change no one is subscribed to with `fs_quiet`, which stops that watch; past MAX the oldest stop too.

const MAX = 256;
const WAIT = 500;

export class Watches {
  private live = new Map<string, { w: FSWatcher; timer: ReturnType<typeof setTimeout> | null }>();

  constructor(private emit: (topic: string, data: any) => void) {}

  /** Watches a folder just listed: `asked` is the path the client used (its topic), `real` the folder itself. */
  add(asked: string, real: string) {
    const had = this.live.get(asked);
    if (had) {
      // (Newest last: the oldest is the first to go past MAX.)
      this.live.delete(asked);
      this.live.set(asked, had);
      return;
    }
    let w: FSWatcher;
    try {
      w = watch(real, { persistent: false }, () => this.changed(asked));
    } catch {
      return;
    }
    w.on('error', () => this.quiet(asked));
    this.live.set(asked, { w, timer: null });
    while (this.live.size > MAX) this.quiet(this.live.keys().next().value!);
  }

  private changed(asked: string) {
    const e = this.live.get(asked);
    if (!e || e.timer) return;
    e.timer = setTimeout(() => {
      e.timer = null;
      if (this.live.get(asked) === e) this.emit('fs:' + asked, { type: 'changed' });
    }, WAIT);
  }

  /** No one is looking at this folder any more. */
  quiet(asked: string) {
    const e = this.live.get(asked);
    if (!e) return;
    this.live.delete(asked);
    if (e.timer) clearTimeout(e.timer);
    try { e.w.close(); } catch {}
  }

  shutdown() {
    for (const k of [...this.live.keys()]) this.quiet(k);
  }
}
