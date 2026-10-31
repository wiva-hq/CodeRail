// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
// The chat's browser as tools for its agent: an MCP server (stdio) handed to each ACP session. The harness starts it
// as `<this bridge> <script>` with BUN_BE_BUN, like the adapters, so it is plain JavaScript written out to a file,
// with no imports. Each call goes to the bridge's loopback tool endpoint (Browsers.toolEndpoint), which drives the
// same Camofox tab the chat's Browser card streams: the person watches the agent browse, and can take over.

/** The tools: what the agent sees. Names are short; the harness prefixes them (mcp__browser__navigate). */
export const BROWSER_TOOLS = [
  {
    name: 'navigate',
    description:
      "Open a web address in this chat's own browser (Camofox, running on this computer, on its network: localhost and " +
      'dev servers work). The person sees it live in the Browser panel and can sign in to sites there for you. Opens the ' +
      'browser if it is not open yet. Returns the page as text with element refs (e1, e2, …) to click or type into.',
    inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'An http or https address' } }, required: ['url'] },
  },
  {
    name: 'snapshot',
    description: 'The current page as text, with element refs (e1, e2, …) for click and type. Long pages come in parts: pass the offset it names.',
    inputSchema: { type: 'object', properties: { offset: { type: 'number', description: 'Where to continue a long page' } } },
  },
  {
    name: 'click',
    description: 'Click an element, by its ref from the last snapshot (or a CSS selector).',
    inputSchema: { type: 'object', properties: { ref: { type: 'string' }, selector: { type: 'string' } } },
  },
  {
    name: 'type',
    description: 'Type text into an element, by ref (or CSS selector). pressEnter submits.',
    inputSchema: {
      type: 'object',
      properties: { ref: { type: 'string' }, selector: { type: 'string' }, text: { type: 'string' }, pressEnter: { type: 'boolean' } },
      required: ['text'],
    },
  },
  {
    name: 'press',
    description: 'Press a key on the page (Enter, Escape, Tab, ArrowDown, …).',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
  },
  {
    name: 'scroll',
    description: 'Scroll the page.',
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'number', description: 'Pixels (default 600)' } },
      required: ['direction'],
    },
  },
  {
    name: 'screenshot',
    description: 'What the page looks like now, as an image.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'back',
    description: 'Go back one page.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'evaluate',
    description: 'Run a JavaScript expression in the page and return its result (as JSON).',
    inputSchema: { type: 'object', properties: { expression: { type: 'string' } }, required: ['expression'] },
  },
];

/** The MCP server's source. */
export const BROWSER_MCP_SOURCE = `// CodeRail: the chat's browser, as MCP tools (written by the bridge; see bridge/src/browser-mcp.ts).
const API = process.env.CODERAIL_BROWSER_API;
const TOKEN = process.env.CODERAIL_BROWSER_TOKEN;
const KEY = process.env.CODERAIL_BROWSER_KEY;
const TOOLS = ${JSON.stringify(BROWSER_TOOLS)};
const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\\n');
async function handle(m) {
  if (m.method === 'initialize') {
    return send({ id: m.id, result: {
      protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'coderail-browser', version: '1' },
      instructions: "This chat's own browser, on the person's computer. They watch it live in CodeRail's Browser panel.",
    } });
  }
  if (m.method === 'tools/list') return send({ id: m.id, result: { tools: TOOLS } });
  if (m.method === 'ping') return send({ id: m.id, result: {} });
  if (m.method === 'tools/call') {
    try {
      const r = await fetch(API + '/tool', {
        method: 'POST',
        headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ key: KEY, name: m.params?.name, args: m.params?.arguments ?? {} }),
      });
      return send({ id: m.id, result: await r.json() });
    } catch (e) {
      return send({ id: m.id, result: { content: [{ type: 'text', text: 'The browser is not reachable: ' + e.message }], isError: true } });
    }
  }
  if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'No method ' + m.method } });
}
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    void handle(m);
  }
});
process.stdin.on('end', () => process.exit(0));
`;
