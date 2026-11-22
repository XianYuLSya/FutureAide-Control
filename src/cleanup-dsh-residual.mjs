import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstat,readFile,unlink} from 'node:fs/promises';
import path from 'node:path';
import {collectDshEvidence} from './cleanup-dsh-evidence.mjs';
import {RosterStore} from './roster-store.mjs';
const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
export function createDshResidualCleanup(config,{client,readEvidence=collectDshEvidence}={}) {
  async function inspect(item, snapshot) {
    try {
      const kind=item?.kind==='managed-host-residual'?'sidecar':item?.kind==='dsh-projection-residual'?'projection':null;
      if(!kind || !client?.cleanupResidualInspect)return {running:null,reason:'residual-adapter-unavailable'};
      const evidence=snapshot ?? await readEvidence(config);if(!evidence.complete)return {running:null,reason:'residual-source-coverage-incomplete'};
      const id=item.sessionId;
      if((evidence.stagedSessions??[]).some(x=>x.sessionId===id))return {running:true,reason:'session-in-staging-ticket'};
      if(evidence.sessions.some(x=>x.sessionId===id) || evidence.roster.some(x=>x.sessionId===id) || evidence.legacy.some(x=>x.sessionId===id))return {running:true,reason:'residual-still-owned-or-present'};
      let source;
      if(kind==='sidecar') {
        source=evidence.sidecars.find(x=>x.sessionId===id && 'managed-host:'+path.basename(x.path)===item.id);
        if(!source)return {running:null,reason:'sidecar-identity-unverified'};
        if(evidence.roster.some(x=>x.ownerId===source.ownerId&&x.agentId===source.agentId))return {running:true,reason:'sidecar-owner-still-registered'};
      } else {
        source=evidence.projections.find(x=>x.sessionId===id && item.id==='projection:'+id);
        if(!source)return {running:null,reason:'projection-identity-unverified'};
      }
      const st=await lstat(source.path);if(!st.isFile()||st.isSymbolicLink()||!st.ino)throw Error('residual-file-unverified');
      const bytes=await readFile(source.path),fileVersion=hash(bytes.toString('base64'));
      const host=await client.cleanupResidualInspect({kind,sessionId:id,root:config.dshDataRoot});
      if(host?.running!==false || !host.activityVersion)return {running:host?.running===true?true:null,reason:host?.reason??'residual-host-unverified'};
      return {...item,running:false,eligible:true,firstEligible:true,reason:'residual-proven-unused',bytes:bytes.length,
        activityVersion:hash([kind,id,source.path,String(st.dev),String(st.ino),fileVersion,host.activityVersion]),
        residualHostVersion:host.activityVersion,residualFileVersion:fileVersion,residualPath:source.path,residualSource:source};
    }catch(error){return {running:null,reason:error.code??error.message??'residual-unverified'};}
  }
  function archive(source,raw) {
    let rawUtf8;
    try { rawUtf8=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw); }
    catch { throw new Error('sidecar-encoding-unverified'); }
    const file=path.join(config.stateDirectory,'roster.sqlite');
    const roster=new RosterStore(file);roster.close();
    const db=new DatabaseSync(file);
    try {
      db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS cleanup_archives(archive_key TEXT PRIMARY KEY,source TEXT NOT NULL,original_id TEXT NOT NULL,owner TEXT,agent TEXT,name TEXT,created TEXT NOT NULL,payload TEXT NOT NULL,sha256 TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS cleanup_archives_lookup ON cleanup_archives(name,owner,agent,created);`);
      const payload=JSON.stringify({sessionId:source.sessionId,ownerId:source.ownerId,agentId:source.agentId,rawUtf8});
      const sha=hash(payload),key='managed-host:'+source.sessionId+':'+sha;
      db.exec('BEGIN IMMEDIATE');try{
        const insert=db.prepare('INSERT OR IGNORE INTO cleanup_archives VALUES (?,?,?,?,?,?,?,?,?)');
        const check=db.prepare('SELECT payload,sha256 FROM cleanup_archives WHERE archive_key=?');
        const created=new Date().toISOString();
        const put=(archiveKey,type,originalId,body,at)=>{
          const checksum=hash(body);
          insert.run(archiveKey,type,originalId,source.ownerId,source.agentId,source.sessionId,at,body,checksum);
          const row=check.get(archiveKey);
          if(row?.payload!==body || row.sha256!==checksum)throw Error('residual-archive-conflict');
        };
        put(key,'managed-host',source.sessionId,payload,created);
        const snapshot=JSON.parse(rawUtf8);
        for(const [field,type] of [['questions','managed-host-question'],['reports','managed-host-report']]) {
          for(const entry of snapshot[field] ?? []) {
            if(!entry.id) continue; // Older records with no original ID remain retrievable by session.
            if(typeof entry.id!=='string' || typeof entry.message!=='string')throw Error('residual-body-invalid');
            const stable=hash([config.dshDataRoot,source.ownerId,source.agentId,source.sessionId,entry.id]);
            const body=JSON.stringify({sessionId:source.sessionId,id:entry.id,taskId:entry.taskId??null,message:entry.message,final:entry.final===true});
            put(type+':'+stable,type,entry.id,body,entry.createdAt??created);
          }
        }
        db.exec('COMMIT');return {archiveKey:key,sha256:sha};
      }catch(error){db.exec('ROLLBACK');throw error}
    } finally {db.close()}
  }
  async function remove(item,ctx={}) {
    try {
      const fresh=await inspect(item);if(fresh.running!==false||fresh.activityVersion!==item.activityVersion)return {removed:false,reason:fresh.reason??'residual-changed'};
      if(typeof ctx.revalidate!=='function'||await ctx.revalidate()!==true)return {removed:false,reason:'authorization-changed'};
      let saved;
      if(item.kind==='managed-host-residual') {
        const raw=await readFile(fresh.residualPath);if(hash(raw.toString('base64'))!==fresh.residualFileVersion)return {removed:false,reason:'sidecar-changed'};
        saved=archive(fresh.residualSource,raw);
      }
      const last=await inspect(item);if(last.running!==false||last.activityVersion!==fresh.activityVersion)return {removed:false,reason:'residual-changed-after-archive',...saved};
      if(await ctx.revalidate()!==true)return {removed:false,reason:'authorization-changed',...saved};
      if(item.kind==='managed-host-residual') {await unlink(last.residualPath);return {removed:true,bytes:last.bytes,...saved};}
      const response=await client.cleanupResidualRemove({kind:'projection',sessionId:item.sessionId,root:config.dshDataRoot,activityVersion:last.residualHostVersion});
      return response?.removed===true?{...response,bytes:last.bytes}:{removed:false,reason:response?.reason??'projection-delete-unverified'};
    }catch(error){return {removed:false,reason:error.code??error.message??'residual-remove-failed'};}
  }
  return {inspect,remove};
}
