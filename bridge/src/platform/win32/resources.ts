// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { captureTree, ProcessRef, snapshot } from './job';
import { listeningPorts } from './net';
import { memory } from './memory';

/** A sample, not atomic accounting: retain identities across the async port query. */
export async function resources(root: ProcessRef) {
  if (!root.alive()) return null;
  const table = snapshot(), children = captureTree(root, table), refs = [root, ...children];
  try {
    const ports = await listeningPorts([root.pid]);
    if (!root.alive()) return null;
    const processes = refs.flatMap(ref => {
      const counters = memory(ref);
      return counters && ref.alive() ? [{ pid: ref.pid, created: ref.created.toString(), name: table.find(row => row.pid === ref.pid)?.name ?? '', ...counters }] : [];
    });
    const live = new Set(processes.map(item => item.pid));
    return { sampledAt: new Date().toISOString(), rootPid: root.pid, processes,
      workingSetBytes: processes.reduce((total, item) => total + item.workingSetBytes, 0),
      privateBytes: processes.reduce((total, item) => total + item.privateBytes, 0),
      ports: ports.filter(port => live.has(port.pid)) };
  } finally { for (const child of children) child.close(); }
}
