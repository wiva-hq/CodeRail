<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Any other file: its first bytes as a hex dump (offset, 16 bytes, their printable characters).
  let { bytes, size }: { bytes: Uint8Array; size: number } = $props();
  const MAX = 64 * 1024;
  const text = $derived.by(() => {
    const n = Math.min(bytes.length, MAX);
    const lines: string[] = [];
    for (let i = 0; i < n; i += 16) {
      const row = bytes.subarray(i, Math.min(i + 16, n));
      let hex = '';
      let ascii = '';
      for (let j = 0; j < 16; j++) {
        hex += j < row.length ? row[j].toString(16).padStart(2, '0') + ' ' : '   ';
        if (j === 7) hex += ' ';
        ascii += j < row.length ? (row[j] >= 0x20 && row[j] < 0x7f ? String.fromCharCode(row[j]) : '.') : '';
      }
      lines.push(`${i.toString(16).padStart(8, '0')}  ${hex} ${ascii}`);
    }
    return lines.join('\n');
  });
</script>

{#if size > Math.min(bytes.length, MAX)}<div class="more">The first {Math.min(bytes.length, MAX).toLocaleString('en-US')} of {size.toLocaleString('en-US')} bytes</div>{/if}
<pre class="hex">{text}</pre>

<style>
  .more { padding: var(--sp-1h) var(--gutter); color: var(--muted); font-size: var(--fs-small); }
  .hex { margin: 0; padding: var(--sp-3) var(--gutter); font: 12px/18px var(--mono); color: var(--ink2); white-space: pre; }
</style>
