// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// A link clicked in a chat (an address an agent sent, a Claude artifact) opens in that chat's Browser card, not a new
// tab: the screen that shows the chat provides how (setOpenLink), and Markdown asks for it (openLink).
import { getContext, setContext } from 'svelte';

const KEY = Symbol('openLink');

/** Opens a link in the chat's browser; false when there's no chat to open it in (the link then opens as usual). */
type OpenLink = (url: string) => boolean;

export function setOpenLink(fn: OpenLink) {
  setContext(KEY, fn);
}

export function openLink(): OpenLink | undefined {
  return getContext<OpenLink | undefined>(KEY);
}
