// Copyright 2026 Wiva, Inc.
// SPDX-License-Identifier: Apache-2.0
import { win32 as p } from 'node:path';
import { NativeFile } from './native';
import { error } from './paths';
import { writePrivateFile } from './private-fs';
import { guardInstallationRoot, readInstallation } from './install-files';
import { quoteArgument } from './launcher';
import { UserAutorun } from './autorun';
import { addPath, removePath, UserEnvironmentValue, type PathChange, type RegistryString } from './user-path';

export async function registrationJournal(input: string, statuses: readonly string[]) {
  const root=await guardInstallationRoot(input),installed=readInstallation(root);
  if(!installed)throw error('EACCES','No owned installation to recover');
  const directory=new NativeFile(root,true);let journal:any;
  try {
    const file=directory.child('ownership.txt',false);
    try {if(file.details().size>128*1024)throw error('EINVAL','Installation journal too large');journal=JSON.parse(file.read(root,128*1024).toString('utf8'));}
    finally {file.close();}
  } finally {directory.close();}
  if(journal.schema!==1||journal.installationId!==installed.id||!statuses.includes(journal.status))throw error('EINVAL','Journal is not an interrupted installation');
  if(installed.executable!==p.join(root,'bin/current/coderail.exe'))throw error('EACCES','Invalid installed executable ownership');
  const legacy=[p.join(root,'supervisor.exe'),root,installed.executable,'run'].map(quoteArgument).join(' ');
  const short=[p.join(root,'supervisor.exe'),'--installed'].map(quoteArgument).join(' ');
  if(typeof journal.startup!=='string'||![legacy,short].includes(journal.startup))throw error('EACCES','Startup journal does not match this installation');
  const command=journal.startup as string;
  const valid=(value:unknown):value is RegistryString=>!!value&&typeof value==='object'&&[1,2].includes((value as any).type)&&typeof(value as any).text==='string'&&(value as any).text.length<=32760&&!(value as any).text.includes('\0');
  const path=journal.path as PathChange;
  if(!path||(path.old!==null&&!valid(path.old))||!valid(path.installed)||typeof path.added!=='boolean'||path.entry!==p.dirname(installed.executable))throw error('EINVAL','Invalid PATH recovery journal');
  const expected=addPath(path.old,path.entry);
  if(expected.added!==path.added||expected.installed.text!==path.installed.text||expected.installed.type!==path.installed.type)throw error('EACCES','PATH journal does not describe this installation');
  return {root,installed,journal,command,path};
}

/** Undo registry effects from a crashed first install; keep owned files for a separate cleanup phase. */
export async function recoverRegistration(input: string, options: {startup?:UserAutorun;environment?:UserEnvironmentValue}={}) {
  const {root,installed,journal,command,path}=await registrationJournal(input,['prepared','rollback-incomplete','rolled-back']);
  const startup=options.startup??new UserAutorun(),environment=options.environment??new UserEnvironmentValue();
  const current=startup.read();if(current!==null&&current!==command)throw error('EEXIST','Startup was changed by someone else; recovery will not remove it');
  if(journal.status==='rolled-back') {
    if(current!==null)throw error('EEXIST','Startup was re-registered after rollback');
    return {installationId:installed.id,status:'rolled-back',filesRetained:true};
  }
  if(current===command)startup.uninstall(command);
  environment.write(removePath(environment.read(),path));
  writePrivateFile(p.join(root,'ownership.txt'),JSON.stringify({...journal,status:'rolled-back'},null,2));
  return {installationId:installed.id,status:'rolled-back',filesRetained:true};
}
