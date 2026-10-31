// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
/// <reference types="svelte" />
/// <reference types="vite/client" />

// (mammoth's own browser build, loaded only when a Word document is opened: the one call the viewer makes.)
declare module 'mammoth/mammoth.browser.js' {
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string; messages: unknown[] }>;
}
