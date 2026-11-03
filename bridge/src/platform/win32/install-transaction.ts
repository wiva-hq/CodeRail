// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { win32 as p } from 'node:path';
import { error } from './paths';
import { writePrivateFile } from './private-fs';
import { UserAutorun, validateStartupCommand } from './autorun';
import { quoteArgument } from './launcher';
import { UserService } from './service';
import { deployBinary, guardInstallationRoot, readInstallation } from './install-files';
import { addPath, removePath, UserEnvironmentValue } from './user-path';
import { notifyEnvironmentChange } from './environment-notify';

/** First-install transaction. Registers an unpaired installation without running it.
 * A failed transaction restores registry state, retaining owned files and a diagnostic journal.
 * Crash recovery, activation and removal of installed files are deliberately separate gates. */
export async function installPrepared(root: string, binary: string, version: string, options: {
  startup?: UserAutorun; environment?: UserEnvironmentValue;
} = {}) {
  const directory = await guardInstallationRoot(root);
  if (readInstallation(directory)) throw error('EEXIST', 'Use the update/recovery flow for an existing installation');
  const startup = options.startup ?? new UserAutorun(), environment = options.environment ?? new UserEnvironmentValue();
  // Detect conflicts before copying anything or touching PATH.
  if (startup.read() !== null) throw error('EEXIST', 'The CodeRail startup entry already exists');
  // Reject unrepresentable PATH entries before creating any installation files.
  const change = addPath(environment.read(), p.join(directory, 'bin/current'));
  validateStartupCommand([p.join(directory, 'supervisor.exe'), '--installed'].map(quoteArgument).join(' '));
  const installed = await deployBinary(directory, binary, version);
  const service = new UserService(startup);
  const spec = { command: [installed.executable, 'run'], stateDir: directory, home: process.env.USERPROFILE!, logPath: p.join(directory, 'bridge.log') };
  let registered = false, pathTouched = false;
  const journal = p.join(directory, 'ownership.txt');
  const save = (status: string, command: string) => writePrivateFile(journal, JSON.stringify({ schema: 1, installationId: installed.id, status, startup: command, path: change }, null, 2));
  let command = '';
  try {
    await service.prepare(spec); command = service.command(spec);
    if(JSON.stringify(environment.read())!==JSON.stringify(change.old))throw error('EEXIST','PATH changed while preparing installation; retry with the current environment');
    save('prepared', command);
    registered = true; startup.install(command);
    if (change.added) { pathTouched = true; environment.write(change.installed); }
    save('registered-unpaired', command);
    const notification = environment.name === 'Path' && change.added ? await notifyEnvironmentChange() : null;
    return { installed, command, pathAdded: change.added, notification };
  } catch (failure) {
    const errors: unknown[] = [failure];
    if (pathTouched) try { environment.write(removePath(environment.read(), change)); } catch (cause) { errors.push(cause); }
    if (registered) try { startup.uninstall(command); } catch (cause) { errors.push(cause); }
    try { save(errors.length === 1 ? 'rolled-back' : 'rollback-incomplete', command); } catch (cause) { errors.push(cause); }
    if (errors.length > 1) throw new AggregateError(errors, 'Installation failed; rollback needs recovery');
    throw failure;
  }
}
