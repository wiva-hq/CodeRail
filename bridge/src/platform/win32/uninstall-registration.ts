// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { win32 as p } from 'node:path';
import { error } from './paths';
import { writePrivateFile } from './private-fs';
import { UserAutorun } from './autorun';
import { UserEnvironmentValue, removePath } from './user-path';
import { registrationJournal } from './install-recovery';
import { notifyEnvironmentChange } from './environment-notify';

/** Re-entrant registry phase only. File removal requires acknowledged actor
 * handoff afterwards; success here never means uninstall has completed. */
export async function unregisterInstallation(input: string, options: {startup?: UserAutorun; environment?: UserEnvironmentValue} = {}) {
  const {root, installed, journal, command, path} = await registrationJournal(input, ['registered-unpaired', 'prepared', 'rollback-incomplete', 'rolled-back', 'uninstalling', 'unregistered']);
  const startup = options.startup ?? new UserAutorun(), environment = options.environment ?? new UserEnvironmentValue();
  const current = startup.read();
  if (current !== null && current !== command) throw error('EEXIST', 'Startup was changed by someone else; refusing uninstall');
  if (journal.status === 'unregistered') {
    if (current !== null) throw error('EEXIST', 'Startup was re-registered after uninstall');
    return {installationId: installed.id, status: 'unregistered', filesRetained: true};
  }
  const actual = environment.read();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const valid = (v: any) => v === null || v && [1, 2].includes(v.type) && typeof v.text === 'string' && v.text.length <= 32760 && !v.text.includes('\0');
  const change = journal.status === 'uninstalling' ? journal.unregisterPath : {before: actual, after: removePath(actual, path)};
  if (!change || !valid(change.before) || !valid(change.after) || !same(removePath(change.before, path), change.after)) throw error('EINVAL', 'Invalid uninstall PATH journal');
  if (!same(actual, change.before) && !same(actual, change.after)) throw error('EEXIST', 'PATH changed during interrupted uninstall; refusing ambiguous recovery');
  const save = (status: string) => writePrivateFile(p.join(root, 'ownership.txt'), JSON.stringify({...journal, unregisterPath: change, status}, null, 2));
  save('uninstalling');
  if (current === command) startup.uninstall(command);
  const changed = !same(actual, change.after);
  if (changed) environment.write(change.after);
  save('unregistered');
  const notification = environment.name === 'Path' && changed ? await notifyEnvironmentChange() : null;
  return {installationId: installed.id, status: 'unregistered', filesRetained: true, notification};
}
