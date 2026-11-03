// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { assert, assertGone, killTree, until } from '../common';
export interface RpcProcess {
  pid: number;
  stdin: { write(text: string): unknown; flush(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
}
export class Rpc {
  readonly proc: RpcProcess;
  readonly events: any[] = [];
  readonly requests: any[] = [];
  stderr = '';
  private next = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  onRequest: (message: any) => Promise<any> = async message => { throw new Error(`Unexpected server request ${message.method}`); };
  onEvent: (message: any) => void = () => {};
  constructor(argv: string[], cwd: string, env = process.env, transport?: RpcProcess) {
    if (transport) this.proc = transport;
    else {
      const proc = Bun.spawn(argv, { cwd, env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
      this.proc = { pid: proc.pid, stdin: proc.stdin, stdout: proc.stdout, stderr: proc.stderr, exited: proc.exited };
    }
    void this.read(this.proc.stdout as ReadableStream<Uint8Array>);
    const stderr = this.proc.stderr as ReadableStream<Uint8Array>;
    void (async () => { const decoder = new TextDecoder('utf-8'); for await (const chunk of stderr) this.stderr = (this.stderr + decoder.decode(chunk, { stream: true })).slice(-12000); })();
    this.proc.exited.then(code => { for (const p of this.pending.values()) p.reject(new Error(`RPC exited ${code}: ${this.stderr.slice(-1500)}`)); this.pending.clear(); });
  }
  private async read(stream: ReadableStream<Uint8Array>) {
    let buffer = ''; const decoder = new TextDecoder('utf-8');
    for await (const bytes of stream) {
      buffer += decoder.decode(bytes, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (!line.trim()) continue;
        const message = JSON.parse(line);
        if (message.method && message.id !== undefined) {
          this.requests.push(message);
          void this.onRequest(message).then(result => this.send({ jsonrpc: '2.0', id: message.id, result }), error => this.send({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: String(error) } }));
        } else if (message.method) { this.events.push(message); this.onEvent(message); }
        else {
          const request = this.pending.get(message.id); this.pending.delete(message.id);
          if (message.error) request?.reject(new Error(JSON.stringify(message.error))); else request?.resolve(message.result);
        }
      }
    }
  }
  send(message: unknown) { (this.proc.stdin as import('bun').FileSink).write(JSON.stringify(message) + '\n'); (this.proc.stdin as import('bun').FileSink).flush(); }
  notify(method: string, params: unknown = {}) { this.send({ jsonrpc: '2.0', method, params }); }
  async call(method: string, params: unknown = {}, timeout = 30000): Promise<any> {
    const id = this.next++;
    let timer: ReturnType<typeof setTimeout>;
    const value = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timeout: ${this.stderr.slice(-1500)}`)); }, timeout);
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    try { return await value; } finally { clearTimeout(timer!); }
  }
  async event(method: string, predicate: (params: any) => boolean = () => true, timeout = 120000) {
    await until(() => this.events.some(e => e.method === method && predicate(e.params)), timeout, method);
    return this.events.find(e => e.method === method && predicate(e.params))!.params;
  }
  async stop() { await killTree(this.proc.pid); await this.proc.exited; await assertGone([this.proc.pid]); }
}

export async function appServer(cwd: string) {
  const codex = process.env.POC_CODEX_PATH ?? Bun.which('codex'); assert(codex, 'Codex CLI not found');
  const rpc = new Rpc([codex, 'app-server', '--stdio', '-c', 'shell_environment_policy.inherit="all"'], cwd);
  try {
    const init = await rpc.call('initialize', { clientInfo: { name: 'coderail_windows_poc', version: '0.1.0', title: 'Isolated Windows PoC' }, capabilities: { experimentalApi: true, requestAttestation: false } });
    rpc.notify('initialized');
    return { rpc, init };
  } catch (error) { await rpc.stop(); throw error; }
}
