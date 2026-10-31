<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // Renders its children into the one top layer (#layer, lib/layer.svelte.ts) instead of where it is written:
  // out of any transformed, clipped or stacked parent (a sheet's card, the phone's pushed screen). The children
  // keep the writer's state and context. When the Portal goes, their exit transitions (`|global`) play first.
  import { getAllContexts, mount, unmount, type Snippet } from 'svelte';
  import { layerRoot } from '../../lib/layer.svelte';
  import PortalBody from './PortalBody.svelte';
  let { children }: { children: Snippet } = $props();
  const context = getAllContexts();
  $effect(() => {
    const props = { get children() { return children; } };
    const body = mount(PortalBody, { target: layerRoot(), props, context, intro: true });
    return () => { void unmount(body, { outro: true }); };
  });
</script>
