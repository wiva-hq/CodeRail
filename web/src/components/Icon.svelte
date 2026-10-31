<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // The Forest glyph set (24-unit grid): stroke widths by size as FIcon.defaultStroke.
  import { ICONS } from '../lib/art.gen';
  let { name, size = 16, stroke }: { name: string; size?: number; stroke?: number } = $props();
  const widths: Record<number, number> = { 12: 2, 14: 1.8, 15: 1.8, 16: 1.6, 17: 1.6, 18: 1.5, 20: 1.45 };
  let w = $derived(stroke ?? widths[Math.round(size)] ?? 1.6);
  // (Drawn here on the same 24 grid, ahead of the generated set: the cloud sandbox, the gear (Settings, General),
  // the bare prompt (the title bar's terminal), back, the sidebar, Group and sort, Stop in its ring, download.)
  const EXTRA: Record<string, string> = {
    cloud: '<path d="M7.25 18.5h10a4 4 0 0 0 .55-7.96A5.75 5.75 0 0 0 6.6 9.62 4.45 4.45 0 0 0 7.25 18.5z"/>',
    gear: '<path d="M19.04 12.93 20.95 14.15 19.84 16.81 17.63 16.32 16.32 17.63 16.81 19.84 14.15 20.95 12.93 19.04 11.07 19.04 9.85 20.95 7.19 19.84 7.68 17.63 6.37 16.32 4.16 16.81 3.05 14.15 4.96 12.93 4.96 11.07 3.05 9.85 4.16 7.19 6.37 7.68 7.68 6.37 7.19 4.16 9.85 3.05 11.07 4.96 12.93 4.96 14.15 3.05 16.81 4.16 16.32 6.37 17.63 7.68 19.84 7.19 20.95 9.85 19.04 11.07z"/><circle cx="12" cy="12" r="3"/>',
    prompt: '<path d="M5 7l5 5-5 5M12.5 17.5h6.5"/>',
    arrowl: '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="3.6"/><path d="M9.5 4.5v15"/>',
    sliders: '<path d="M8 4.5v4M8 13.5v6M16 4.5v7M16 16.5v3"/><circle cx="8" cy="11" r="2.4"/><circle cx="16" cy="14" r="2.4"/>',
    download: '<path d="M12 4.5v10.5M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>',
    menu: '<path d="M4.5 7h15M4.5 12h11M4.5 17h7"/>',
    camera: '<path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2.3l1.4-2h5.6l1.4 2h2.3A1.5 1.5 0 0 1 20 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z"/><circle cx="12" cy="12.75" r="3.25"/>',
    photo: '<rect x="4" y="4.5" width="16" height="15" rx="2.5"/><circle cx="9" cy="9.5" r="1.6"/><path d="M4.5 17.5l4.5-4.5 3.5 3.5 2.5-2.5 4.5 4.5"/>',
    stopc:'<circle cx="12" cy="12" r="8.5"/><rect class="d" x="9" y="9" width="6" height="6" rx="1.2"/>',
  };
</script>

<svg class="i" width={size} height={size} viewBox="0 0 24 24" stroke-width={w} aria-hidden="true">{@html EXTRA[name] ?? ICONS[name] ?? ''}</svg>
