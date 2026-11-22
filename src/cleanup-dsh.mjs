import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { FutureAideClient } from './futureaide-api.mjs';
import { collectDshEvidence, classifyDshInventory } from './cleanup-dsh-evidence.mjs';
import { createDshResidualCleanup } from './cleanup-dsh-residual.mjs';

export function archiveOrphanHistory(config, history, physicalRoot) {
  if (!history?.complete || !Array.isArray(history.events)) throw new Error('orphan-history-incomplete');
  const db=new DatabaseSync(path.join(config.stateDirectory,'roster.sqlite'));
  const digest=value=>createHash('sha256').update(value).digest('hex');
  try {
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS cleanup_archives(archive_key TEXT PRIMARY KEY,source TEXT NOT NULL,original_id TEXT NOT NULL,owner TEXT,agent TEXT,name TEXT,created TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cleanup_archives_lookup ON cleanup_archives(name,owner,agent,created); BEGIN IMMEDIATE`);
    const insert=db.prepare('INSERT OR IGNORE INTO cleanup_archives VALUES (?,?,?,?,?,?,?,?,?)');
    const read=db.prepare('SELECT payload,sha256 FROM cleanup_archives WHERE archive_key=?');
    const keys=[];
    for (const entry of history.events) {
      if (typeof entry.sessionId!=='string' || typeof entry.sourceId!=='string' || !entry.event) throw new Error('orphan-history-invalid');
      const payload=JSON.stringify(entry), sha=digest(payload), domain=digest(process.platform==='win32'?physicalRoot.toLowerCase():physicalRoot), key=`dsh-orphan:${domain}:${entry.sourceId}`;
      const time=typeof entry.event.time==='number' && Number.isFinite(entry.event.time) ? new Date(entry.event.time).toISOString() : new Date().toISOString();
      insert.run(key,'dsh-orphan-history',entry.sourceId,null,null,entry.sessionId,time,payload,sha);
      const saved=read.get(key); if(saved?.payload!==payload || saved.sha256!==sha) throw new Error('orphan-archive-verification-failed'); keys.push(key);
    }
    db.exec('COMMIT'); return {count:keys.length,manifestHash:digest(JSON.stringify(keys.sort()))};
  } catch(error) {try{db.exec('ROLLBACK');}catch{} throw error;} finally {db.close();}
}
// Host owns inspection and the final recheck; never fall back to raw disk removal.
export function createDshCleanup(config = {}) {
  const client = config.client ?? new FutureAideClient({ ...config, dshDataHome: config.dshDataRoot ?? config.dataRoot ?? config.dshDataHome });
  const residual=createDshResidualCleanup(config,{client});
  const isResidual=item=>['managed-host-residual','dsh-projection-residual'].includes(item?.kind);
  const decorate = result => ({...result,items:result.items.map(item=>{
    if (!['direct','direct-subtree','orphan','direct-orphan'].includes(item.ownership)) return item;
    const supported=((item.ownership==='direct' && (/^session-[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(item.sessionId??'') || /^session-codex-[a-f0-9]{32}$/i.test(item.sessionId??'') && item.ordinaryEvidence?.receiptPath)) || (item.ownership==='direct-subtree' && item.parent?.state==='present' && !item.parent.referenced && !item.parent.running) || (['orphan','direct-orphan'].includes(item.ownership) && item.orphanEvidence?.deletedTicket)) && item.running===false && Array.isArray(item.treeIds) && item.treeIds.length>=1;
    const retention=config.agentIdleRetentionMs ?? 43200000;
    const last=Date.parse(item.lastActivityAt);
    const validTime=Number.isFinite(last) && last>=1000000000000 && last<=Date.now();
    return {...item,firstEligible:supported,eligible:supported && (item.ownership==='orphan' || validTime && Date.now()-last>=retention),
      ...(supported && !validTime ? {observationMs:retention} : {}),
      reason:supported ? validTime?'direct-idle-time':'direct-idle-time-unverified' : 'direct-native-state-or-tree-unverified'};
  })});
  return {
    async inspectManaged(record) {
      try { return await client.managedCleanupInspect({ownerId:record.ownerId,agentId:record.agentId,sessionId:record.sessionId,
        workspace:record.workspace,treeProtocol:1,reportProtocol:1,...(record.task?.taskId?{taskId:record.task.taskId}:{})}); }
      catch (error) {return {running:null,ownership:'managed',complete:false,historyComplete:false,reason:error.code ?? error.message};}
    },
    async removeManaged(record, backendState, expected, context) {
      try {return await client.managedCleanupStage({ownerId:record.ownerId,agentId:record.agentId,sessionId:record.sessionId,workspace:record.workspace,
        treeProtocol:1,reportProtocol:1,...(record.task?.taskId?{taskId:record.task.taskId}:{}),expected,operationToken:context?.operationToken,disposition:context?.disposition});}
      catch(error) {return {removed:false,reason:error.code ?? error.message};}
    },
    async finalizeManaged(record, backendState, expected, context) {
      try {return await client.managedCleanupFinalize({ownerId:record.ownerId,agentId:record.agentId,sessionId:record.sessionId,workspace:record.workspace,
        treeProtocol:1,reportProtocol:1,...(record.task?.taskId?{taskId:record.task.taskId}:{}),expected,operationToken:context?.operationToken,disposition:context?.disposition});}
      catch(error) {return {removed:false,reason:error.code ?? error.message};}
    },
    async restoreManaged(record, context) {
      try {return await client.managedCleanupRestore({ownerId:record.ownerId,agentId:record.agentId,sessionId:record.sessionId,workspace:record.workspace,
        treeProtocol:1,reportProtocol:1,operationToken:context?.operationToken});}
      catch(error) {return {restored:false,reason:error.code ?? error.message};}
    },
    async inventory() {
      try {
        const native=await client.cleanupInventory();
        const evidence=await collectDshEvidence(config);
        const classified=decorate(classifyDshInventory(native,evidence,config));
        for (let i=0;i<classified.items.length;i++) if(isResidual(classified.items[i])) {
          const item=classified.items[i], checked=await residual.inspect(item,evidence); classified.items[i]={...item,...checked};
        }
        return classified;
      } catch (error) { return {items:[],complete:false,reason:error.code ?? error.message}; }
    },
    async inspect(item) {
      if (isResidual(item)) return {...item,...await residual.inspect(item)};
      try {
        const native=await client.cleanupInventory();
        const evidence=await collectDshEvidence(config);
        return decorate(classifyDshInventory(native,evidence,config)).items.find(row=>row.id===(item.id??item.sessionId)) ?? {available:false,reason:'identity-unverified'};
      } catch (error) { return {available:false,reason:error.code ?? error.message}; }
    },
    async remove(item, context) {
      if (isResidual(item)) return residual.remove(item,context);
      try {
        const native=await client.cleanupInventory();
        const evidence=await collectDshEvidence(config);
        const current=decorate(classifyDshInventory(native,evidence,config)).items.find(row=>row.id===(item.id??item.sessionId));
        if (!current || !['direct','direct-subtree','orphan','direct-orphan'].includes(current.ownership) || current.activityVersion!==item.activityVersion || current.running!==false || !current.firstEligible)
          return {removed:false,reason:'identity-activity-or-ownership-changed'};
        if (typeof context?.revalidate==='function' && !await context.revalidate()) return {removed:false,reason:'authorization-changed'};
        let archive;
        if (['orphan','direct-orphan'].includes(current.ownership)) {
          const history=await client.cleanupHistory({...current,activityVersion:current.hostActivityVersion});
          if (!history.complete || history.activityVersion!==current.hostActivityVersion) return {removed:false,reason:'orphan-history-unverified'};
          archive=archiveOrphanHistory(config,history,await realpath(config.dshDataRoot));
          if (typeof context?.revalidate==='function' && !await context.revalidate()) return {removed:false,reason:'authorization-changed',archive};
        }
        const result=await client.cleanupRemove({...current,activityVersion:current.hostActivityVersion},{...context,...(current.orphanEvidence ? {orphanEvidence:current.orphanEvidence} : {}),...(current.ordinaryEvidence ? {ordinaryEvidence:current.ordinaryEvidence} : {})});
        return archive ? {...result,archive} : result;
      } catch (error) { return {removed:false,reason:error.code ?? error.message}; }
    },
    async finalize(ticket) { try { return await client.cleanupFinalize(ticket); } catch (error) { return {removed:false,reason:error.code ?? error.message}; } },
    async restore(ticket) { try { return await client.cleanupRestore(ticket); } catch (error) { return {restored:false,reason:error.code ?? error.message}; } },
    async tempUsage(path) { try { return await client.cleanupTempUsage(path); } catch (error) { return {inUse:null,reason:error.code ?? error.message}; } },
  };
}
