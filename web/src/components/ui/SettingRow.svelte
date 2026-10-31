<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A Settings row (the Claude app's): the title at the left with what it does under it in the muted ink (the same
  // size as the title), the control at the right; rows of one group sit under a `.group-head` with a hairline
  // between them (base.css `.set`). `lead` draws a glyph or picture before the title.
  //
  //   <SettingRow title="Notifications" description="When an agent asks you something.">
  //     {#snippet control()}<Switch … />{/snippet}
  //   </SettingRow>
  import type { Snippet } from 'svelte';
  import { tip as tipAt } from '../../lib/tip';
  let { title, description, lead, control, children, tip }: {
    title: string;
    description?: string;
    lead?: Snippet;
    /** What sits at the right: a switch, a segmented control, a dropdown, a button. */
    control?: Snippet;
    /** Free content under the title in place of the description (a link inside it, a value). */
    children?: Snippet;
    tip?: string;
  } = $props();
</script>

<div class="set">
  {#if lead}<span class="set-lead">{@render lead()}</span>{/if}
  <span class="set-text">
    <span class="set-title" {@attach tipAt(tip)}>{title}</span>
    {#if description}<span class="set-desc">{description}</span>{/if}
    {#if children}<span class="set-desc">{@render children()}</span>{/if}
  </span>
  {#if control}<span class="set-ctl">{@render control()}</span>{/if}
</div>
