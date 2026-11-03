// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import {homedir} from 'node:os';
import {win32 as p} from 'node:path';
import {registrationJournal} from './install-recovery';
import {UserAutorun} from './autorun';
import {UserEnvironmentValue} from './user-path';
import {UserService} from './service';
import {unregisterInstallation} from './uninstall-registration';
import {requestCleanup} from './cleanup-request';
import {launchCleanup} from './launch-cleanup';

/** Acknowledged scheduling, not completion: cleanup waits for this CLI to exit. */
export async function uninstallOwned(input:string,options:{startup?:UserAutorun;environment?:UserEnvironmentValue}={}) {
  const {root}=await registrationJournal(input,['registered-unpaired','prepared','rollback-incomplete','rolled-back','uninstalling','unregistered']);
  const service=new UserService(options.startup),status=await service.status({command:[],home:homedir(),stateDir:root,logPath:p.join(root,'bridge.log')});
  const registration=await unregisterInstallation(root,options);
  const actor=status.running?await requestCleanup(root):await launchCleanup(root);
  return {status:'cleanup-scheduled',installationRoot:root,actor,notification:'notification' in registration?registration.notification:null};
}
