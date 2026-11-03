// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// Local fixture transport only. Never writes the capability token to output.
import { until } from '../common';
const [url, tokenFile] = process.argv.slice(2);
const token = (await Bun.file(tokenFile).text()).trim();
const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } } as any);
ws.onmessage = event => process.stdout.write(String(event.data) + '\n');
ws.onclose = () => process.exit(0);
ws.onerror = () => { console.error('Local WebSocket transport failed'); process.exit(1); };
await until(() => ws.readyState === WebSocket.OPEN, 15000, 'local app-server WebSocket');
let buffer = ''; const decoder = new TextDecoder('utf-8');
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let end: number;
  while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) ws.send(line); }
}
ws.close();
