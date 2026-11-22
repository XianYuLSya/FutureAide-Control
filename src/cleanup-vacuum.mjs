import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { lstat, readFile, stat, statfs } from 'node:fs/promises';
import path from 'node:path';
import { openAuthority, digest } from './cleanup-authority.mjs';

async function walBytes(filename) {
  try{return (await stat(filename+'-wal')).size;}catch(e){if(e.code==='ENOENT')return 0;throw e;}
}
function integrity(db) {
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok') throw new Error('SQLite integrity check failed.');
  const result={};
  for (const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const table='"'+name.replaceAll('"','""')+'"';
    result[name]=db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n;
    if (['agents','owners','submissions','agent_history','records'].includes(name)) {
      const latest = db.prepare('SELECT * FROM '+table+' ORDER BY rowid DESC LIMIT 1').get();
      result[name+'Latest'] = latest ? createHash('sha256').update(JSON.stringify(latest)).digest('hex') : null;
    }
    if(name.startsWith('cleanup_archiv')) {
      const h=createHash('sha256');
      for(const r of db.prepare('SELECT * FROM '+table+' ORDER BY rowid').iterate()) h.update(JSON.stringify(r));
      result[name+'Digest']=h.digest('hex');
    }
  }
  return JSON.stringify(result);
}

export async function offlineVacuum(config,decisions,approval,backupFile) {
  const binding=JSON.parse(await readFile(path.join(config.stateDirectory,'cleanup-binding.json'),'utf8'));
  if(!binding.ids.local || !approval || binding.approval!==approval || digest([decisions.snapshot,decisions])!==approval)
    throw new Error('Offline maintenance requires the approved local snapshot and decisions.');
  const grant=decisions.vacuum;
  if (!grant?.selected) return {applied:false,reason:'not-selected',actualBytes:0};
  const filename=path.join(config.stateDirectory,'roster.sqlite');
  if (grant.database!==filename || !Number.isSafeInteger(grant.minimumBytes) || grant.minimumBytes<=0
    || !Number.isSafeInteger(grant.maxPauseMs) || grant.maxPauseMs<=0 || !(grant.measuredVacuumMs>0)
    || grant.measuredVacuumMs>grant.maxPauseMs) return {applied:false,reason:'maintenance-budget-not-met',actualBytes:0};
  const authority=await openAuthority(config,false,{binding:binding.ids.local});
  try {if(authority.info.manifest!==approval) throw new Error('Maintenance approval changed.');} finally {authority.close();}
  if(!path.isAbsolute(backupFile??'')) throw new Error('An absolute new backup file path is required.');
  try {await lstat(backupFile);throw new Error('Backup already exists.');}catch(e){if(e.code!=='ENOENT')throw e;}
  if((await lstat(filename)).isSymbolicLink()) throw new Error('Roster is redirected.');
  const bytes=(await stat(filename)).size;
  for (const location of new Set([path.dirname(filename), path.dirname(backupFile)])) {
    const space=await statfs(location);
    if(space.bavail*space.bsize<bytes*3) return {applied:false,reason:'insufficient-temporary-space',actualBytes:0};
  }
  const db=new DatabaseSync(filename);
  let backup;
  try {
    db.exec('PRAGMA busy_timeout=0; PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;');
    const leaseTable=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='leases'").get();
    if(leaseTable && db.prepare('SELECT 1 FROM leases WHERE expires>? LIMIT 1').get(Date.now())) return {applied:false,reason:'active-writer-lease',actualBytes:0};
    const walBefore=await walBytes(filename);
    if(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy) return {applied:false,reason:'database-busy',actualBytes:0};
    const before=(await stat(filename)).size, summary=integrity(db);
    const started=Date.now();
    db.prepare('VACUUM INTO ?').run(backupFile);
    backup=new DatabaseSync(backupFile,{readOnly:true});
    if(integrity(backup)!==summary) throw new Error('Backup verification failed.');
    const estimated=before-(await stat(backupFile)).size;
    if(estimated<grant.minimumBytes || Date.now()-started+grant.measuredVacuumMs>grant.maxPauseMs)
      return {applied:false,reason:'benefit-or-time-below-approved-budget',before,after:before,estimated,actualBytes:0,minimumBytes:grant.minimumBytes,walBefore,walAfter:await walBytes(filename),backupFile};
    const journal=await openAuthority(config,false,{binding:binding.ids.local,write:true});
    try {
      if(!journal.reserveVacuum(approval,backupFile)) return {applied:false,reason:'already-submitted',actualBytes:0};
      db.exec('VACUUM');
      if(db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get().busy || integrity(db)!==summary) throw new Error('Compacted database verification failed.');
      const after=(await stat(filename)).size;
      const outcome={applied:true,before,after,estimated,actualBytes:before-after,minimumBytes:grant.minimumBytes,walBefore,walAfter:await walBytes(filename),elapsedMs:Date.now()-started,backupFile};
      journal.recordVacuum(approval,outcome);
      return outcome;
    } finally { journal.close(); }
  } catch(e) {
    if(e.errcode===5 || e.errcode===6 || /database is locked/i.test(e.message)) return {applied:false,reason:'database-busy',actualBytes:0};
    throw e;
  } finally {backup?.close();db.close();}
}
