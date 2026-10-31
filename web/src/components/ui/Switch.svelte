<!-- Copyright 2026 Wiva, Inc.
     SPDX-License-Identifier: Apache-2.0 -->
<script lang="ts">
  // A switch (the Claude app's toggle, in Forest's green): 36 × 20, the knob slides 120 ms on the snap curve. Its name is the
  // setting's title, so a row's switch reads as that setting.
  //
  //   <Switch on={shell.notify} label="Notifications" onchange={(v) => shell.setNotify(v)} />
  let { on, label, onchange }: { on: boolean; label: string; onchange: (on: boolean) => void } = $props();
</script>

<button type="button" class="switch" class:on role="switch" aria-checked={on} aria-label={label} onclick={() => onchange(!on)}></button>
