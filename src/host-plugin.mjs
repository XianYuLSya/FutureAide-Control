import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function writeFeedback(node, configFile, input, context, deadline) {
  if (Date.now() >= deadline) return Promise.resolve({ saved: false, code: 'feedback-unavailable' });
  return new Promise(resolve => {
    let child, handedOff = false, settled = false, output = '';
    const unknown = () => ({ saved: null, code: 'feedback-outcome-unknown' });
    const finish = value => { if (settled) return; settled = true; clearTimeout(timer); if (child && child.exitCode === null) child.kill(); resolve(value); };
    const timer = setTimeout(() => finish(handedOff ? unknown() : { saved: false, code: 'feedback-unavailable' }), Math.max(0, deadline - Date.now()));
    try {
      child = spawn(node, [fileURLToPath(new URL('./feedback-inbox.mjs', import.meta.url)), '--write', '--config', configFile], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      child.once('error', () => finish(handedOff ? unknown() : { saved: false, code: 'feedback-unavailable' }));
      child.stdout.on('data', chunk => { output += chunk; if (output.length > 8192) finish(unknown()); });
      child.once('close', code => { try { const value = JSON.parse(output); if (code === 0 && [true, false, null].includes(value.saved)) return finish(value); } catch {} finish(handedOff ? unknown() : { saved: false, code: 'feedback-unavailable' }); });
      child.stdin.on('error', () => finish(handedOff ? unknown() : { saved: false, code: 'feedback-unavailable' }));
      child.once('spawn', () => { if (settled || Date.now() >= deadline) return finish({ saved: false, code: 'feedback-unavailable' }); handedOff = true; child.stdin.end(JSON.stringify({ input, context })); });
    } catch { finish(handedOff ? unknown() : { saved: false, code: 'feedback-unavailable' }); }
  });
}
import os from 'node:os';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function size(directory) {
  let total = 0;
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const target = path.join(directory, entry.name);
    const st = await lstat(target);
    if (st.isSymbolicLink()) throw new Error('session-symlink');
    if (st.isDirectory()) total += await size(target);
    else if (st.isFile()) total += st.size;
    else throw new Error('session-special-file');
  }
  return total;
}

async function cleanupFileManifest(root) {
  const result=[];
  async function visit(dir, relative='') {
    const entries=(await readdir(dir,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name));
    for (const entry of entries) {
      const file=path.join(dir,entry.name), name=relative ? `${relative}/${entry.name}` : entry.name;
      const before=await lstat(file,{bigint:true});
      if (before.isSymbolicLink()) throw new Error('session-symlink');
      if (before.isDirectory()) {result.push({name,kind:'directory'}); await visit(file,name); continue;}
      if (!before.isFile()) throw new Error('session-special-file');
      const data=await readFile(file), after=await lstat(file,{bigint:true});
      if (!after.isFile() || after.isSymbolicLink() || before.dev!==after.dev || before.ino!==after.ino || before.size!==after.size || before.mtimeNs!==after.mtimeNs) throw new Error('session-file-changed');
      result.push({name,kind:'file',bytes:String(after.size),sha256:createHash('sha256').update(data).digest('hex')});
    }
  }
  await visit(root); return result;
}
const tempDigest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
/** Bound to the running DSH service. Proof is recorded only while the producer exists. */
export function createDshTempHost(ctx,{pid=process.pid,tempRoot=os.tmpdir(),alive,authorize}={}) {
  const owner=typeof ctx.root?.get==='function'?ctx.root:ctx,get=name=>owner.get(name);
  const pidAlive=alive??(id=>{try{process.kill(id,0);return true}catch(error){return error.code!=='ESRCH'}});
  async function authorityEnabled() {
    if(typeof authorize==='function')return await authorize()===true;
    let db;
    try {
      const persistence=get('sessionPersistence');
      if(typeof persistence?.config?.root!=='string')return false;
      const root=await realpath(path.dirname(persistence.config.root)),s=await lstat(root,{bigint:true});
      if(!s.isDirectory()||s.isSymbolicLink()||!s.ino)return false;
      const filename=path.join(root,'.futureaide-control','cleanup-authority.sqlite'),meta=await lstat(filename);
      if(!meta.isFile()||meta.isSymbolicLink())return false;
      const {DatabaseSync}=await import('node:sqlite');db=new DatabaseSync(filename,{readOnly:true});
      const row=db.prepare('SELECT enabled,root,owner FROM authority WHERE only=1').get();if(row?.enabled!==1)return false;
      const expected=JSON.parse(row.root),actual=[String(s.dev),String(s.ino),process.platform==='win32'?root.toLowerCase():root];
      if(JSON.stringify(expected)!==JSON.stringify(actual))return false;
      const [configFile,profile]=JSON.parse(row.owner);if(typeof configFile!=='string'||!path.isAbsolute(configFile)||!same(await realpath(configFile),configFile))return false;
      const base=JSON.parse(await readFile(configFile,'utf8'));let selected={};
      if(profile!==null && profile!==undefined){
        if(typeof profile!=='string'||!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile))return false;
        const file=path.join(path.dirname(configFile),'profiles',profile+'.json'),st=await lstat(file);if(!st.isFile()||st.isSymbolicLink())return false;
        selected=JSON.parse(await readFile(file,'utf8'));
      }
      if((selected.agentAutoCleanup??base.agentAutoCleanup)!==true)return false;
      const configured=selected.dshDataRoot??selected.dataRoot??base.dshDataRoot??base.dataRoot;
      return typeof configured==='string'&&path.isAbsolute(configured)&&same(await realpath(configured),root);
    }catch{return false}finally{db?.close()}
  }
  async function tempReadSession(id) {
    const query=get('sessionQuery'); if (typeof query?.readSession==='function') return query.readSession(id);
    const persistence=get('sessionPersistence');
    if (typeof persistence?.resolveCurrentLog!=='function' || typeof persistence?.readStoredLog!=='function') throw Error('temporary-session-history-unavailable');
    const log=await persistence.resolveCurrentLog(id); if (!log) throw Error('temporary-session-history-unavailable');
    return persistence.readStoredLog(log,id);
  }
  async function evaluate(target,{allowRecord=false,sessionId:onlySession}={}) {
    try {
      if(typeof target!=='string'||!path.isAbsolute(target)||!same(path.dirname(target),tempRoot)||!/^dsh-(spill|subprocess)-[A-Za-z0-9]{6}$/.test(path.basename(target)))return {owned:false,inUse:null,reason:'temporary-path-invalid'};
      const actual=await realpath(target);if(!same(actual,target)||!same(await realpath(tempRoot),tempRoot))return {owned:false,inUse:null,reason:'temporary-path-redirected'};
      const info=await lstat(actual,{bigint:true});if(!info.isDirectory()||info.isSymbolicLink()||!info.ino)return {owned:false,inUse:null,reason:'temporary-identity-unverified'};
      const identity=[String(info.dev),String(info.ino),String(info.birthtimeNs)];
      const persistence=get('sessionPersistence');if(typeof persistence?.config?.root!=='string')return {owned:false,inUse:null,reason:'temporary-domain-unavailable'};
      const dataRoot=await realpath(path.dirname(persistence.config.root));const evidenceRoot=path.join(dataRoot,'.futureaide-control','temp-evidence');const evidenceFile=path.join(evidenceRoot,tempDigest(actual.toLowerCase())+'.json');
      let proof;try{const meta=await lstat(evidenceFile);if(!meta.isFile()||meta.isSymbolicLink())throw Error('temporary-proof-invalid');proof=JSON.parse(await readFile(evidenceFile,'utf8'))}catch(error){if(error.code!=='ENOENT')throw error}
      if(proof && (proof.version!==1||!same(proof.path,actual)||JSON.stringify(proof.identity)!==JSON.stringify(identity)||!Number.isSafeInteger(proof.pid)||proof.pid<1))return {owned:false,inUse:null,reason:'temporary-proof-identity-conflict'};
      if(!proof && !allowRecord) {
        const spill=get('spillStore');
        if(path.basename(actual).startsWith('dsh-spill-') && same(spill?.root,actual))return {owned:true,inUse:true,reason:'active-spill-store'};
        return {owned:false,inUse:null,reason:'temporary-producer-unverified'};
      }
      if(!proof) {
        let provenance;
        const spill=get('spillStore');
        if(path.basename(actual).startsWith('dsh-spill-') && same(spill?.root,actual))provenance={kind:'live-spill-store'};
        if(!provenance && path.basename(actual).startsWith('dsh-subprocess-')) {
          if(typeof persistence.list!=='function')return {owned:false,inUse:null,reason:'temporary-tool-receipts-unavailable'};
          const sessions=await persistence.list();if(!Array.isArray(sessions))return {owned:false,inUse:null,reason:'temporary-session-list-incomplete'};
          for(const row of sessions) {
            const sessionId=row.header?.id;if(typeof sessionId!=='string' || (onlySession && sessionId!==onlySession))continue;
            let saved;try{saved=await tempReadSession(sessionId)}catch{return {owned:false,inUse:null,reason:'temporary-session-history-unavailable'}}
            if(!Array.isArray(saved?.events))return {owned:false,inUse:null,reason:'temporary-session-history-incomplete'};
            const calls=new Map(saved.events.filter(e=>e.type==='tool/call').map(e=>[e.data?.callId,e.data?.name]));
            for(const event of saved.events) {
              if(event.type!=='tool/result' || !['pwsh','bash'].includes(calls.get(event.data?.message?.toolCallId)))continue;
              for(const part of event.data?.message?.content??[]) {
                if(part?.type!=='text'||typeof part.text!=='string')continue;
                const marker='[output truncated; full output: '+actual+path.sep,at=part.text.indexOf(marker);
                if(at<0)continue;const end=part.text.indexOf(']',at+marker.length);if(end<0)continue;
                const basename=part.text.slice(at+marker.length,end),match=/^dsh-subprocess-(\d+)-\d+-[a-f0-9]{12}-(?:stdout|stderr)\.log$/.exec(basename);
                if(!match||Number(match[1])!==pid)continue;
                const file=path.join(actual,basename),meta=await lstat(file,{bigint:true});
                if(!meta.isFile()||meta.isSymbolicLink()||!same(await realpath(file),file))continue;
                provenance={kind:'live-tool-result',sessionId,callId:event.data.message.toolCallId,file:basename};break;
              }
              if(provenance)break;
            }
            if(provenance)break;
          }
        }
        if(!provenance)return {owned:false,inUse:null,reason:'temporary-producer-unverified'};
        if(!await authorityEnabled())return {owned:false,inUse:null,reason:'temporary-collection-not-authorized'};
        await mkdir(evidenceRoot,{recursive:true});if(!same(await realpath(evidenceRoot),evidenceRoot))throw Error('temporary-proof-root-redirected');
        proof={version:1,path:actual,identity,pid,provenance,capturedAt:new Date().toISOString()};
        try{await writeFile(evidenceFile,JSON.stringify(proof),{flag:'wx',mode:0o600})}catch(error){if(error.code!=='EEXIST')throw error;const other=JSON.parse(await readFile(evidenceFile,'utf8'));if(JSON.stringify(other)!==JSON.stringify(proof))return {owned:false,inUse:null,reason:'temporary-proof-conflict'}}
      }
      if(path.basename(actual).startsWith('dsh-spill-') && same(get('spillStore')?.root,actual))return {owned:true,inUse:true,reason:'active-spill-store',producerPid:proof.pid};
      if(pidAlive(proof.pid))return {owned:true,inUse:true,reason:'temporary-creator-present',producerPid:proof.pid};
      const names=await readdir(actual);if(names.length)return {owned:true,inUse:null,reason:'temporary-contents-or-references-present',producerPid:proof.pid};
      return {owned:true,inUse:false,reason:'proven-producer-exited-and-empty',producerPid:proof.pid};
    }catch(error){return {owned:false,inUse:null,reason:error.code??error.message??'temporary-proof-unavailable'};}
  }
  async function observeSession(sessionId) {
    if(!await authorityEnabled())return [];
    const outcomes=[];
    try {
      const spill=get('spillStore');
      if(typeof spill?.root==='string')outcomes.push(await evaluate(spill.root,{allowRecord:true,sessionId}));
      const query=get('sessionQuery');
      if(typeof query?.readSession!=='function')return outcomes;
      const saved=await tempReadSession(sessionId);
      for(const event of saved?.events??[])if(event.type==='tool/result')for(const part of event.data?.message?.content??[]){
        const text=part?.text;if(typeof text!=='string')continue;const marker='[output truncated; full output: ';let at=0;
        while((at=text.indexOf(marker,at))>=0){const start=at+marker.length,end=text.indexOf(']',start);if(end<0)break;
          const file=text.slice(start,end),target=path.dirname(file);
          if(path.isAbsolute(file))outcomes.push(await evaluate(target,{allowRecord:true,sessionId}));
          at=end+1;
        }
      }
    }catch(error){outcomes.push({owned:false,inUse:null,reason:error.code??error.message??'temporary-observe-failed'});}
    return outcomes;
  }
  return {tempUsage:target=>evaluate(target),observeSession,canObserve:authorityEnabled};
}






const MANAGED_CLEANUP_PROOF = Symbol('managed-cleanup-proof');
const valid=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** All operations run on the same DSH host that owns the native tables. */
export function createDshResidualHost(ctx) {
  const owner=typeof ctx.root?.get==='function'?ctx.root:ctx,service=name=>owner.get(name);
  async function inspectResidual({kind,sessionId,root}={}) {
    try {
      if(!['projection','sidecar'].includes(kind)||!valid(sessionId)||typeof root!=='string')throw Error('residual-identity-invalid');
      const persistence=service('sessionPersistence');
      if(persistence?.name!=='session-persistence-jsonl'||typeof persistence.stat!=='function'||typeof persistence.list!=='function'||typeof persistence.config?.root!=='string')throw Error('residual-native-presence-unavailable');
      if((await realpath(path.dirname(persistence.config.root))).toLowerCase()!==(await realpath(root)).toLowerCase())throw Error('residual-domain-mismatch');
      const listed=await persistence.list();if(!Array.isArray(listed))throw Error('residual-native-list-unavailable');
      if(listed.some(row=>row.header?.id===sessionId) || await persistence.stat(sessionId))return {running:true,reason:'native-session-present'};
      if(typeof owner.agents?.get!=='function'||typeof owner.sessions?.get!=='function')throw Error('residual-live-services-unavailable');
      if(owner.agents.get(sessionId)||owner.sessions.get(sessionId))return {running:true,reason:'native-session-loaded'};
      const registry=service('workspaceRegistry');
      if(typeof registry?.list!=='function'||!Array.isArray(registry.pinnedSessionIds)||!Array.isArray(registry.archivedSessionIds)||typeof registry.ctx?.waterfall!=='function')throw Error('residual-reference-coverage-unavailable');
      const projects=registry.list();if(!Array.isArray(projects)||projects.some(project=>!Array.isArray(project.sessionIds)))throw Error('residual-workspace-coverage-unavailable');
      if(projects.some(project=>project.sessionIds.includes(sessionId))||registry.pinnedSessionIds.includes(sessionId)||registry.archivedSessionIds.includes(sessionId))return {running:true,reason:'workspace-reference-present'};
      const activity=await registry.ctx.waterfall('workspace/session-activity',{sessionId},()=>Promise.resolve([]));
      if(!Array.isArray(activity))throw Error('residual-activity-unavailable');
      if(activity.length)return {running:true,reason:'native-activity-present'};
      const table=service('sessionProjectionCache')?.requireTable?.();
      if(!table||typeof table.get!=='function'||typeof table.delete!=='function')throw Error('projection-table-unavailable');
      const projection=await table.get(sessionId);
      if(kind==='projection' && !projection)return {running:null,reason:'projection-already-missing'};
      if(kind==='sidecar' && projection)return {running:true,reason:'projection-reference-present'};
      return {running:false,sessionId,kind,activityVersion:digest([kind,sessionId,projection??null]),reason:'residual-native-and-references-absent'};
    }catch(error){return {running:null,reason:error.code??error.message??'residual-unverified'};}
  }
  async function removeResidual(input={}) {
    if(input.kind!=='projection')return {removed:false,reason:'residual-kind-not-supported'};
    const current=await inspectResidual(input);
    if(current.running!==false||current.activityVersion!==input.activityVersion)return {removed:false,reason:current.reason??'residual-changed'};
    try {
      const table=service('sessionProjectionCache').requireTable();
      await table.delete(input.sessionId);
      if(await table.get(input.sessionId))return {removed:false,reason:'projection-delete-unverified'};
      return {removed:true,sessionId:input.sessionId};
    }catch(error){return {removed:false,reason:error.code??error.message??'projection-delete-failed'};}
  }
  return {inspectResidual,removeResidual};
}


// This adapter never treats unavailable native activity evidence as idle.
export function createDshHostCleanup(ctx, {graceMs = 86400000,credentialDirectory} = {}) {
  if (!Number.isSafeInteger(graceMs) || graceMs < 1) throw new Error('invalid-cleanup-grace');
  const owner = typeof ctx.root?.get === 'function' ? ctx.root : ctx;
  const service = name => owner.get(name);
  async function list() {
    const persistence = service('sessionPersistence');
    if (typeof persistence?.list !== 'function') throw new Error('session-list-unavailable');
    const snapshots = await persistence.list();
    if (!Array.isArray(snapshots)) throw new Error('session-list-incomplete');
    return snapshots.map(snapshot => ({ ...snapshot, sessionId:snapshot.header?.id, origin:snapshot.header?.origin }));
  }
  async function parentState(header, childId, rows) {
    if (header?.origin!=='subagent') return null;
    const parentId=header.parentSession;
    if (!validId(parentId)) return {state:'unknown',reason:'parent-identity-unavailable'};
    const parent=rows.find(row=>row.sessionId===parentId);
    if (!parent) return {state:'missing',parentId};
    const subagents=service('subagents'), registry=service('workspaceRegistry');
    if (typeof subagents?.listDescendants!=='function' || typeof registry?.ctx?.waterfall!=='function') return {state:'unknown',parentId,reason:'parent-activity-unavailable'};
    const descendants=await subagents.listDescendants(parentId), activity=await registry.ctx.waterfall('workspace/session-activity',{sessionId:parentId},()=>Promise.resolve([]));
    if (!Array.isArray(descendants) || !Array.isArray(activity)) return {state:'unknown',parentId,reason:'parent-activity-unavailable'};
    const live=owner.agents?.get(parentId);
    return {state:'present',parentId,referenced:descendants.some(node=>node.id===childId),running:live?.status==='running'||activity.length>0,
      version:hash([parent.revision,descendants,activity,live?.status??null,live?.session?.seq??null])};
  }
  async function inspectId(id, rows) {
    if (!validId(id)) throw new Error('invalid-session');
    const row = rows.find(value => value.sessionId === id);
    if (!row) throw new Error('session-not-listed');
    const descendants = service('subagents');
    if (typeof descendants?.listDescendants !== 'function') throw new Error('tree-unavailable');
    const tree = await descendants.listDescendants(id);
    if (!Array.isArray(tree)) throw new Error('tree-incomplete');
    const ids = [id], seen = new Set(ids);
    for (const child of tree) {
      if (child.kind !== 'child' || !validId(child.id) || !seen.has(child.parentId) || seen.has(child.id)) throw new Error('tree-incomplete');
      ids.push(child.id); seen.add(child.id);
    }
    const persistence=service('sessionPersistence');
    if (persistence?.name !== 'session-persistence-jsonl' || typeof persistence.resolveCurrentLog !== 'function') throw new Error('storage-unavailable');
    const nodes=[];
    for (const sessionId of ids) {
      const live=owner.agents?.get(sessionId), session=owner.sessions?.get(sessionId);
      const log=await persistence.resolveCurrentLog(sessionId);
      if (typeof log !== 'string' || path.basename(path.dirname(log)) !== sessionId) throw new Error('session-path-unavailable');
      const dir=path.dirname(log), stat=await lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('session-path-invalid');
      const logStat=await lstat(log);
      if (!logStat.isFile() || logStat.isSymbolicLink()) throw new Error('session-log-invalid');
      if (typeof persistence.readStoredLog!=='function') throw new Error('session-history-unavailable');
      const durable=await persistence.readStoredLog(log,sessionId);
      if (!Array.isArray(durable?.events) || durable.tornTruncateTo!==undefined || (durable.recoveredTail?.length??0)>0) throw new Error('session-history-incomplete');
      const business=durable.events.filter(e=>['turn/start','turn/end','tool/call','tool/result','assistant/message','user/message'].includes(e.type));
      const times=business.map(e=>typeof e.time==='number'?e.time:Date.parse(e.time));
      const lastActivityAt=times.length && times.every(t=>Number.isFinite(t) && t>=1000000000000 && t<=Date.now()+300000) ? Math.max(...times) : null;
      const lastStart=durable.events.findLastIndex(e=>e.type==='turn/start'), lastEnd=durable.events.findLastIndex(e=>e.type==='turn/end');
      const openTurn=lastStart>lastEnd;
      const registry=service('workspaceRegistry');
      const activity=typeof registry?.ctx?.waterfall === 'function' ? await registry.ctx.waterfall('workspace/session-activity',{sessionId},()=>Promise.resolve([])) : null;
      if (typeof registry?.list !== 'function' || !Array.isArray(registry.pinnedSessionIds) || !Array.isArray(registry.archivedSessionIds)) throw new Error('workspace-registry-unavailable');
      const workspaceIds=registry.list().filter(project=>project.sessionIds.includes(sessionId)).map(project=>project.id).sort();
      const pinned=registry.pinnedSessionIds.includes(sessionId), archived=registry.archivedSessionIds.includes(sessionId);
      const projection=service('sessionProjectionCache');
      if (projection && typeof projection.requireTable?.()?.get !== 'function') throw new Error('projection-unavailable');
      const hasProjection=projection ? Boolean(await projection.requireTable().get(sessionId)) : null;
      nodes.push({sessionId, log, bytes:await size(dir), fileIdentity:[logStat.dev,logStat.ino,logStat.size,logStat.mtimeMs],
        liveStatus:live?.status ?? null, loaded:Boolean(live || session), seq:live?.session?.seq ?? null, activity,workspaceIds,pinned,archived,hasProjection,lastActivityAt,openTurn});
    }
    const parent=await parentState(row.header,id,rows);
    const activityVersion=hash({row,tree,nodes,parent});
    // The host list reports a running state but does not establish absence of queued
    // questions, jobs, writers or upcoming turns. Preserve that uncertainty.
    const definitelyRunning=row.running === true || nodes.some(n=>n.liveStatus === 'running' || n.openTurn || (Array.isArray(n.activity) && n.activity.length));
    return {id,sessionId:id,kind:row.origin === 'subagent' ? 'dsh-subagent' : 'dsh-session',
      root:path.resolve(persistence.config.root),bytes:nodes.reduce((sum,n)=>sum+n.bytes,0),activityVersion,
      treeIds:ids,running:definitelyRunning ? true : nodes.every(n=>!n.loaded && Array.isArray(n.activity) && n.activity.length===0) ? false : null,lastActivityAt:nodes.every(n=>n.lastActivityAt!==null) ? new Date(Math.max(...nodes.map(n=>n.lastActivityAt))).toISOString() : null,
      ownership:'unknown',parent,row,nodes,reason:definitelyRunning?'running':nodes.every(n=>!n.loaded && Array.isArray(n.activity) && n.activity.length===0)?'cold-activity-observed':'native-activity-unverified'};
  }
  async function verifyOrdinaryReceipt(sessionId, header, proof) {
    try {
      if (!/^session-codex-[a-f0-9]{32}$/i.test(sessionId??'') || !path.isAbsolute(credentialDirectory??'') || !path.isAbsolute(proof?.receiptPath??'')) return false;
      const base=await realpath(credentialDirectory), file=await realpath(proof.receiptPath), rel=path.relative(base,file), parts=rel.split(path.sep);
      if (rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
      const allowed=parts.length===3 && parts[0]==='state' && parts[1]==='requests'
        || parts.length===5 && parts[0]==='state' && parts[1]==='profiles' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(parts[2]) && parts[3]==='requests';
      if (!allowed || !/^[a-f0-9]{64}\.json$/i.test(parts.at(-1))) return false;
      const st=await lstat(proof.receiptPath); if (!st.isFile() || st.isSymbolicLink() || st.size>1024*1024 || !canonicalEqual(file,path.resolve(proof.receiptPath))) return false;
      const value=JSON.parse(await readFile(file,'utf8'));
      if (value.kind!=='create' || value.status!=='accepted' || value.sessionId!==sessionId || value.result?.sessionId!==sessionId || value.result?.accepted!==true || typeof value.requestId!=='string') return false;
      if (path.basename(file)!==`${hash(['create',sessionId,value.requestId])}.json`) return false;
      const stateDir=path.dirname(path.dirname(file));
      if ('session-codex-'+hash([stateDir,header.cwd,value.requestId]).slice(0,32)!==sessionId) return false;
      if (typeof value.instance?.dataRoot!=='string' || !canonicalEqual(await realpath(value.instance.dataRoot),await realpath(path.dirname(service('sessionPersistence').config.root)))) return false;
      return true;
    } catch {return false;}
  }
  async function verifyDirectSubtree(item, rows) {
    const visited=new Set([item.sessionId]); let current=rows.find(row=>row.sessionId===item.sessionId);
    while (current?.header?.origin==='subagent') {
      const parent=current.header.parentSession;
      if (!validId(parent) || visited.has(parent)) return false;
      visited.add(parent); current=rows.find(row=>row.sessionId===parent);
    }
    return Boolean(current && /^session-[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(current.sessionId) && !current.header?.parentSession);
  }
  async function verifyManagedOrphan(item, proof) {
    try {
      if (!/^[a-f0-9-]{36}$/i.test(proof?.deletedTicket??'') || !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(item?.sessionId??'')) return false;
      const persistence=service('sessionPersistence'), root=await realpath(persistence.config.root), data=await realpath(path.dirname(root));
      const base=await realpath(path.join(data,'.futureaide-control','staging')), rel=path.relative(data,base);
      if (!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
      const dir=path.join(base,proof.deletedTicket), stat=await lstat(dir); if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      const deleted=JSON.parse(await readFile(path.join(dir,'ticket.json'),'utf8'));
      if (deleted.ticket!==proof.deletedTicket || deleted.version!==2 || deleted.state!=='deleted' || deleted.sessionId!==proof.rootId || !Array.isArray(deleted.nodes)) return false;
      if (proof.kind==='direct') {
        if (deleted.managed || !(/^session-[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(deleted.sessionId) || deleted.ordinaryEvidence)) return false;
        if (deleted.ordinaryEvidence && !await verifyOrdinaryReceipt(deleted.sessionId,deleted.nodes[0]?.header,deleted.ordinaryEvidence)) return false;
      } else if (!deleted.managed) return false;
      const rows=await list(), child=rows.find(row=>row.sessionId===item.sessionId) ?? (proof.stagedNode ? {header:proof.stagedNode.header,location:{path:path.join(proof.stagedNode.staged,path.basename(proof.stagedNode.log))}} : undefined);
      if (!child || child.header?.origin!=='subagent' || child.header.parentSession!==deleted.sessionId || rows.some(row=>row.sessionId===deleted.sessionId)) return false;
      if (await persistence.stat(deleted.sessionId) || owner.agents?.get(deleted.sessionId) || owner.sessions?.get(deleted.sessionId)) return false;
      const rootNode=deleted.nodes.find(node=>node.sessionId===deleted.sessionId), oldChild=deleted.nodes.find(node=>node.sessionId===item.sessionId);
      if (!rootNode?.header || !oldChild?.header || oldChild.header.parentSession!==deleted.sessionId || hash(oldChild.header)!==hash(child.header)) return false;
      if (typeof child.header.cwd!=='string' || typeof rootNode.header.cwd!=='string') return false;
      if ((await realpath(child.header.cwd)).toLowerCase()!==(await realpath(rootNode.header.cwd)).toLowerCase()) return false;
      if (!child.location?.path) return false; const st=await lstat(child.location.path), old=oldChild.fileIdentity;
      if (!st.isFile() || st.isSymbolicLink() || !Array.isArray(old) || st.size!==old[2] || !/^[a-f0-9]{64}$/i.test(oldChild.contentHash??'')) return false;
      if (createHash('sha256').update(await readFile(child.location.path)).digest('hex')!==oldChild.contentHash) return false;
      return true;
    } catch {return false;}
  }
  async function restoreColdTree(dir, manifest, root) {
    const moved=[]; let indexPhase=false;
    try {
      if (!Array.isArray(manifest.nodes) || !manifest.nodes.length) throw new Error('ticket-invalid');
      for (const node of manifest.nodes) {
        if (!validId(node.sessionId) || node.staged!==path.join(dir,node.sessionId) || path.basename(node.source)!==node.sessionId) throw new Error('ticket-invalid');
        const parent=await realpath(path.dirname(node.source)), rel=path.relative(root,parent);
        if (rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('ticket-source-invalid');
        try {await lstat(node.source); return {restored:false,reason:'source-conflict',ticket:manifest.ticket};} catch(e) {if(e.code!=='ENOENT') throw e;}
        if (owner.agents?.get(node.sessionId) || owner.sessions?.get(node.sessionId)) return {restored:false,reason:'session-loaded',ticket:manifest.ticket};
        const st=await lstat(node.staged); if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('staged-path-invalid');
      }
      for (const node of manifest.nodes) {await rename(node.staged,node.source); moved.push(node);}
      if (manifest.state==='finalizing') {
        indexPhase=true;
        const registry=service('workspaceRegistry'),table=service('sessionProjectionCache')?.requireTable?.();
        for (const node of manifest.nodes) {
          if (node.projection && table && !await table.get(node.sessionId)) await table.put(node.sessionId,node.projection);
          for (const workspaceId of node.workspaceIds) if (!registry.get(workspaceId).sessionIds.includes(node.sessionId)) await registry.get(workspaceId).attachSession(node.sessionId);
          if (node.archived && !registry.archivedSessionIds.includes(node.sessionId)) await registry.archiveSession(node.sessionId);
          if (node.pinned && !registry.pinnedSessionIds.includes(node.sessionId)) await registry.pinSession(node.sessionId);
        }
      }
      manifest.state='restored'; const tmp=path.join(dir,`ticket-${randomUUID()}.tmp`); await writeFile(tmp,JSON.stringify(manifest),{flag:'wx'}); await rename(tmp,path.join(dir,'ticket.json'));
      return {restored:true,ticket:manifest.ticket,sessionId:manifest.sessionId,treeIds:manifest.nodes.map(n=>n.sessionId)};
    } catch(error) {
      if (indexPhase) return {restored:false,reason:'tree-restore-index-incomplete',ticket:manifest.ticket};
      for (const node of moved.reverse()) {try {await rename(node.source,node.staged);} catch {return {restored:false,reason:'tree-restore-rollback-incomplete',ticket:manifest.ticket};}}
      return {restored:false,reason:error.code ?? error.message,ticket:manifest.ticket};
    }
  }
  async function finalizeColdTree(dir, manifest, root) {
    try {
      if (!Array.isArray(manifest.nodes) || !manifest.nodes.length || !['staged','finalizing','deleted'].includes(manifest.state)) throw new Error('ticket-invalid');
      if (manifest.state==='deleted') {
        const rows=await list();
        for (const node of manifest.nodes) {
          if (rows.some(row=>row.sessionId===node.sessionId) || owner.agents?.get(node.sessionId) || owner.sessions?.get(node.sessionId)) return {removed:false,reason:'identity-reappeared',ticket:manifest.ticket};
          try {await lstat(node.source); return {removed:false,reason:'identity-reappeared',ticket:manifest.ticket};} catch(e) {if(e.code!=='ENOENT') throw e;}
        }
        return {removed:true,alreadyRemoved:true,ticket:manifest.ticket,sessionId:manifest.sessionId,treeIds:manifest.nodes.map(n=>n.sessionId),bytes:0};
      }
      if (manifest.ordinaryEvidence && !await verifyOrdinaryReceipt(manifest.sessionId,manifest.nodes[0].header,manifest.ordinaryEvidence)) return {removed:false,reason:'ordinary-create-receipt-changed'};
      if (manifest.orphan && !await verifyManagedOrphan({sessionId:manifest.sessionId},{...manifest.orphan,stagedNode:manifest.nodes[0]})) return {removed:false,reason:'orphan-lineage-changed'};
      if (!Number.isSafeInteger(manifest.eligibleAt) || Date.now()<manifest.eligibleAt) return {removed:false,reason:'grace-not-expired',eligibleAt:manifest.eligibleAt};
      const persistence=service('sessionPersistence'), registry=service('workspaceRegistry'), cache=service('sessionProjectionCache'), table=cache?.requireTable?.();
      if (!registry || typeof registry.ctx?.waterfall!=='function' || (cache && (!table || typeof table.get!=='function' || typeof table.delete!=='function'))) throw new Error('index-unavailable');
      const rows=await list(), ids=new Set(manifest.nodes.map(n=>n.sessionId));
      if (manifest.subtree) {if (!await verifyDirectSubtree({sessionId:manifest.sessionId},[...rows,{sessionId:manifest.sessionId,header:manifest.nodes[0].header}])) return {removed:false,reason:'direct-lineage-changed'}; const parent=await parentState(manifest.nodes[0].header,manifest.sessionId,rows); if(parent?.state!=='present' || parent.referenced || parent.running || parent.version!==manifest.parent?.version) return {removed:false,reason:'parent-reference-changed'};}
      if (rows.some(row=>ids.has(row.sessionId) || ids.has(row.header?.parentSession))) return {removed:false,reason:'new-session-or-child'};
      for (const node of manifest.nodes) {
        if (!validId(node.sessionId) || node.staged!==path.join(dir,node.sessionId) || path.basename(node.source)!==node.sessionId) throw new Error('ticket-invalid');
        const parent=await realpath(path.dirname(node.source)), rel=path.relative(root,parent);
        if (rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('ticket-source-invalid');
        try {await lstat(node.source); return {removed:false,reason:'source-conflict'};} catch(e) {if(e.code!=='ENOENT') throw e;}
        if (owner.agents?.get(node.sessionId) || owner.sessions?.get(node.sessionId)) return {removed:false,reason:'session-loaded'};
        const activity=await registry.ctx.waterfall('workspace/session-activity',{sessionId:node.sessionId},()=>Promise.resolve([]));
        if (!Array.isArray(activity) || activity.length) return {removed:false,reason:'activity-unavailable-or-running'};
        const workspaceIds=registry.list().filter(p=>p.sessionIds.includes(node.sessionId)).map(p=>p.id).sort();
        const pinned=registry.pinnedSessionIds.includes(node.sessionId), archived=registry.archivedSessionIds.includes(node.sessionId);
        if (manifest.state==='staged' && (hash(workspaceIds)!==hash(node.workspaceIds) || pinned!==node.pinned || archived!==node.archived)) return {removed:false,reason:'workspace-index-changed'};
        const projection=table ? await table.get(node.sessionId) : null;
        if ((manifest.state==='staged' || projection) && hash(projection??null)!==hash(node.projection??null)) return {removed:false,reason:'projection-changed'};
        try {
          if (!Array.isArray(node.files) || hash(await cleanupFileManifest(node.staged))!==hash(node.files)) return {removed:false,reason:'staged-data-changed'};
          const st=await lstat(path.join(node.staged,path.basename(node.log))), old=node.fileIdentity;
          if (!st.isFile() || st.isSymbolicLink() || st.dev!==old[0] || st.ino!==old[1] || st.size!==old[2] || st.mtimeMs!==old[3]) return {removed:false,reason:'staged-data-changed'};
        } catch(e) {if(e.code!=='ENOENT' || manifest.state!=='finalizing') throw e;}
      }
      const before=await size(dir); manifest.state='finalizing';
      let tmp=path.join(dir,`ticket-${randomUUID()}.tmp`); await writeFile(tmp,JSON.stringify(manifest),{flag:'wx'}); await rename(tmp,path.join(dir,'ticket.json'));
      for (const node of [...manifest.nodes].reverse()) {
        for (const project of registry.list().filter(p=>p.sessionIds.includes(node.sessionId))) await project.detachSession(node.sessionId);
        if (registry.pinnedSessionIds.includes(node.sessionId)) await registry.unpinSession(node.sessionId);
        if (registry.archivedSessionIds.includes(node.sessionId)) await registry.unarchiveSession(node.sessionId);
        if (table && await table.get(node.sessionId)) await table.delete(node.sessionId);
        await rm(node.staged,{recursive:true,force:true}); persistence.coldLogMemo?.delete(node.sessionId);
        for (const field of ['headers','sessionPaths','invalidSessionPaths','missingSessionPaths']) registry[field]?.delete(node.sessionId);
        service('sessionQuery')?._observations?.cache?.delete(node.sessionId);
        if (await persistence.stat(node.sessionId) || (table && await table.get(node.sessionId))) return {removed:false,reason:'tree-final-verification-failed'};
      }
      manifest.state='deleted'; tmp=path.join(dir,`ticket-${randomUUID()}.tmp`); await writeFile(tmp,JSON.stringify(manifest),{flag:'wx'}); await rename(tmp,path.join(dir,'ticket.json'));
      return {removed:true,ticket:manifest.ticket,sessionId:manifest.sessionId,treeIds:manifest.nodes.map(n=>n.sessionId),bytes:Math.max(0,before-await size(dir))};
    } catch(error) {return {removed:false,reason:error.code ?? error.message,ticket:manifest.ticket};}
  }
  async function stageColdTree(initial, token, context = {}) {
    const persistence=service('sessionPersistence'), root=await realpath(initial.root), data=await realpath(path.dirname(root));
    const basePath=path.join(data,'.futureaide-control','staging'); await mkdir(basePath,{recursive:true});
    const base=await realpath(basePath), relBase=path.relative(data,base);
    if (!relBase || relBase==='..' || relBase.startsWith(`..${path.sep}`) || path.isAbsolute(relBase)) throw new Error('staging-path-invalid');
    const dir=path.join(base,token), leases=[], moved=[]; let manifest; const timing={started:performance.now(),moves:[]};
    try {
      await mkdir(dir);
      for (const node of [...initial.nodes].sort((a,b)=>a.sessionId.localeCompare(b.sessionId))) {
        if (node.loaded || !Array.isArray(node.activity) || node.activity.length) throw new Error('tree-not-cold');
        const source=await realpath(path.dirname(node.log)), rel=path.relative(root,source);
        if (!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || path.basename(source)!==node.sessionId) throw new Error('session-path-invalid');
        const row=(await list()).find(x=>x.sessionId===node.sessionId); if (!row) throw new Error('tree-node-unavailable');
        leases.push(await persistence.acquireLease(node.sessionId,row.header.cwd,source));
      }
      const again=await inspectId(initial.sessionId,await list());
      if (again.activityVersion!==initial.activityVersion || again.running!==false || hash(again.treeIds)!==hash(initial.treeIds)) throw new Error('tree-changed-before-stage');
      timing.lastVerified=performance.now();
      const cache=service('sessionProjectionCache'), table=cache?.requireTable?.();
      const nodes=[];
      const rows=await list();
      for (const node of initial.nodes) { const row=rows.find(x=>x.sessionId===node.sessionId); if(!row?.header) throw new Error('tree-node-header-unavailable'); nodes.push({...node,header:row.header,files:await cleanupFileManifest(path.dirname(node.log)),contentHash:createHash('sha256').update(await readFile(node.log)).digest('hex'),source:path.dirname(node.log),staged:path.join(dir,node.sessionId),projection:table ? await table.get(node.sessionId) ?? null : null}); }
      const verified=await inspectId(initial.sessionId,await list()); if(verified.running!==false || verified.activityVersion!==initial.activityVersion) throw new Error('tree-changed-before-stage'); timing.lastVerified=performance.now();
      manifest={version:2,ticket:token,sessionId:initial.sessionId,activityVersion:initial.activityVersion,nodes,managed:context.proof===MANAGED_CLEANUP_PROOF ? context.managed : null,orphan:context.orphanEvidence ?? null,subtree:initial.row.header?.origin==='subagent' && !context.orphanEvidence,parent:initial.parent,ordinaryEvidence:context.ordinaryEvidence??null,
        createdAt:new Date().toISOString(),eligibleAt:Date.now()+graceMs,state:'planned'};
      await writeFile(path.join(dir,'ticket.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
      for (const node of [...nodes].reverse()) {const submitted=performance.now(); await rename(node.source,node.staged); timing.moves.push({sessionId:node.sessionId,submitted,effective:performance.now()}); moved.push(node);}
      manifest.state='staged'; const temp=path.join(dir,`ticket-${randomUUID()}.tmp`); await writeFile(temp,JSON.stringify(manifest),{flag:'wx'}); await rename(temp,path.join(dir,'ticket.json'));
      timing.completed=performance.now(); return {removed:false,staged:true,ticket:token,eligibleAt:manifest.eligibleAt,bytes:0,reason:'awaiting-grace-and-recheck',timing};
    } catch(error) {
      for (const node of moved.reverse()) {try {await rename(node.staged,node.source);} catch {return {removed:false,staged:true,ticket:token,reason:'tree-rollback-incomplete'};}}
      return {removed:false,reason:error.code ?? error.message,ticket:token};
    } finally {for (const lease of leases.reverse()) await lease.release();}
  }
  return {
    async inventory() {
      try {
        const rows=await list(), items=[];
        for (const row of rows) {
          if (!validId(row.sessionId)) return {items,complete:false,reason:'invalid-session-id'};
          try { items.push(await inspectId(row.sessionId,rows)); }
          catch (error) { items.push({id:row.sessionId,sessionId:row.sessionId,kind:'dsh-session',root:path.resolve(service('sessionPersistence').config.root),running:null,reason:error.message}); }
        }
        return {items,complete:false,reason:'native-subagent-and-orphan-coverage-unverified'};
      } catch(error) {return {items:[],complete:false,reason:error.message};}
    },
    async inspect(item) {try{return await inspectId(item?.sessionId ?? item?.id,await list());}catch(error){return {available:false,reason:error.message};}},
    async history(item) {
      try {
        const before=await inspectId(item?.sessionId??item?.id,await list());
        if (before.running!==false || before.activityVersion!==item?.activityVersion) return {complete:false,reason:'history-identity-or-activity-changed'};
        const persistence=service('sessionPersistence'), events=[];
        for (const node of before.nodes) {
          const stored=await persistence.readStoredLog(node.log,node.sessionId);
          if (!Array.isArray(stored?.events) || stored.tornTruncateTo!==undefined || (stored.recoveredTail?.length??0)>0 || stored.events.some(e=>!Number.isSafeInteger(e.seq))) return {complete:false,reason:'history-incomplete'};
          for (const event of stored.events) events.push({sessionId:node.sessionId,sourceId:`${node.sessionId}:${event.seq}`,event});
        }
        const after=await inspectId(item.sessionId??item.id,await list());
        if (after.running!==false || after.activityVersion!==before.activityVersion) return {complete:false,reason:'history-activity-changed'};
        return {complete:true,sessionId:before.sessionId,treeIds:before.treeIds,activityVersion:before.activityVersion,events};
      } catch(error) {return {complete:false,reason:error.code??error.message};}
    },
    async remove(item, context) {
      // Only a specific approved, ordinary cold root can enter reversible staging.
      // No final deletion or index mutation is performed by this preliminary path.
      const managed=context?.proof === MANAGED_CLEANUP_PROOF;
      const ordinary=item?.ownership==='direct' && /^session-codex-[a-f0-9]{32}$/i.test(item?.sessionId??'');
      const orphan=['orphan','direct-orphan'].includes(item?.ownership);
      const subtree=item?.ownership==='direct-subtree';
      if ((!managed && !orphan && !subtree && (item?.ownership !== 'direct' || (!ordinary && !/^session-[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(item?.sessionId ?? '')))) || (managed && !/^session-codex-[a-f0-9]{32}$/i.test(item?.sessionId ?? '')) || ((orphan || subtree) && !/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(item?.sessionId??'')) || typeof item?.activityVersion !== 'string')
        return {removed:false,reason:'direct-identity-or-authorization-unverified'};
      const operationToken=context?.operationToken;
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(operationToken ?? '')) return {removed:false,reason:'operation-token-required'};
      let lease, ticketDir, source, staged, moved=false; const timing={started:performance.now()};
      try {
        if (orphan && !await verifyManagedOrphan(item,context?.orphanEvidence)) return {removed:false,reason:'orphan-lineage-unverified'};
        if (subtree && !await verifyDirectSubtree(item,await list())) return {removed:false,reason:'direct-lineage-unverified'};
        const persistence=service('sessionPersistence');
        const existingDir=path.join(path.dirname(path.resolve(persistence.config.root)),'.futureaide-control','staging',operationToken);
        try {
          const info=await lstat(existingDir);
          if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ticket-path-invalid');
          const existing=JSON.parse(await readFile(path.join(existingDir,'ticket.json'),'utf8'));
          if (existing.sessionId!==item.sessionId || existing.activityVersion!==item.activityVersion || existing.ticket!==operationToken) return {removed:false,reason:'operation-token-conflict',ticket:operationToken};
          let stagedExists=false; try {stagedExists=(await lstat(path.join(existingDir,item.sessionId))).isDirectory();} catch(e) {if(e.code!=='ENOENT') throw e;}
          if (existing.state==='deleted') return {removed:true,ticket:operationToken,alreadyRemoved:true,bytes:0};
          if (stagedExists) return {removed:false,staged:true,ticket:operationToken,eligibleAt:existing.eligibleAt,reason:'awaiting-grace-and-recheck',bytes:0};
          return {removed:false,reason:'ticket-recovery-required',ticket:operationToken};
        } catch(error) {if (error.code!=='ENOENT') throw error;}
        const initial=await inspectId(item.sessionId,await list());
        if (ordinary && !await verifyOrdinaryReceipt(item.sessionId,initial.row.header,context?.ordinaryEvidence)) return {removed:false,reason:'ordinary-create-receipt-unverified'};
        if (initial.activityVersion !== item.activityVersion || initial.running !== false || (!orphan && !subtree && initial.row.header?.origin === 'subagent') || (subtree && (initial.parent?.state!=='present' || initial.parent.referenced || initial.parent.running)))
          return {removed:false,reason:'session-changed-or-not-cold'};
        if (typeof persistence.acquireLease !== 'function') return {removed:false,reason:'session-lease-unavailable'};
        if (initial.treeIds.length>1) return await stageColdTree(initial,operationToken,context);
        source=path.dirname(initial.nodes[0].log);
        const root=await realpath(initial.root), target=await realpath(source), rel=path.relative(root,target);
        if (!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || path.basename(target)!==item.sessionId)
          return {removed:false,reason:'session-path-invalid'};
        lease=await persistence.acquireLease(item.sessionId,initial.row.header.cwd,target); timing.leaseAcquired=performance.now();
        const final=await inspectId(item.sessionId,await list());
        if (ordinary && !await verifyOrdinaryReceipt(item.sessionId,final.row.header,context?.ordinaryEvidence)) return {removed:false,reason:'ordinary-create-receipt-changed'};
        if (final.activityVersion !== initial.activityVersion || final.running !== false || final.treeIds.length !== 1)
          return {removed:false,reason:'session-changed-before-stage'};
        timing.lastVerified=performance.now();
        const base=path.join(path.dirname(root),'.futureaide-control','staging');
        await mkdir(base,{recursive:true});
        const baseReal=await realpath(base), dataRoot=await realpath(path.dirname(root));
        const baseRel=path.relative(dataRoot,baseReal);
        if (!baseRel || baseRel==='..' || baseRel.startsWith(`..${path.sep}`) || path.isAbsolute(baseRel)) throw new Error('staging-path-invalid');
        const ticket=operationToken; ticketDir=path.join(baseReal,ticket);
        try {await mkdir(ticketDir);} catch(error) {
          if (error.code!=='EEXIST') throw error;
          const info=await lstat(ticketDir); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ticket-path-invalid');
          const existing=JSON.parse(await readFile(path.join(ticketDir,'ticket.json'),'utf8'));
          if (existing.sessionId!==item.sessionId || existing.activityVersion!==item.activityVersion || existing.ticket!==ticket) return {removed:false,reason:'operation-token-conflict',ticket};
          return {removed:false,staged:existing.state==='staged',ticket,eligibleAt:existing.eligibleAt,reason:existing.state==='staged'?'awaiting-grace-and-recheck':'ticket-recovery-required',bytes:0};
        }
        staged=path.join(ticketDir,item.sessionId);
        const cache=service('sessionProjectionCache');
        const projection=cache ? await cache.requireTable().get(item.sessionId) : null;
        const files=await cleanupFileManifest(target);
        const verified=await inspectId(item.sessionId,await list()); if(verified.running!==false || verified.activityVersion!==initial.activityVersion) throw new Error('session-changed-before-stage'); timing.lastVerified=performance.now();
        const manifest={version:1,ticket,sessionId:item.sessionId,source:target,staged,activityVersion:item.activityVersion,files,
          header:initial.row.header, node:initial.nodes[0], projection:projection ?? null, managed:managed ? context.managed : null, orphan:orphan ? context.orphanEvidence : null, subtree, parent:initial.parent, ordinaryEvidence:ordinary ? context.ordinaryEvidence : null,
          createdAt:new Date().toISOString(),eligibleAt:Date.now()+graceMs,state:'planned'};
        await writeFile(path.join(ticketDir,'ticket.json'),JSON.stringify(manifest),{flag:'wx',mode:0o600});
        timing.moveSubmitted=performance.now(); await rename(target,staged); moved=true; timing.moveEffective=performance.now();
        manifest.state='staged'; await writeFile(path.join(ticketDir,'ticket.json'),JSON.stringify(manifest),{mode:0o600}); timing.completed=performance.now();
        return {removed:false,staged:true,ticket,eligibleAt:manifest.eligibleAt,reason:'awaiting-grace-and-recheck',bytes:0,timing};
      } catch(error) {
        if (moved) return {removed:false,staged:true,reason:'staging-interrupted',ticket:ticketDir&&path.basename(ticketDir),error:error.code ?? error.message};
        return {removed:false,reason:error.code ?? error.message};
      } finally {await lease?.release();}
    },
    async restore(input) {
      const ticket=input?.ticket;
      if (!/^[a-f0-9-]{36}$/i.test(ticket ?? '')) return {restored:false,reason:'invalid-ticket'};
      try {
        const persistence=service('sessionPersistence'), root=await realpath(persistence.config.root);
        const base=path.join(path.dirname(root),'.futureaide-control','staging'), baseReal=await realpath(base);
        const dataRoot=await realpath(path.dirname(root)), rel=path.relative(dataRoot,baseReal);
        if (!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('staging-path-invalid');
        const dir=path.join(baseReal,ticket), info=await lstat(dir);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('ticket-path-invalid');
        const manifest=JSON.parse(await readFile(path.join(dir,'ticket.json'),'utf8'));
        if (manifest.version===2 && manifest.ticket===ticket) {if (manifest.managed && input.proof!==MANAGED_CLEANUP_PROOF) return {restored:false,reason:'managed-cleanup-required',ticket}; return await restoreColdTree(dir,manifest,root);}
        if (manifest.version!==1 || manifest.ticket!==ticket || !validId(manifest.sessionId) || manifest.staged!==path.join(dir,manifest.sessionId)) throw new Error('ticket-invalid');
        if (manifest.managed && input.proof!==MANAGED_CLEANUP_PROOF) return {restored:false,reason:'managed-cleanup-required',ticket};
        const source=manifest.source, sourceParent=await realpath(path.dirname(source));
        const sourceRel=path.relative(root,sourceParent);
        if (sourceRel==='..' || sourceRel.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRel) || path.basename(source)!==manifest.sessionId) throw new Error('ticket-source-invalid');
        try {await lstat(source); return {restored:false,reason:'source-conflict',ticket};} catch(e) {if(e.code!=='ENOENT') throw e;}
        if (owner.agents?.get(manifest.sessionId) || owner.sessions?.get(manifest.sessionId)) return {restored:false,reason:'session-loaded',ticket};
        const cache=service('sessionProjectionCache'), table=cache?.requireTable?.();
        if (manifest.projection && (!table || typeof table.get !== 'function' || typeof table.put !== 'function')) return {restored:false,reason:'projection-unavailable',ticket};
        const current=table ? await table.get(manifest.sessionId) : null;
        if (current && hash(current)!==hash(manifest.projection ?? null)) return {restored:false,reason:'projection-conflict',ticket};
        const stagedStat=await lstat(manifest.staged); if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) throw new Error('staged-path-invalid');
        await rename(manifest.staged,source);
        if (table && manifest.projection && !current) await table.put(manifest.sessionId,manifest.projection);
        if (manifest.state==='finalizing') {
          const registry=service('workspaceRegistry');
          for (const workspaceId of manifest.node.workspaceIds) await registry.get(workspaceId).attachSession(manifest.sessionId);
          if (manifest.node.archived && !registry.archivedSessionIds.includes(manifest.sessionId)) await registry.archiveSession(manifest.sessionId);
          if (manifest.node.pinned && !registry.pinnedSessionIds.includes(manifest.sessionId)) await registry.pinSession(manifest.sessionId);
        }
        manifest.state='restored'; await writeFile(path.join(dir,'ticket.json'),JSON.stringify(manifest),{mode:0o600});
        return {restored:true,ticket,sessionId:manifest.sessionId};
      } catch(error) {return {restored:false,reason:error.code ?? error.message,ticket};}
    },
    async lookupManaged(input) {
      if (input?.proof!==MANAGED_CLEANUP_PROOF || !/^[a-f0-9-]{36}$/i.test(input.ticket??'')) return null;
      try {
        const root=await realpath(service('sessionPersistence').config.root), data=await realpath(path.dirname(root));
        const base=await realpath(path.join(data,'.futureaide-control','staging')), rel=path.relative(data,base);
        if (!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
        const dir=path.join(base,input.ticket), stat=await lstat(dir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
        const manifest=JSON.parse(await readFile(path.join(dir,'ticket.json'),'utf8'));
        if (manifest.ticket!==input.ticket || !manifest.managed) return null;
        if (manifest.version===1) {
          if (manifest.staged!==path.join(dir,manifest.sessionId)) return null;
          if (manifest.state!=='deleted') {const staged=await lstat(manifest.staged); if (!staged.isDirectory() || staged.isSymbolicLink()) return null;}
        } else if (manifest.version===2) {
          if (!Array.isArray(manifest.nodes) || !manifest.nodes.some(n=>n.sessionId===manifest.sessionId)) return null;
          if (manifest.state!=='deleted') for (const node of manifest.nodes) {if(node.staged!==path.join(dir,node.sessionId))return null; const staged=await lstat(node.staged); if(!staged.isDirectory() || staged.isSymbolicLink())return null;}
        } else return null;
        return {ticket:manifest.ticket,sessionId:manifest.sessionId,managed:manifest.managed,eligibleAt:manifest.eligibleAt,state:manifest.state};
      } catch {return null;}
    },
    async finalize(input) {
      const ticket=input?.ticket;
      if (!/^[a-f0-9-]{36}$/i.test(ticket ?? '')) return {removed:false,reason:'invalid-ticket'};
      try {
        const persistence=service('sessionPersistence'), root=await realpath(persistence.config.root);
        const base=await realpath(path.join(path.dirname(root),'.futureaide-control','staging'));
        const dataRoot=await realpath(path.dirname(root)), rel=path.relative(dataRoot,base);
        if (!rel || rel==='..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('staging-path-invalid');
        const dir=path.join(base,ticket), ds=await lstat(dir);
        if (!ds.isDirectory() || ds.isSymbolicLink()) throw new Error('ticket-path-invalid');
        const manifestPath=path.join(dir,'ticket.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
        if (manifest.version===2 && manifest.ticket===ticket) {if (manifest.managed && input.proof!==MANAGED_CLEANUP_PROOF) return {removed:false,reason:'managed-cleanup-required',ticket}; return await finalizeColdTree(dir,manifest,root);}
        if (manifest.version!==1 || manifest.ticket!==ticket || !((manifest.managed || manifest.ordinaryEvidence) ? /^session-codex-[a-f0-9]{32}$/i : (manifest.orphan || manifest.subtree) ? /^[a-f0-9]{8}-[a-f0-9-]{27}$/i : /^session-[a-f0-9]{8}-[a-f0-9-]{27}$/i).test(manifest.sessionId ?? '') || manifest.staged!==path.join(dir,manifest.sessionId)) throw new Error('ticket-invalid');
        if (manifest.managed && input.proof!==MANAGED_CLEANUP_PROOF) return {removed:false,reason:'managed-cleanup-required',ticket};
        const alreadyDeleted=manifest.state==='deleted';
        if (!['staged','finalizing','deleted'].includes(manifest.state)) return {removed:false,reason:'ticket-not-staged'};
        if (manifest.ordinaryEvidence && !await verifyOrdinaryReceipt(manifest.sessionId,manifest.header,manifest.ordinaryEvidence)) return {removed:false,reason:'ordinary-create-receipt-changed'};
        if (manifest.orphan && !await verifyManagedOrphan({sessionId:manifest.sessionId},{...manifest.orphan,stagedNode:{...manifest.node,header:manifest.header,staged:manifest.staged}})) return {removed:false,reason:'orphan-lineage-changed'};
        if (!alreadyDeleted && (!Number.isSafeInteger(manifest.eligibleAt) || Date.now()<manifest.eligibleAt)) return {removed:false,reason:'grace-not-expired',eligibleAt:manifest.eligibleAt};
        const sourceParent=await realpath(path.dirname(manifest.source)), sourceRel=path.relative(root,sourceParent);
        if (sourceRel==='..' || sourceRel.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRel) || path.basename(manifest.source)!==manifest.sessionId) throw new Error('ticket-source-invalid');
        try {await lstat(manifest.source); return {removed:false,reason:'source-conflict'};} catch(e) {if(e.code!=='ENOENT') throw e;}
        if (owner.agents?.get(manifest.sessionId) || owner.sessions?.get(manifest.sessionId)) return {removed:false,reason:'session-loaded'};
        if (alreadyDeleted) {const rows=await list(); if(rows.some(row=>row.sessionId===manifest.sessionId)) return {removed:false,reason:'identity-reappeared'}; return {removed:true,alreadyRemoved:true,ticket,sessionId:manifest.sessionId,bytes:0};}
        const rows=await list();
        if (manifest.subtree) {if (!await verifyDirectSubtree({sessionId:manifest.sessionId},[...rows,{sessionId:manifest.sessionId,header:manifest.header}])) return {removed:false,reason:'direct-lineage-changed'}; const parent=await parentState(manifest.header,manifest.sessionId,rows); if(parent?.state!=='present' || parent.referenced || parent.running || parent.version!==manifest.parent?.version) return {removed:false,reason:'parent-reference-changed'};}
        if (rows.some(row=>row.sessionId===manifest.sessionId || row.header?.parentSession===manifest.sessionId)) return {removed:false,reason:'new-session-or-child'};
        const registry=service('workspaceRegistry');
        if (typeof registry?.list !== 'function' || typeof registry?.ctx?.waterfall !== 'function') return {removed:false,reason:'activity-unavailable'};
        const activity=await registry.ctx.waterfall('workspace/session-activity',{sessionId:manifest.sessionId},()=>Promise.resolve([]));
        if (!Array.isArray(activity) || activity.length) return {removed:false,reason:'activity-unavailable-or-running'};
        const workspaceIds=registry.list().filter(project=>project.sessionIds.includes(manifest.sessionId)).map(project=>project.id).sort();
        const pinned=registry.pinnedSessionIds.includes(manifest.sessionId), archived=registry.archivedSessionIds.includes(manifest.sessionId);
        if (manifest.state==='staged' && (hash(workspaceIds)!==hash(manifest.node.workspaceIds) || pinned!==manifest.node.pinned || archived!==manifest.node.archived)) return {removed:false,reason:'workspace-index-changed'};
        const cache=service('sessionProjectionCache'), table=cache?.requireTable?.();
        if (cache && (!table || typeof table.get !== 'function' || typeof table.delete !== 'function' || typeof table.put !== 'function')) return {removed:false,reason:'projection-unavailable'};
        const current=table ? await table.get(manifest.sessionId) : null;
        if ((manifest.state==='staged' || current) && hash(current ?? null)!==hash(manifest.projection ?? null)) return {removed:false,reason:'projection-changed'};
        let stageExists=true; try { const stagedStat=await lstat(manifest.staged); if (!stagedStat.isDirectory() || stagedStat.isSymbolicLink()) throw new Error('staged-path-invalid'); }
        catch(e) {if(e.code==='ENOENT') stageExists=false; else throw e;}
        if (!stageExists && manifest.state!=='finalizing') return {removed:false,reason:'staged-data-missing'};
        if (stageExists) {
          if (!Array.isArray(manifest.files) || hash(await cleanupFileManifest(manifest.staged))!==hash(manifest.files)) return {removed:false,reason:'staged-data-changed'};
          const log=path.join(manifest.staged,path.basename(manifest.node.log)); const st=await lstat(log);
          const old=manifest.node.fileIdentity;
          if (!st.isFile() || st.isSymbolicLink() || st.dev!==old[0] || st.ino!==old[1] || st.size!==old[2] || st.mtimeMs!==old[3]) return {removed:false,reason:'staged-data-changed'};
        }
        const bytesBefore=await size(dir);
        manifest.state='finalizing';
        const temp=path.join(dir,`ticket-${randomUUID()}.tmp`); await writeFile(temp,JSON.stringify(manifest),{flag:'wx',mode:0o600}); await rename(temp,manifestPath);
        {
          for (const workspaceId of workspaceIds) {const project=registry.get(workspaceId); if (!project || typeof project.detachSession!=='function') throw new Error('workspace-unavailable'); await project.detachSession(manifest.sessionId);}
          if (pinned) await registry.unpinSession(manifest.sessionId);
          if (archived) await registry.unarchiveSession(manifest.sessionId);
        }
        if (table && current) await table.delete(manifest.sessionId);
        if (stageExists) await rm(manifest.staged,{recursive:true,force:false});
        persistence.coldLogMemo?.delete(manifest.sessionId);
        for (const field of ['headers','sessionPaths','invalidSessionPaths','missingSessionPaths']) registry[field]?.delete(manifest.sessionId);
        service('sessionQuery')?._observations?.cache?.delete(manifest.sessionId);
        if (await persistence.stat(manifest.sessionId) || (table && await table.get(manifest.sessionId))) return {removed:false,reason:'final-verification-failed'};
        manifest.state='deleted'; const done=path.join(dir,`ticket-${randomUUID()}.tmp`); await writeFile(done,JSON.stringify(manifest),{flag:'wx',mode:0o600}); await rename(done,manifestPath);
        const bytesAfter=await size(dir);
        return {removed:true,ticket,sessionId:manifest.sessionId,bytes:Math.max(0,bytesBefore-bytesAfter)};
      } catch(error) {return {removed:false,reason:error.code ?? error.message,ticket};}
    },
    async tempUsage() {return {inUse:null,reason:'native-reference-coverage-unverified'};},
  };
}













// The report and question contract shared by every surface. This plugin may import
// only Node builtins, so the text is kept here literally; tests/report-contract.test.mjs
// asserts it is word for word the copy in src/report-contract.mjs.
export const FINAL_REPORT_CONTRACT = 'Write a final report for a controlling agent that will spot-check it, not re-read your work. '
  + 'Use these labelled parts in the language of the task, and leave out a part only when it is empty. '
  + 'Result: done, partly done or blocked, in one sentence. '
  + 'Changes: file:line and what changed, one line each, at most 10; give the total if there are more. '
  + 'Verified: the commands you ran with their numbers, and whether the check fails without the change. '
  + 'Not verified: what you could not check; never present an assumption as a result. '
  + 'Decisions: only choices the controlling agent must make. '
  + 'Stay under about 300 words. Do not restate the task or narrate your process. '
  + 'Put long material in a file and name it. '
  + 'If you delegated work, send one summary of the combined result.';

export const QUESTION_CONTRACT = 'State the decision you need, the options and your recommendation in a few lines, '
  + 'so it can be answered without reading your work.';
/**
 * Read one stored session as { header, events }. DSH 0.2.2 removed
 * sessionController.inspect in favour of the session query service. Every read goes
 * through here and both are accepted, because the desktop app updates on its own schedule.
 * @param {(name: string) => object} get Host service lookup.
 * @param {string} sessionId Live or persisted session id.
 */
async function readStoredSession(get, sessionId) {
  const controller = get('sessionController');
  if (typeof controller?.inspect === 'function') {
    const inspected = await controller.inspect(sessionId);
    return { header: inspected?.meta ?? inspected?.header, events: inspected?.events };
  }
  const query = get('sessionQuery');
  if (typeof query?.readSession !== 'function') reject('managed-session-inspection-unavailable');
  const stored = await query.readSession(sessionId);
  return { header: stored?.session, events: stored?.events };
}

/** Read the durable descendant catalog; diagnostics never authorize cleanup. */
export async function readManagedTree(subagents, agents, root, changesBySession = {}) {
  if (typeof subagents?.listDescendants !== 'function') throw new Error('managed-tree-unavailable');
  const rows = await subagents.listDescendants(root.id);
  if (!Array.isArray(rows)) throw new Error('managed-tree-unavailable');
  const known = new Set([root.id]);
  const nodes = [{ sessionId: root.id, parentSessionId: null, name: null,
    status: root.status, activity: root.status, changes: structuredClone(changesBySession[root.id] ?? []),
    coverage: { complete: false, source: 'agent-file-tool-results' } }];
  for (const row of rows) {
    if (row.kind !== 'child' || typeof row.id !== 'string' || !known.has(row.parentId) || known.has(row.id)) throw new Error('managed-tree-unverified');
    known.add(row.id);
    const agent = agents.get(row.id);
    nodes.push({ sessionId: row.id, parentSessionId: row.parentId, name: row.label ?? null, mode: row.mode,
      status: agent?.status ?? 'unloaded', activity: agent?.status ?? row.activity ?? 'unknown',
      changes: structuredClone(changesBySession[row.id] ?? []), coverage: { complete: false, source: 'agent-file-tool-results' } });
  }
  return nodes;
}

/**
 * DSH SDK's completion barrier, scoped to the exact live root and task. DSH 0.2.2-rc.3
 * renamed subagents.waitForChildren to waitForTreeWork with the same contract (true
 * means work was joined and the root must be rechecked); both are accepted.
 */
export async function waitManagedTree(subagents, agents, root, isCurrent) {
  const waitForTree = subagents?.waitForTreeWork ?? subagents?.waitForChildren;
  if (typeof waitForTree !== 'function' || typeof root.whenIdle !== 'function') throw new Error('managed-tree-unavailable');
  while (isCurrent()) {
    if (agents.get(root.id) !== root) throw new Error('managed-handle-unavailable');
    await root.whenIdle();
    const seq = root.session.seq;
    const joined = await waitForTree.call(subagents, root);
    if (!isCurrent()) return null;
    if (agents.get(root.id) !== root) throw new Error('managed-handle-unavailable');
    if (!joined && root.status === 'idle' && root.session.seq === seq) return seq;
  }
  return null;
}

export const name = 'futureaide-control-host';
// Tools belong to each Agent's composition; the bridge also mounts at host scope.
export const inject = ['connection', 'webServer', 'agents', 'sessions'];
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/;
export const MANAGED_METHODS = ['managedCreate', 'managedBeginTask', 'managedStatus', 'managedSelectModel',
  'managedPromptV2', 'managedPromptReceipt', 'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy', 'managedCleanupInspect', 'managedCleanupStage', 'managedCleanupFinalize', 'managedCleanupRestore'];

// DSH's own question tool opens a prompt in the DSH window, which the chat that
// dispatched the task never sees: the agent waits and the caller is never asked.
// Managed agents ask through ask_parent instead.
const ASK_USER_TOOL_NAMES = Object.freeze(['ask_user_question', 'request_user_input']);
export const ROOT_QUESTION_REFUSAL = 'The user does not see this question. Use ask_parent for a decision you need.';
export const CHILD_QUESTION_REFUSAL = 'The user does not see this question. Send it to your parent with send_message.';

/**
 * Every DSH internal this plugin borrows, taken from the calls in this file rather
 * than from memory: DSH 0.2.2 renamed one of them and only a real host showed it.
 * `scope` marks a service that belongs to an agent's composition instead of the
 * bridge context, so a check without a live agent can skip it. `choices` lists
 * implementations that are interchangeable, and only losing all of them counts.
 */
export const DSH_INTERNALS = Object.freeze([
  { service: 'sessionController', members: ['agents.composeAgent'] },
  { choices: [{ service: 'sessionController', member: 'resolveAgent' }, { service: 'apiProxy', member: 'sessions.list' }] },
  // 0.2.2 dropped sessionController.inspect in favour of the query service.
  { choices: [{ service: 'sessionController', member: 'inspect' }, { service: 'sessionQuery', member: 'readSession' }] },
  { service: 'sessionQuery', members: ['_observations.cache.delete', '_observations.cache.has'] },
  // Session-local model selection validates the exact provider/model and effort
  // through the same live registry the native session command uses. It is optional
  // for compatibility because only the new explicit-selection method reads it.
  { service: 'llm', members: ['listProviders', 'listModels', 'resolveCallConfig'], optional: true },
  { service: 'sessionPersistence', members: ['resolveCurrentLog', 'stat', 'config.root'] },
  { service: 'workspaceRegistry', members: ['resolveByPath', 'create', 'get', 'list'] },
  { service: 'subagents', members: ['listDescendants', 'drainDescendants'] },
  // 0.2.2-rc.3 renamed waitForChildren to waitForTreeWork with the same contract.
  { choices: [{ service: 'subagents', member: 'waitForTreeWork' }, { service: 'subagents', member: 'waitForChildren' }] },
  { service: 'agentDefaultModel', members: ['currentSelection'], optional: true },
  { service: 'sessionProjectionCache', members: ['requireTable'], optional: true },
  { service: 'spillStore', optional: true },
  { service: 'tools', members: ['register', 'guard'], scope: 'agent' },
  { service: 'agentPresets', members: ['generationFor'], scope: 'agent' },
  { service: 'loader', members: ['unwrapExports'], scope: 'agent' },
  { service: 'sessionProjections', members: ['snapshot'], scope: 'agent', optional: true },
  { service: 'sandboxPolicy', members: ['resolve'], scope: 'agent', optional: true },
  { service: 'sandbox', optional: true, scope: 'agent' },
  { service: 'approval', members: ['overrideOf'], scope: 'agent', optional: true },
  { service: 'permissionPresets', members: ['current'], scope: 'agent', optional: true },
  { service: 'planMode', optional: true, scope: 'agent' },
  { service: 'systemPrompt', optional: true, scope: 'agent' },
]);

const memberOf = (value, path) => path.split('.').reduce((current, key) => current?.[key], value);

/**
 * Check the catalogue against a live host. It reports names, not behaviour: a host
 * that renames an internal should say so at ping time instead of failing a task
 * later.
 * @param {(name: string) => object} get Host service lookup.
 * @param {(name: string) => object} [agentGet] Agent-scope lookup, when an agent exists.
 * @returns {{missing: string[]}} What this host does not provide.
 */
export function checkHostCompatibility(get, agentGet) {
  const missing = [];
  const read = (service, scope) => {
    const lookup = scope === 'agent' ? agentGet : get;
    if (typeof lookup !== 'function') return undefined;
    try { return lookup(service); } catch { return undefined; }
  };
  for (const entry of DSH_INTERNALS) {
    // An agent-scope service cannot be judged without an agent to ask.
    if (entry.scope === 'agent' && typeof agentGet !== 'function') continue;
    if (entry.choices) {
      const present = entry.choices.some(choice => memberOf(read(choice.service, entry.scope), choice.member) !== undefined);
      if (!present) missing.push(entry.choices.map(choice => `${choice.service}.${choice.member}`).join(' or '));
      continue;
    }
    // An optional service is a bonus: its absence or partial shape changes no answer.
    if (entry.optional) continue;
    const value = read(entry.service, entry.scope);
    if (entry.members) {
      for (const member of entry.members) if (memberOf(value, member) === undefined) missing.push(`${entry.service}.${member}`);
      continue;
    }
    if (value === undefined || value === null) missing.push(entry.service);
  }
  return { missing };
}

function managedId(value) {
  if (!ID.test(value ?? '')) reject('invalid-managed-identity');
  return value;
}

function canonicalEqual(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function sessionCursor(session) {
  return Number.isSafeInteger(session?.seq) && session.seq >= 0
    ? session.seq - 1 : session?.events?.at(-1)?.seq ?? -1;
}

/** Private records are separate from the project and never become model-facing files. */
function managedFileStore(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) reject('managed-storage-required');
  const filename = key => path.join(directory, `${key}.json`);
  return {
    async read(key) {
      try { return JSON.parse(await readFile(filename(key), 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
    },
    async write(key, record) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      // The host is the sole writer; direct writes avoid moving files on user volumes.
      await writeFile(filename(key), JSON.stringify(record), { mode: 0o600 });
    },
    async remove(key) { await rm(filename(key), { force: true }); },
  };
}

/**
 * Own ordinary DSH agents from creation through disposal. The small persistence
 * adapter below targets the JSONL, workspace and projection services verified in
 * DSH 0.2.1-rc.3; unsupported storage refuses cleanup instead of archiving it.
 */
export function createManagedHost(ctx, { stateDirectory, store, removeDirectory = rm, installDelegation: testInstallDelegation,
  defaultModelOnly = false, feedbackNode, feedbackConfigFile, cleanup } = {}) {
  const root = ctx.root ?? ctx;
  const runtimeKey = Symbol.for('futureaide-control.managed-runtimes');
  const runtimes = root[runtimeKey] ??= new Map();
  const directoryKey = typeof stateDirectory === 'string'
    ? (process.platform === 'win32' ? path.resolve(stateDirectory).toLowerCase() : path.resolve(stateDirectory)) : store;
  let runtime = runtimes.get(directoryKey);
  if (!runtime) {
    runtime = { records: new Map(), handles: new Map(), operations: new Map(), writes: new Map(), bindings: new Map(),
      storage: store ?? managedFileStore(stateDirectory) };
    runtimes.set(directoryKey, runtime);
  }
  const { records, handles, operations, writes, bindings, storage } = runtime;
  runtime.treeBarriers ??= new Map();
  runtime.treeInspections ??= new Map();
  runtime.managedAgents ??= new Map();
  // The Agent factory ties ownership to the caller's fiber. The host root stays
  // alive across bridge reloads; replacing only the RPC fiber must not stop agents.
  const owner = typeof root.get === 'function' ? root : ctx;
  const keyOf = input => createHash('sha256').update(`${managedId(input.ownerId)}\n${managedId(input.agentId)}`).digest('hex');
  const service = name => owner.get(name);
  async function installDelegation(agentCtx, agent, record) {
    if (testInstallDelegation) return testInstallDelegation(agentCtx, agent, record);
    const presets = agentCtx.get('agentPresets');
    const tree = presets?.generationFor?.(agentCtx)?.mount?.tree;
    const loader = agentCtx.get('loader');
    if (typeof tree?.entries !== 'function' || typeof loader?.unwrapExports !== 'function' || typeof agentCtx.plugin !== 'function') reject('managed-delegation-unavailable');
    const entry = [...tree.entries()].find(item => item.options?.name === '@deepseek-ai/dsh-tool-subagent'
      && (item.fiber?.config?.toolName ?? 'subagent') === 'subagent');
    if (!entry?.moduleNamespace || !entry.fiber?.config || typeof entry.fiber.config.provider !== 'string') reject('managed-delegation-unavailable');
    const config = structuredClone(entry.fiber.config);
    const fiber = agentCtx.plugin(loader.unwrapExports(entry.moduleNamespace), { ...config, maxDepth: 'provider-managed', toolName: 'managed_subagent' });
    await fiber.await();
    agentCtx.get('systemPrompt')?.context?.({ name: 'futureaide:delegation', order: 100,
      text: 'For delegating work, prefer managed_subagent; use native send_message to communicate with your direct parent and children.' });
  }
  runtime.installManagedDescendant = async agent => {
    if (runtime.managedAgents.has(agent)) return;
    for (const [parent, record] of runtime.managedAgents) {
      if (owner.agents.isOwnedBy?.(agent.id, parent)) {
        await installDelegation(agent.ctx, agent, record);
        runtime.managedAgents.set(agent, record);
        agent.ctx.on('tools/result', (exec, result) => runtime.observeManagedDescendant(agent, exec, result));
        // A descendant's scope may not chain to the root agent's, so the same refusal
        // is installed where the descendant's own tool calls are checked.
        const tools = agent.ctx.get('tools');
        if (typeof tools?.guard === 'function') {
          tools.guard(exec => ASK_USER_TOOL_NAMES.includes(exec.name) && exec.agent === agent ? CHILD_QUESTION_REFUSAL : undefined);
        }
        return;
      }
    }
  };
  if (!runtime.managedAgentListener && typeof owner.on === 'function') {
    owner.on('agent/created', async ({ agent }) => runtime.installManagedDescendant(agent));
    owner.on('agent/disposed', ({ agent }) => runtime.managedAgents.delete(agent));
    runtime.managedAgentListener = true;
  }
  const persist = record => {
    const key = keyOf(record);
    record.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(record);
    const next = (writes.get(key) ?? Promise.resolve()).then(() => storage.write(key, JSON.parse(snapshot)));
    // A failed write remains observable, but must not permanently poison later repair attempts.
    writes.set(key, next.catch(() => {}));
    return next;
  };
  const observeWrite = record => {
    void persist(record).catch(() => { record.observationError = 'managed-state-write-failed'; });
  };
  runtime.observeManagedDescendant = (agent, exec, result) => {
    const record = runtime.managedAgents.get(agent);
    if (!record || exec.agent !== agent || !record.taskId || record.closing || result.isError) return;
    const changes = record.descendantChanges ??= {};
    const own = changes[agent.id] ??= [];
    const values = Array.isArray(result.value?.changes) ? result.value.changes : [result.value];
    for (const change of values) {
      if (typeof change?.path !== 'string' || !path.isAbsolute(change.path)
          || !['create', 'update', 'delete', 'rename'].includes(change.operation)) continue;
      const item = { path: change.path, operation: change.operation, source: 'agent-file-tool-result', attribution: 'confirmed',
        ...(typeof change.before === 'string' || change.before === null ? { before: change.before } : {}),
        ...(typeof change.after === 'string' || change.after === null ? { after: change.after } : {}),
        ...(typeof change.oldPath === 'string' ? { oldPath: change.oldPath } : {}) };
      const existing = own.find(value => value.path === item.path);
      if (existing) {
        if ('before' in existing) item.before = existing.before;
        if (existing.operation === 'create' && item.operation === 'update') item.operation = 'create';
        Object.assign(existing, item);
      }
      else own.push(item);
    }
    observeWrite(record);
  };
  const serial = (input, operation) => {
    const key = keyOf(input);
    const next = (operations.get(key) ?? Promise.resolve()).then(operation);
    operations.set(key, next.catch(() => {}));
    return next;
  };
  async function load(input) {
    const key = keyOf(input);
    const record = records.get(key) ?? await storage.read(key);
    if (!record) reject('managed-agent-not-found');
    if (record.ownerId !== input.ownerId || record.agentId !== input.agentId) reject('managed-owner-mismatch');
    if (input.sessionId !== undefined && record.sessionId !== input.sessionId) reject('managed-session-mismatch');
    if (input.workspace !== undefined && !canonicalEqual(record.workspace, await realpath(input.workspace))) reject('workspace-mismatch');
    if (input.taskId !== undefined && record.taskId !== input.taskId) reject('managed-task-mismatch');
    records.set(key, record);
    return record;
  }
  function snapshot(record, agent = handles.get(keyOf(record))?.agent) {
    return {
      ownerId: record.ownerId, agentId: record.agentId, sessionId: record.sessionId,
      workspace: record.workspace, workspaceId: record.workspaceId, taskId: record.taskId ?? null,
      model: record.model, currentModel: liveModelSelection(agent), agentPreset: record.agentPreset,
      running: agent?.status === 'running', status: record.closing ? 'cleaning' : agent?.status ?? 'unloaded',
      activity: record.activity ?? 'idle', throughSeq: agent ? sessionCursor(agent.session) : record.throughSeq ?? -1,
      questions: structuredClone(record.questions ?? []), changes: structuredClone(record.changes ?? []),
      reports: structuredClone((record.reports ?? []).filter(report => report.taskId === record.taskId)),
      coverage: { source: 'agent-file-tool-results', complete: false,
        limitation: 'Only successful file mutations observed in this agent are attributed; shell and external writes are not inferred from the shared workspace.' },
      updatedAt: record.updatedAt, ...(record.observationError ? { observationError: record.observationError } : {}),
      ...(record.cancelled ? { cancelled: true } : {}),
    };
  }
  async function treeSnapshot(record, agent) {
    const tree = { settled: false, running: agent?.status === 'running', nodes: [], rootSummary: { ready: false } };
    if (!agent || !record.taskId) return tree;
    const subagents = service('subagents');
    try {
      const changes = { ...(record.descendantChanges ?? {}), [record.sessionId]: record.changes ?? [] };
      tree.nodes = await readManagedTree(subagents, owner.agents, agent, changes);
      tree.running ||= tree.nodes.some(node => node.status === 'running');
      if (record.cancelled && record.cancellationSettled && !tree.running) {
        tree.settled = true;
        return tree;
      }
      const after = record.taskStartSeq;
      if (!Number.isSafeInteger(after) || !Number.isSafeInteger(agent.session.seq) || tree.running || agent.session.seq <= after + 1) return tree;
      const key = keyOf(record);
      const inspectTask = async () => {
        let cached = runtime.treeInspections.get(key);
        if (!cached || cached.taskId !== record.taskId || cached.seq !== agent.session.seq) {
          const inspectedSeq = agent.session.seq;
          const inspected = await storedSession(record.sessionId);
          if (!Array.isArray(inspected?.events) || agent.session.seq !== inspectedSeq) throw new Error('managed-tree-unavailable');
          const taskEvents = inspected.events.filter(event => Number.isSafeInteger(event.seq) && event.seq > after);
          const end = taskEvents.findLastIndex(event => event.type === 'turn/end');
          cached = { taskId: record.taskId, seq: inspectedSeq, taskEvents, end,
            completeTurn: end >= 0 && !taskEvents.slice(end + 1).some(event => event.type === 'turn/start') };
          runtime.treeInspections.set(key, cached);
        }
        return cached;
      };
      if (!Number.isSafeInteger(record.taskTurnEndSeq) || record.taskTurnEndSeq <= after) {
        const recovered = await inspectTask();
        if (!recovered.completeTurn) return tree;
        record.taskTurnEndSeq = recovered.taskEvents[recovered.end].seq;
        await persist(record);
      }
      let barrier = runtime.treeBarriers.get(key);
      if (!barrier || barrier.failed || barrier.taskId !== record.taskId || (barrier.seq !== undefined && barrier.seq !== agent.session.seq)) {
        barrier = { taskId: record.taskId };
        runtime.treeBarriers.set(key, barrier);
        void waitManagedTree(subagents, owner.agents, agent, () => runtime.treeBarriers.get(key) === barrier && record.taskId === barrier.taskId)
          .then(seq => { if (seq !== null) barrier.seq = seq; })
          .catch(() => { barrier.failed = true; });
      }
      tree.settled = !tree.running && !barrier.failed && barrier.seq !== undefined && barrier.seq === agent.session.seq;
      if (tree.settled) {
        const { taskEvents, end, completeTurn } = await inspectTask();
        if (!completeTurn || barrier.seq !== agent.session.seq) { tree.settled = false; return tree; }
        const start = taskEvents.findLastIndex((event, index) => index <= end && event.type === 'turn/start');
        if (start >= 0) {
          const reply = taskEvents.slice(start, end + 1).filter(event => event.type === 'assistant/message')
            .map(event => event.data?.message ?? event.data)
            .map(message => (message?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n'))
            .filter(Boolean).at(-1);
          const reason = taskEvents[end].data?.reason;
          const state = reason?.kind === 'cancelled' || (reason?.kind === 'aborted' && reason?.reason?.kind === 'user')
            ? 'cancelled' : !reason?.kind || reason.kind === 'completed' ? 'completed' : 'failed';
          if (reply || state !== 'completed') tree.rootSummary = { ready: true, reply: reply ?? '', state };
        }
      }
    } catch { tree.settled = false; tree.rootSummary = { ready: false }; tree.observationError = 'managed-tree-unavailable'; }
    return tree;
  }
  function installTools(agentCtx, agent, record) {
    const tools = agentCtx.get('tools');
    if (!tools?.register || !tools.guard) reject('managed-tools-unavailable');
    const key = keyOf(record);
    const previous = bindings.get(key);
    const fresh = previous?.agent !== agent;
    const binding = fresh ? { agent, record } : previous;
    bindings.set(key, binding);
    binding.guard = exec => {
      // Before the ownership check: DSH evaluates guards along the agent scope chain,
      // so this one may also see a descendant's call, and a descendant has no
      // ask_parent tool of its own.
      if (ASK_USER_TOOL_NAMES.includes(exec.name)) {
        return exec.agent === agent ? ROOT_QUESTION_REFUSAL : CHILD_QUESTION_REFUSAL;
      }
      if (exec.agent !== agent) return undefined;
      if (record.closing || record.cancelled) return 'The controlling agent has stopped this task.';
      if (record.questions.some(question => question.state === 'pending') && exec.name !== 'ask_parent' && exec.name !== 'feedback') {
        return 'Wait for the controlling agent to answer before continuing this task.';
      }
      if (record.treeProtocol !== 1 && (exec.name === 'managed_subagent' || exec.name === 'subagent' || exec.name === 'subagent_fork')) {
        return 'The controlling client must reload and enable managed tree support before delegation.';
      }
      return undefined;
    };
    if (fresh) tools.guard(exec => binding.guard(exec));
    binding.feedbackTool = {
      name: 'feedback',
      description: 'Record a plugin problem or friction in the local feedback inbox. Use ask_parent for decisions and report_parent for deliverables.',
      parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['problem', 'friction'] }, message: { type: 'string', minLength: 1, maxLength: 1200 }, severity: { type: 'string', enum: ['low', 'medium', 'high'] } }, required: ['kind', 'message'], additionalProperties: false },
      async execute(args, exec) {
        const deadline = Date.now() + 2000;
        if (exec.agent !== agent || record.closing || record.cancelled) reject('managed-task-closed');
        if (!record.taskId || (record.reports ?? []).some(report => report.taskId === record.taskId && report.final)) reject('managed-task-required');
        if (!path.isAbsolute(feedbackNode || '') || !path.isAbsolute(feedbackConfigFile || '')) return { saved: false, code: 'feedback-unavailable' };
        const recent = binding.feedbackError;
        const error = recent?.taskId === record.taskId && Date.now() - Date.parse(recent.at) <= 900000 ? recent : null;
        return writeFeedback(feedbackNode, feedbackConfigFile, args, { source: 'dsh',
          caller: record.feedbackCallerHost ?? null, target: 'dsh', name: record.feedbackAgentName ?? null,
          error: error && { tool: error.tool, code: error.code, httpStatus: error.httpStatus ?? null, at: error.at } }, deadline);
      },
    };
    if (!binding.feedbackRegistered) {
      tools.register({ ...binding.feedbackTool, execute: (args, exec) => binding.feedbackTool.execute(args, exec) });
      binding.feedbackRegistered = true;
    }
    binding.questionTool = {
      name: 'ask_parent',
      description: 'Ask the controlling agent a question needed for your current task. Provide the question directly. This ends the current turn; the answer will resume this same task. Do not create a file or run a command to communicate. '
        + QUESTION_CONTRACT,
      parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 100000 } }, required: ['message'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { waiting: { type: 'boolean' } }, required: ['waiting'], additionalProperties: false },
        render: () => [{ type: 'text', text: 'Your question has been sent to the controlling agent. Wait for its answer; the original task remains active.' }] },
      async execute(args, exec) {
        if (exec.agent !== agent || record.closing || record.cancelled) reject('managed-task-closed');
        if (!record.taskId) reject('managed-task-required');
        if ((record.reports ?? []).some(report => report.taskId === record.taskId && report.final)) reject('managed-report-finalized');
        if (typeof args?.message !== 'string' || !args.message.trim() || args.message.length > 100000) reject('invalid-question');
        record.questions.push({ id: `question-${randomUUID()}`, taskId: record.taskId, message: args.message,
          state: 'pending', createdAt: new Date().toISOString() });
        record.activity = 'awaiting-answer';
        await persist(record);
        exec.concludeTurn();
        return { waiting: true };
      },
    };
    const observeToolFailure = async (tool, args, exec) => {
      try { return await binding[tool === 'ask_parent' ? 'questionTool' : 'reportTool'].execute(args, exec); }
      catch (error) {
        if (exec.agent === agent && record.taskId && typeof error?.controlCode === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(error.controlCode)) {
          binding.feedbackError = { taskId: record.taskId, tool, code: error.controlCode, at: new Date().toISOString() };
        }
        throw error;
      }
    };
    if (fresh) tools.register({ ...binding.questionTool, execute: (args, exec) => observeToolFailure('ask_parent', args, exec) });
    binding.reportTool = {
      name: 'report_parent',
      description: 'Send a report to your controlling agent. Set final to true for the completed task deliverable. Descendants report to their native parent. '
        + FINAL_REPORT_CONTRACT,
      parameters: { type: 'object', properties: { message: { type: 'string', minLength: 1, maxLength: 100000 }, final: { type: 'boolean', default: false } }, required: ['message'], additionalProperties: false },
      output: { schema: { type: 'object', properties: { accepted: { type: 'boolean' }, final: { type: 'boolean' } }, required: ['accepted', 'final'], additionalProperties: false },
        render: () => [{ type: 'text', text: 'Your report was recorded for delivery to the controlling agent.' }] },
      async execute(args, exec) {
        if (exec.agent !== agent || record.closing || record.cancelled || record.reportProtocol !== 1) reject('managed-task-closed');
        if (!record.taskId) reject('managed-task-required');
        if (typeof args?.message !== 'string' || !args.message.trim() || args.message.length > 100000 || (args.final !== undefined && typeof args.final !== 'boolean')) reject('invalid-report');
        const reports = record.reports ??= [];
        if (reports.some(report => report.taskId === record.taskId && report.final)) reject('managed-report-finalized');
        // A steer input becomes visible on the model's next step, so a final submitted
        // now would be recorded and seal the task before the model ever read it. This
        // error is the tool result: the model reads the waiting input on that same
        // next step, then may report. Only nextStep counts here — nextTurn is read
        // after the turn ends, so refusing a final for it would gain nothing.
        if (args.final === true && agent.inbox?.nextStep?.length > 0) {
          throw new Error('New input from the controlling agent arrived while you were working. Read it before submitting this final report.');
        }
        const report = { id: `report-${randomUUID()}`, taskId: record.taskId, message: args.message, final: args.final === true, createdAt: new Date().toISOString() };
        reports.push(report);
        try { await persist(record); } catch (error) { reports.splice(reports.indexOf(report), 1); throw error; }
        if (report.final) exec.concludeTurn();
        return { accepted: true, final: report.final };
      },
    };
    if (!binding.reportRegistered) {
      tools.register({ ...binding.reportTool, execute: (args, exec) => observeToolFailure('report_parent', args, exec) });
      binding.reportRegistered = true;
      agentCtx.get('systemPrompt')?.context?.({ name: 'futureaide:reports', order: 100,
        text: 'Keep routine progress in the task record. Use report_parent for agreed milestones, deliverables or issues requiring your controlling agent\'s action, and final: true when the task is complete. Use ask_parent for a decision you need. Use feedback to record plugin problems or friction.' });
    }
    binding.preExecute = async (exec, next) => {
      if (exec.agent === agent && exec.name !== 'feedback' && record.taskId && !record.closing) {
        record.activity = `tool: ${exec.name}`;
        observeWrite(record);
      }
      try { return await next(); }
      catch (error) {
        if (exec.agent === agent && record.taskId && ['ask_parent', 'report_parent', 'managed_subagent'].includes(exec.name)
            && typeof error?.controlCode === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(error.controlCode)) {
          binding.feedbackError = { taskId: record.taskId, tool: exec.name, code: error.controlCode, at: new Date().toISOString() };
        }
        throw error;
      }
    };
    if (fresh) agentCtx.on('tools/pre-execute', (...args) => binding.preExecute(...args));
    binding.result = (exec, result) => {
      if (exec.agent !== agent || exec.name === 'feedback' || !record.taskId || record.closing) return;
      if (result?.isError) {
        if (exec.name !== 'feedback' && ['ask_parent', 'report_parent', 'managed_subagent'].includes(exec.name)) {
          const code = result.value?.controlCode ?? result.value?.code ?? result.error?.controlCode ?? result.error?.code;
          if (typeof code === 'string' && /^[a-z][a-z0-9-]{0,79}$/.test(code)) binding.feedbackError = { taskId: record.taskId, tool: exec.name, code, at: new Date().toISOString() };
        }
        return;
      }
      const value = result.value;
      const values = Array.isArray(value?.changes) ? value.changes : [value];
      for (const change of values) {
        if (typeof change?.path !== 'string' || !path.isAbsolute(change.path)
            || !['create', 'update', 'delete', 'rename'].includes(change.operation)) continue;
        const existing = record.changes.find(item => item.path === change.path);
        const item = { path: change.path, operation: change.operation,
          source: 'agent-file-tool-result', attribution: 'confirmed',
          ...(typeof change.before === 'string' || change.before === null ? { before: change.before } : {}),
          ...(typeof change.after === 'string' || change.after === null ? { after: change.after } : {}),
          ...(typeof change.oldPath === 'string' ? { oldPath: change.oldPath } : {}) };
        if (existing) {
          if ('before' in existing) item.before = existing.before;
          if (existing.operation === 'create' && item.operation === 'update') item.operation = 'create';
          Object.assign(existing, item);
        } else record.changes.push(item);
      }
      if (exec.name !== 'ask_parent') record.activity = `finished tool: ${exec.name}`;
      observeWrite(record);
    };
    if (fresh) agentCtx.on('tools/result', (...args) => binding.result(...args));
    binding.event = (session, event) => {
      if (session.id !== record.sessionId || record.closing) return;
      if (Number.isSafeInteger(event.seq)) record.throughSeq = event.seq;
      if (event.type === 'turn/end' && record.taskId && Number.isSafeInteger(event.seq)
          && Number.isSafeInteger(record.taskStartSeq) && event.seq > record.taskStartSeq) record.taskTurnEndSeq = event.seq;
      if (event.type === 'turn/start') record.activity = 'running';
      if (event.type === 'turn/end') record.activity = record.questions.some(question => question.state === 'pending')
        ? 'awaiting-answer' : record.cancelled ? 'cancelled' : 'turn-ended';
      if (['turn/start', 'turn/end', 'tool/call', 'assistant/message'].includes(event.type)) observeWrite(record);
    };
    if (fresh) agentCtx.on('session/event', (...args) => binding.event(...args));
  }
  const storedSession = async sessionId => {
    try {return await readStoredSession(service,sessionId);} catch(error) {
      const persistence=service('sessionPersistence');
      if (typeof persistence?.readStoredLog !== 'function' || typeof persistence.resolveCurrentLog !== 'function') throw error;
      const log=await persistence.resolveCurrentLog(sessionId); if (!log) throw error;
      const stored=await persistence.readStoredLog(log,sessionId);
      return {header:stored.meta,events:stored.events};
    }
  };
  async function activate(record, { fresh = false } = {}) {
    const key = keyOf(record);
    const owned = handles.get(key);
    if (owned && owner.agents.get(record.sessionId) === owned.agent) return owned.agent;
    if (record.closing) return undefined;
    if (owner.agents.get(record.sessionId)) reject('managed-handle-unavailable');
    const controller = service('sessionController');
    const composer = controller?.agents;
    if (typeof composer?.composeAgent !== 'function') reject('managed-composition-unavailable');
    const composition = await composer.composeAgent(record.agentPreset);
    record.agentPreset = composition.agentPreset;
    const setup = async (agentCtx, agent) => {
      const commit = await composition.setup(agentCtx, agent);
      installTools(agentCtx, agent, record);
      await installDelegation(agentCtx, agent, record);
      bindings.get(key).delegationReady = true;
      runtime.managedAgents.set(agent, record);
      return commit;
    };
    let handle;
    if (fresh) {
      handle = await owner.agents.create({ sessionId: record.sessionId, agentOptions: record.model,
        meta: { cwd: record.workspace, ...(record.agentPreset ? { agentPreset: record.agentPreset } : {}) }, setup });
    } else {
      const { header } = await storedSession(record.sessionId);
      if (header?.id !== record.sessionId || !canonicalEqual(await realpath(header.cwd), record.workspace)) reject('managed-session-mismatch');
      handle = await owner.agents.resume({ resumeSessionId: record.sessionId, agentOptions: record.model, setup });
    }
    if (!handle?.agent || typeof handle.dispose !== 'function') reject('managed-handle-unavailable');
    handles.set(key, handle);
    record.throughSeq = sessionCursor(handle.agent.session);
    await persist(record);
    return handle.agent;
  }
  async function validateOwnedDirectory(directory, root, expectedName) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || typeof directory !== 'string' || !path.isAbsolute(directory)
        || path.basename(directory) !== expectedName) reject('managed-cleanup-path-unavailable');
    let entry;
    try { entry = await lstat(directory); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!entry.isDirectory() || entry.isSymbolicLink()) reject('managed-cleanup-path-invalid');
    const [actualRoot, actualDirectory] = await Promise.all([realpath(root), realpath(directory)]);
    const relative = path.relative(actualRoot, actualDirectory);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) reject('managed-cleanup-path-invalid');
    return actualDirectory;
  }
  async function removeOwnedDirectory(directory, root, expectedName) {
    const actualDirectory = await validateOwnedDirectory(directory, root, expectedName);
    if (actualDirectory) await removeDirectory(actualDirectory, { recursive: true, force: true });
  }
  async function cleanupPlan(record, agent, { persistPlan = true } = {}) {
    if (record.cleanup) return record.cleanup;
    const persistence = service('sessionPersistence');
    const registry = service('workspaceRegistry');
    const projectionCache = service('sessionProjectionCache');
    const query = service('sessionQuery');
    if (persistence?.name !== 'session-persistence-jsonl' || typeof persistence.resolveCurrentLog !== 'function'
        || typeof persistence.config?.root !== 'string') reject('managed-cleanup-backend-unsupported');
    const workspace = registry?.get(record.workspaceId);
    if (typeof workspace?.detachSession !== 'function') reject('managed-cleanup-workspace-unsupported');
    if (projectionCache && typeof projectionCache.requireTable?.()?.delete !== 'function') reject('managed-cleanup-cache-unsupported');
    if (query && typeof query._observations?.cache?.delete !== 'function') reject('managed-cleanup-query-unsupported');
    if (agent) await owner.sessions.flush(agent.session);
    const log = await persistence.resolveCurrentLog(record.sessionId);
    if (typeof log !== 'string' || path.basename(path.dirname(log)) !== record.sessionId) reject('managed-cleanup-path-unavailable');
    const spill = service('spillStore');
    const spillName = `session-${createHash('sha256').update(record.sessionId).digest('hex').slice(0, 12)}`;
    record.cleanup = { sessionRoot: path.resolve(persistence.config.root), sessionDirectory: path.dirname(log),
      ...(typeof spill?.root === 'string' ? { spillRoot: spill.root, spillDirectory: path.join(spill.root, spillName), spillName } : {}) };
    if (persistPlan) await persist(record);
    return record.cleanup;
  }
  async function managedInspect(input) {
      const record=await load(input);
      if (input.reportProtocol!==1 || input.treeProtocol!==1 || record.treeProtocol!==1) reject('managed-tree-protocol-required');
      const agent=handles.get(keyOf(record))?.agent;
      if (record.closing || record.observationError || (agent && (owner.agents.get(record.sessionId)!==agent || agent.status!=='idle')))
        return {running:agent?.status==='running'?true:null,ownership:'managed',complete:false,reason:'managed-activity-unverified'};
      if (agent && ((agent.inbox?.nextTurn?.length??0)>0 || (agent.inbox?.nextStep?.length??0)>0))
        return {running:null,ownership:'managed',complete:false,reason:'managed-pending-input'};
      let tree, cold;
      if (agent) tree=await treeSnapshot(record,agent);
      else {
        if (!cleanup || owner.agents.get(record.sessionId) || owner.sessions.get(record.sessionId)) return {running:null,ownership:'managed',complete:false,reason:'managed-cold-state-unavailable'};
        cold=await cleanup.inspect({sessionId:record.sessionId});
        if (cold.running!==false || !Array.isArray(cold.treeIds)) return {running:cold.running===true?true:null,ownership:'managed',complete:false,reason:'managed-cold-state-unavailable'};
        const nodes=await readManagedTree(service('subagents'),owner.agents,{id:record.sessionId,status:'unloaded'},record.descendantChanges);
        tree={settled:hash(nodes.map(n=>n.sessionId))===hash(cold.treeIds),running:false,nodes};
      }
      if (!tree.settled || tree.running || !Array.isArray(tree.nodes) || tree.nodes.some(n=>n.mode==='external' || (n.sessionId!==record.sessionId && !['one-shot','continuable'].includes(n.mode))))
        return {running:tree.running?true:null,ownership:'managed',complete:false,reason:'managed-tree-unsettled'};
      const seq=agent?.session?.seq ?? record.throughSeq ?? null, updatedAt=record.updatedAt, history=[];
      for (const node of tree.nodes) {
        let inspected;
        try {inspected=await storedSession(node.sessionId);} catch {
          const persistence=service('sessionPersistence'), log=await persistence?.resolveCurrentLog?.(node.sessionId);
          if (!log || typeof persistence.readStoredLog!=='function') reject('managed-history-unavailable');
          const stored=await persistence.readStoredLog(log,node.sessionId); inspected={header:stored.meta,events:stored.events};
        }
        if (inspected?.header?.id!==node.sessionId || !Array.isArray(inspected.events) || inspected.events.some(e=>!Number.isSafeInteger(e.seq))) reject('managed-history-unavailable');
        for (const event of inspected.events) history.push({sourceId:`${node.sessionId}:${event.seq}`,sessionId:node.sessionId,event});
      }
      if (agent && (agent.status!=='idle' || agent.session.seq!==seq) || record.updatedAt!==updatedAt) return {running:null,ownership:'managed',complete:false,reason:'managed-activity-changed'};
      if (!agent) {
        const rootEvents=history.filter(entry=>entry.sessionId===record.sessionId).map(entry=>entry.event);
        const end=rootEvents.findLastIndex(event=>event.type==='turn/end' && Number.isSafeInteger(event.seq) && event.seq>(record.taskStartSeq??-1));
        if (!record.taskId || end<0 || rootEvents.slice(end+1).some(event=>event.type==='turn/start')) return {running:null,ownership:'managed',complete:false,reason:'managed-cold-turn-unverified'};
        const again=await cleanup.inspect({sessionId:record.sessionId});
        if (again.running!==false || again.activityVersion!==cold.activityVersion) return {running:null,ownership:'managed',complete:false,reason:'managed-activity-changed'};
      }
      const business=history.map(x=>x.event).filter(e=>['turn/start','turn/end','tool/call','tool/result','assistant/message','user/message'].includes(e.type));
      const times=business.map(e=>typeof e.time==='number'?e.time:Date.parse(e.time));
      for (const entry of [...(record.questions??[]),...(record.reports??[])]) { times.push(Date.parse(entry.createdAt)); if (entry.answeredAt) times.push(Date.parse(entry.answeredAt)); }
      const lastActivityAt=times.length && times.every(t=>Number.isFinite(t) && t>=1000000000000 && t<=Date.now()+300000) ? Math.max(...times) : null;
      const version=hash({sessionId:record.sessionId,taskId:record.taskId,seq,tree:tree.nodes,questions:record.questions,reports:record.reports});
      return {sessionId:record.sessionId,lastActivityAt,historyPresent:history.length>0 || (record.questions??[]).length>0 || (record.reports??[]).length>0,running:false,ownership:'managed',complete:true,treeIds:tree.nodes.map(n=>n.sessionId),activityVersion:version,
        historyComplete:true,history,questions:structuredClone(record.questions??[]),reports:structuredClone(record.reports??[]),taskId:record.taskId??null};
  }

  const methods = {
    managedCreate(input) { return serial(input, async () => {
      const key = keyOf(input);
      managedId(input.sessionId);
      if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) reject('workspace-required');
      let record = records.get(key) ?? await storage.read(key);
      if (record) {
        record = await load(input);
        if (record.closing) reject('managed-agent-closing');
        const persisted = await service('sessionPersistence')?.stat(record.sessionId);
        const agent = await activate(record, { fresh: record.phase === 'creating' && !persisted });
        const project = service('workspaceRegistry').get(record.workspaceId);
        await owner.sessions.flush(agent.session);
        await project.attachSession(record.sessionId);
        if (!project.sessionIds.includes(record.sessionId)) reject('managed-project-attach-failed');
        record.phase = 'created';
        await persist(record);
        return { ...snapshot(record, agent), created: true, modelRequestsStarted: 0 };
      }
      const workspace = await realpath(input.workspace);
      const registry = service('workspaceRegistry');
      if (!registry?.resolveByPath || !registry?.create) reject('managed-workspace-unavailable');
      const project = await registry.resolveByPath(workspace) ?? await registry.create(workspace);
      const selection = service('agentDefaultModel')?.currentSelection();
      const model = modelValue(selection);
      if (owner.agents.get(input.sessionId) || await service('sessionPersistence')?.stat(input.sessionId)) reject('managed-session-already-exists');
      record = { version: 1, ownerId: input.ownerId, agentId: input.agentId, sessionId: input.sessionId,
        workspace, workspaceId: project.id, model, questions: [], changes: [], activity: 'idle', phase: 'creating' };
      records.set(key, record);
      await persist(record);
      const agent = await activate(record, { fresh: true });
      await owner.sessions.flush(agent.session);
      await project.attachSession(record.sessionId);
      if (!project.sessionIds.includes(record.sessionId)) reject('managed-project-attach-failed');
      record.phase = 'created';
      await persist(record);
      return { ...snapshot(record, agent), created: true, modelRequestsStarted: 0 };
    }); },
    managedBeginTask(input) { return serial(input, async () => {
      managedId(input.taskId);
      if (input.reportProtocol !== 1) reject('managed-report-protocol-required');
      const record = await load({ ...input, taskId: undefined });
      const treeProtocol = input.treeProtocol === 1;
      if ((!treeProtocol && input.treeProtocol !== undefined) || (!treeProtocol && record.treeProtocol === 1)) reject('managed-tree-protocol-required');
      if (record.closing) reject('managed-agent-closing');
      let agent = await activate(record);
      if (record.taskId === input.taskId) {
        record.reportProtocol = 1;
        if (typeof input.feedbackAgentName === 'string') record.feedbackAgentName = input.feedbackAgentName;
        if (typeof input.feedbackCallerHost === 'string') record.feedbackCallerHost = input.feedbackCallerHost;
        if (treeProtocol && record.treeProtocol !== 1) {
          record.treeProtocol = 1;
          if (!Number.isSafeInteger(record.taskStartSeq) && Number.isSafeInteger(input.taskStartSeq) && input.taskStartSeq >= -1) record.taskStartSeq = input.taskStartSeq;
        }
        await persist(record);
        return { ...snapshot(record, agent), reportProtocol: 1, ...(treeProtocol ? { treeProtocol: 1 } : {}) };
      }
      if (agent.status === 'running' || record.questions.some(question => question.state === 'pending')) reject('managed-agent-busy');
      const key = keyOf(record);
      if (treeProtocol && !bindings.get(key)?.delegationReady) {
        const handle = handles.get(key);
        if (!handle) reject('managed-handle-unavailable');
        await handle.dispose();
        handles.delete(key); bindings.delete(key); runtime.managedAgents.delete(agent);
        agent = await activate(record);
      }
      runtime.treeBarriers.delete(key); runtime.treeInspections.delete(key);
      Object.assign(record, { feedbackAgentName: typeof input.feedbackAgentName === 'string' ? input.feedbackAgentName : null, feedbackCallerHost: typeof input.feedbackCallerHost === 'string' ? input.feedbackCallerHost : null, taskId: input.taskId, reportProtocol: 1, reports: [], treeProtocol: treeProtocol ? 1 : undefined, taskStartSeq: sessionCursor(agent.session), taskTurnEndSeq: undefined, questions: [], changes: [], descendantChanges: {}, cancelled: false, cancellationSettled: false,
        activity: 'ready', answers: [], throughSeq: sessionCursor(agent.session) });
      await persist(record);
      return { ...snapshot(record, agent), reportProtocol: 1, ...(treeProtocol ? { treeProtocol: 1 } : {}) };
    }); },
    managedStatus(input) { return serial(input, async () => {
      if (input.reportProtocol !== 1) reject('managed-report-protocol-required');
      const record = await load(input);
      if (record.treeProtocol === 1 && input.treeProtocol !== 1) reject('managed-tree-protocol-required');
      const agent = record.closing ? handles.get(keyOf(record))?.agent : await activate(record);
      await (writes.get(keyOf(record)) ?? Promise.resolve());
      return { ...snapshot(record, agent), reportProtocol: 1, tree: await treeSnapshot(record, agent) };
    }); },
    // Explicit model selection is Session-local: DSH's own command would also save
    // the app-wide default, so this path repeats only its validation and
    // agent.model.select under the same image-admission serialization, and never
    // calls agentDefaultModel.saveSelection.
    managedSelectModel(input) { return serial(input, async () => {
      managedId(input.sessionId);
      if (input.taskId !== undefined) managedId(input.taskId);
      if (typeof input.workspace !== 'string' || !path.isAbsolute(input.workspace)) reject('workspace-required');
      const record = await load(input);
      if (record.closing) reject('managed-agent-closing');
      const selection = modelValue(input.selection);
      // An installation that runs DSH on its default model only refuses every other
      // session choice here, so a caller still on an older plugin cannot get around it.
      if (defaultModelOnly) {
        const current = service('agentDefaultModel')?.currentSelection();
        const fallback = current ? modelValue(current) : undefined;
        // Lock the model only; the host validates the effort below.
        const allowed = fallback && selection.provider === fallback.provider && selection.model === fallback.model;
        if (!allowed) reject('managed-model-locked');
      }
      const agent = await activate(record);
      if (!agent) reject('managed-handle-unavailable');
      const controller = service('sessionController');
      const agents = controller?.agents;
      if (typeof agents?.serializeImageAdmission !== 'function') reject('managed-model-selection-unavailable');
      return agents.serializeImageAdmission(agent, async () => {
        const llm = service('llm');
        if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function'
            || typeof llm.resolveCallConfig !== 'function') reject('managed-model-selection-unavailable');
        const commands = controller?.commands;
        if (typeof commands?.requireModel === 'function') {
          try { await commands.requireModel.call(commands, selection); }
          catch { reject('managed-model-unavailable'); }
        } else {
          if (!llm.listProviders().some(provider => provider?.id === selection.provider)) reject('managed-model-unavailable');
          let models;
          try { models = await llm.listModels(selection.provider); }
          catch { reject('managed-model-unavailable'); }
          if (!Array.isArray(models) || !models.some(model => model?.id === selection.model)) reject('managed-model-unavailable');
        }
        try { await llm.resolveCallConfig(selection); }
        catch { reject('managed-model-unavailable'); }
        if (typeof agent.model?.select !== 'function') reject('managed-model-selection-unavailable');
        agent.model.select(selection);
        // Read back the durable Session choice, not the request. The agent model
        // reader and the projection/event view must agree on the requested route;
        // a stale projection cannot mask a host that ignored or substituted it.
        const recorded = typeof agent.model.current === 'function' ? agent.model.current() : undefined;
        const observed = liveModelSelection(agent);
        const current = sameSelectionValue(recorded, selection) ? recorded
          : sameSelectionValue(observed, selection) ? observed : recorded ?? observed;
        if (!sameSelectionValue(current, selection)) reject('managed-model-selection-unconfirmed');
        return { accepted: true, sessionId: record.sessionId, selected: { ...current },
          source: 'managed-session-selectModel',
          defaultModelBehavior: 'Session-only: the app-wide default model is unchanged.',
          modelRequestsStarted: 0 };
      });
    }); },
    managedCleanupInspect(input) { return serial(input, () => managedInspect(input)); },
    managedCleanupStage(input) { return serial(input, async () => {
      if (!cleanup || !input.expected?.activityVersion || !/^[a-f0-9-]{36}$/i.test(input.operationToken??'')) reject('managed-cleanup-ticket-required');
      const record=await load(input), key=keyOf(record);
      if (!record.cleanupToken && record.closing && record.activity==='cleanup-staging') {
        const recovered=await cleanup.lookupManaged({ticket:input.operationToken,proof:MANAGED_CLEANUP_PROOF});
        if (recovered && recovered.sessionId===record.sessionId && recovered.managed.ownerId===record.ownerId
            && recovered.managed.agentId===record.agentId && recovered.managed.version===input.expected.activityVersion) {
          record.cleanupToken=recovered.ticket; record.cleanupVersion=recovered.managed.version;
          record.cleanupEligibleAt=recovered.eligibleAt; record.activity='cleanup-staged'; await persist(record);
        } else return {removed:false,reason:'managed-ticket-recovery-required',ticket:input.operationToken};
      }
      if (record.cleanupToken) {
        if (record.cleanupToken!==input.operationToken || record.cleanupVersion!==input.expected.activityVersion) reject('managed-cleanup-ticket-conflict');
        return {removed:false,staged:true,ticket:record.cleanupToken,eligibleAt:record.cleanupEligibleAt};
      }
      if (record.cleanupDispositionToken && !record.cleanupToken && !record.closing) {
        if (record.cleanupDispositionToken!==input.operationToken || record.cleanupDispositionVersion!==input.expected.activityVersion) return {removed:false,reason:'managed-disposition-ticket-conflict'};
        for (const q of record.questions??[]) if (q.state==='recipient-deleted' && q.disposition?.operationToken===input.operationToken) {q.state='pending';delete q.disposition;}
        delete record.cleanupDispositionToken; delete record.cleanupDispositionVersion; await persist(record);
      }
      const inspected=await managedInspect(input);
      const pendingQuestions=(record.questions??[]).filter(q=>q.state==='pending');
      if (!inspected.complete || inspected.running!==false || inspected.activityVersion!==input.expected.activityVersion || !inspected.treeIds.length)
        return {removed:false,reason:'managed-changed-or-tree-unsupported'};
      if (pendingQuestions.length) {
        const d=input.disposition, receipts=d?.questionReceipts;
        if (d?.recipientDeleted!==true || d.ownerId!==record.ownerId || d.operationToken!==input.operationToken
          || typeof d.ticketId!=='string' || !/^[a-f0-9]{64}$/i.test(d.archiveManifestHash??'')
          || d.ownerProof?.state!=='deleted' || typeof d.ownerProof.domain!=='string' || !d.ownerProof.domain
          || d.ownerProof.source!=='confirmed-native-delete-and-current-lists' || !/^[a-f0-9-]{36}$/i.test(d.ownerProof.threadId??'')
          || typeof d.ownerProof.receiptId!=='string' || !d.ownerProof.receiptId || !Number.isFinite(Date.parse(d.ownerProof.removedAt))
          || !Array.isArray(receipts) || receipts.length!==pendingQuestions.length) return {removed:false,reason:'managed-question-disposition-unverified'};
        for (const q of pendingQuestions) {
          const matches=receipts.filter(r=>r.id===q.id && r.sessionId===record.sessionId && r.messageHash===createHash('sha256').update(q.message,'utf8').digest('hex')
            && typeof r.archiveKey==='string' && /^[a-f0-9]{64}$/i.test(r.archiveSha256??''));
          if (matches.length!==1) return {removed:false,reason:'managed-question-archive-unverified'};
        }
        for (const q of pendingQuestions) {const receipt=receipts.find(r=>r.id===q.id); Object.assign(q,{state:'recipient-deleted',disposition:{ticketId:d.ticketId,archiveKey:receipt.archiveKey,archiveSha256:receipt.archiveSha256,ownerProof:d.ownerProof,operationToken:input.operationToken,at:new Date().toISOString()}});}
        record.cleanupDispositionToken=input.operationToken; record.cleanupDispositionVersion=input.expected.activityVersion;
        await persist(record);
      }
      const handle=handles.get(key), agent=handle?.agent, seq=agent?.session?.seq;
      if (agent && agent.status!=='idle') return {removed:false,reason:'managed-not-idle'};
      if (!agent && (owner.agents.get(record.sessionId) || owner.sessions.get(record.sessionId))) return {removed:false,reason:'managed-cold-state-unavailable'};
      record.closing=true; record.activity='cleanup-staging'; await persist(record);
      if (agent) {
        if (agent.status!=='idle' || agent.session.seq!==seq || (agent.inbox?.nextTurn?.length??0)>0 || (agent.inbox?.nextStep?.length??0)>0) {
          record.closing=false; record.activity='turn-ended'; await persist(record); return {removed:false,reason:'managed-activity-changed'};
        }
        await handle.dispose(); handles.delete(key); bindings.delete(key); runtime.managedAgents.delete(agent);
      }
      if (owner.agents.get(record.sessionId) || owner.sessions.get(record.sessionId)) {record.closing=false; await persist(record); return {removed:false,reason:'managed-release-incomplete'};}
      const native=await cleanup.inspect({sessionId:record.sessionId});
      if (native.available===false || native.running!==false || hash(native.treeIds)!==hash(inspected.treeIds)) {record.closing=false; await persist(record); return {removed:false,reason:'managed-native-unverified'};}
      const result=await cleanup.remove({...native,ownership:'managed'}, {operationToken:input.operationToken,proof:MANAGED_CLEANUP_PROOF,
        managed:{ownerId:record.ownerId,agentId:record.agentId,workspaceId:record.workspaceId,version:input.expected.activityVersion}});
      if (!result.staged) {record.closing=false; await persist(record); return result;}
      record.cleanupToken=result.ticket; record.cleanupVersion=input.expected.activityVersion; record.cleanupEligibleAt=result.eligibleAt; record.activity='cleanup-staged'; await persist(record);
      return result;
    }); },
    managedCleanupFinalize(input) { return serial(input, async () => {
      let record;
      try {record=await load(input);} catch(error) {
        if (error.controlCode!=='managed-agent-not-found') throw error;
        const receipt=await cleanup.lookupManaged({ticket:input.operationToken,proof:MANAGED_CLEANUP_PROOF});
        if (receipt?.state==='deleted' && receipt.sessionId===input.sessionId && receipt.managed.ownerId===input.ownerId
          && receipt.managed.agentId===input.agentId && receipt.managed.version===input.expected?.activityVersion)
          return await cleanup.finalize({ticket:input.operationToken,proof:MANAGED_CLEANUP_PROOF});
        throw error;
      }
      const key=keyOf(record);
      if (!record.closing || record.cleanupToken!==input.operationToken || record.cleanupVersion!==input.expected?.activityVersion) reject('managed-cleanup-ticket-conflict');
      const result=await cleanup.finalize({ticket:input.operationToken,proof:MANAGED_CLEANUP_PROOF});
      if (!result.removed) return result;
      await (writes.get(key)??Promise.resolve()); await storage.remove(key); records.delete(key); writes.delete(key);
      return result;
    }); },
    managedCleanupRestore(input) { return serial(input, async () => {
      const record=await load(input);
      if (record.cleanupToken!==input.operationToken) reject('managed-cleanup-ticket-conflict');
      const result=await cleanup.restore({ticket:input.operationToken,proof:MANAGED_CLEANUP_PROOF});
      if (result.restored) {record.closing=false; record.activity='turn-ended'; delete record.cleanupToken; delete record.cleanupVersion; delete record.cleanupEligibleAt; await persist(record);}
      return result;
    }); },
    // Use the host's text-prompt admission and fence its synchronous inbox write.
    managedPromptV2(input) { return serial(input, async () => {
      managedId(input.sessionId); managedId(input.requestId);
      if (typeof input.message !== 'string' || !input.message.trim() || Buffer.byteLength(input.message, 'utf8') > 131072 || !['queue', 'steer'].includes(input.mode)) reject('invalid-input');
      const selection = modelValue(input.selection);
      const startSelection = input.startSelection ? modelValue(input.startSelection) : selection;
      const record = await load(input);
      if (record.closing || record.cancelled) reject('managed-task-closed');
      const agent = await activate(record);
      const controller = service('sessionController'), commands = controller?.commands, agents = controller?.agents;
      if (typeof commands?.prompt !== 'function' || typeof commands?.hasPromptRequest !== 'function' || typeof agents?.serializeImageAdmission !== 'function') reject('managed-prompt-unsupported');
      record.promptSelections ??= {};
      const messageHash = createHash('sha256').update(input.message).digest('hex');
      const prior = record.promptSelections[input.requestId];
      if (prior && (prior.messageHash !== messageHash || prior.mode !== input.mode)) reject('managed-prompt-conflict');
      if (commands.hasPromptRequest(agent.session, input.requestId)) {
        return { accepted: true, requestId: input.requestId, selected: prior?.confirmedSelection ?? null, delivery: prior?.confirmedDelivery ?? null, duplicate: true };
      }
      record.promptSelections[input.requestId] = { messageHash, mode: input.mode, selection };
      await persist(record);
      return agents.serializeImageAdmission(agent, async () => {
        let mismatch = false, turnRefusal, intercepted = false, delivery = null;
        const originals = { steer: agent.steer, followup: agent.followup };
        if (typeof originals.steer !== 'function' || typeof originals.followup !== 'function') reject('managed-prompt-unsupported');
        for (const method of ['steer', 'followup']) agent[method] = function(message, ...args) {
          if (message?.source?.rpcId === input.requestId) {
            intercepted = true;
            if (input.expectedTurn !== undefined) {
              const through = input.expectedTurn?.throughSeq;
              const phase = agent.phase;
              if (!Number.isSafeInteger(through) || through < -1 || through > sessionCursor(agent.session) || !phase || typeof phase.kind !== 'string') {
                turnRefusal = 'managed-turn-unknown'; throw new Error(turnRefusal);
              }
              const ended = phase.kind === 'idle' || phase.kind === 'maintenance' || phase.abort?.signal?.aborted === true;
              if (ended) {
                delivery = 'new-turn';
                if (!sameSelectionValue(startSelection, selection)) { turnRefusal = 'managed-turn-ended'; throw new Error(turnRefusal); }
              } else {
                let events;
                if (typeof agent.session?.snapshotEvents === 'function') events = agent.session.snapshotEvents(through + 1);
                else if (Array.isArray(agent.session?.events)) events = agent.session.events.filter(event => Number.isSafeInteger(event.seq) && event.seq > through);
                if (!Array.isArray(events) || events.some(event => !Number.isSafeInteger(event.seq)) || !phase.abort?.signal) {
                  turnRefusal = 'managed-turn-unknown'; throw new Error(turnRefusal);
                }
                if (events.some(event => event.type === 'turn/start' || event.type === 'turn/end')) {
                  turnRefusal = 'managed-turn-changed'; throw new Error(turnRefusal);
                }
                delivery = 'current-turn';
              }
            } else if (input.mode === 'steer') {
              const phase = agent.phase;
              if (!phase || typeof phase.kind !== 'string') { turnRefusal = 'managed-turn-unknown'; throw new Error(turnRefusal); }
              if (phase.kind !== 'idle' && phase.kind !== 'maintenance' && phase.abort?.signal?.aborted !== true) {
                turnRefusal = 'managed-turn-changed'; throw new Error(turnRefusal);
              }
              delivery = 'new-turn';
            } else delivery = 'new-turn';
            const current = typeof agent.model?.current === 'function' ? agent.model.current() : undefined;
            const fallback = service('agentDefaultModel')?.currentSelection();
            if (!sameSelectionValue(current, selection) || (defaultModelOnly && (!fallback || fallback.provider !== selection.provider || fallback.model !== selection.model))) {
              mismatch = true; throw new Error('managed-model-changed');
            }
          }
          return originals[method].call(this, message, ...args);
        };
        try {
          const request = { sessionId: input.sessionId, requestId: input.requestId, mode: input.mode, content: [{ type: 'text', text: input.message }], clientTimeZone: 'Asia/Shanghai' };
          const result = await commands.prompt(request, { kind: 'user', rpcId: input.requestId, clientTimeZone: 'Asia/Shanghai' });
          if (result?.accepted !== true || (!intercepted && !commands.hasPromptRequest(agent.session, input.requestId))) reject('managed-prompt-unconfirmed');
          if (!intercepted) return { accepted: true, requestId: input.requestId, selected: null, delivery: null };
          record.promptSelections[input.requestId].confirmedSelection = selection;
          record.promptSelections[input.requestId].confirmedDelivery = delivery;
          try { await persist(record); } catch (error) { delete record.promptSelections[input.requestId].confirmedSelection; delete record.promptSelections[input.requestId].confirmedDelivery; throw error; }
          return { accepted: true, requestId: input.requestId, selected: selection, delivery };
        } catch (error) {
          if (turnRefusal && !commands.hasPromptRequest(agent.session, input.requestId)) return { accepted: false, status: 'retryable', notSent: true, code: turnRefusal };
          if (mismatch && !commands.hasPromptRequest(agent.session, input.requestId)) return { accepted: false, status: 'retryable', notSent: true, code: 'managed-model-changed' };
          throw error;
        } finally { agent.steer = originals.steer; agent.followup = originals.followup; }
      });
    }); },
    managedPromptReceipt(input) { return serial(input, async () => {
      managedId(input.requestId);
      const record = await load(input), agent = await activate(record);
      const prior = record.promptSelections?.[input.requestId];
      const commands = service('sessionController')?.commands;
      if (typeof commands?.hasPromptRequest !== 'function') reject('managed-prompt-unsupported');
      if (!commands.hasPromptRequest(agent.session, input.requestId)) return { status: 'unknown', requestId: input.requestId };
      return { status: 'accepted', requestId: input.requestId, selected: prior?.confirmedSelection ?? null, delivery: prior?.confirmedDelivery ?? null };
    }); },
    managedHistory(input) { return serial(input, async () => {
      const record = await load(input);
      if (input.treeProtocol !== 1) reject('managed-tree-protocol-required');
      const target = managedId(input.targetSessionId);
      const root = handles.get(keyOf(record))?.agent ?? { id: record.sessionId, status: 'unloaded' };
      let nodes;
      try { nodes = await readManagedTree(service('subagents'), owner.agents, root, record.descendantChanges); }
      catch { reject('managed-tree-unverified'); }
      if (!nodes.some(node => node.sessionId === target)) reject('managed-session-mismatch');
      const inspected = await storedSession(target);
      if (!Array.isArray(inspected?.events)) reject('managed-history-unavailable');
      return { events: inspected.events };
    }); },
    managedAnswer(input) { return serial(input, async () => {
      const record = await load(input);
      if (record.closing || record.cancelled) reject('managed-task-closed');
      if (typeof input.message !== 'string' || !input.message.trim() || input.message.length > 100000) reject('invalid-answer');
      if (input.answerId !== undefined) managedId(input.answerId);
      const prior = input.answerId === undefined ? undefined : record.answers?.find(answer => answer.answerId === input.answerId);
      if (prior) {
        if (prior.message !== input.message) reject('managed-answer-conflict');
        return { accepted: true, ...prior };
      }
      const pending = record.questions.filter(question => question.taskId === record.taskId && question.state === 'pending');
      // The caller may name the question(s) it actually saw. The identity check and
      // the state change happen here, in one serialized turn on the live record, so
      // a question that was consumed or replaced after the caller's preflight is
      // never filled with this answer. A missing identity keeps the old bridge
      // contract for callers that have not been updated.
      const asked = input.questionIds === undefined ? undefined
        : (Array.isArray(input.questionIds) && input.questionIds.length
          && input.questionIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200)
          ? [...new Set(input.questionIds)] : undefined);
      if (input.questionIds !== undefined && !asked) reject('invalid-answer-question');
      if (asked) {
        const live = new Set(pending.map(question => question.id));
        if (!asked.every(id => live.has(id))) {
          return { accepted: false, notSent: true, consumedQuestionIds: [],
            pendingQuestionIds: pending.map(question => question.id),
            pendingQuestions: pending.map(question => question.message) };
        }
      }
      const answering = asked ? pending.filter(question => asked.includes(question.id)) : pending;
      if (!answering.length) {
        if (asked) return { accepted: false, notSent: true, consumedQuestionIds: [],
          pendingQuestionIds: [], pendingQuestions: [] };
        reject('managed-no-pending-question');
      }
      const answeredAt = new Date().toISOString();
      for (const question of answering) Object.assign(question, { state: 'answered', answer: input.message, answeredAt });
      const answer = { answerId: input.answerId ?? `answer-${randomUUID()}`, message: input.message,
        consumedQuestionIds: answering.map(question => question.id),
        continuation: `The controlling agent answered your question(s):\n${answering.map(question => `- ${question.message}`).join('\n')}\n\nAnswer:\n${input.message}\n\nContinue the original task. If complete, provide the final result normally.` };
      record.answers ??= [];
      record.answers.push(answer);
      record.activity = 'answer-ready';
      await persist(record);
      return { accepted: true, ...answer };
    }); },
    managedCancel(input) { return serial(input, async () => {
      const record = await load(input);
      if (record.closing) reject('managed-agent-closing');
      const agent = await activate(record);
      const subagents = service('subagents');
      if (typeof subagents?.drainDescendants !== 'function') reject('managed-tree-unavailable');
      let nodes;
      try { nodes = await readManagedTree(subagents, owner.agents, agent, record.descendantChanges); }
      catch { reject('managed-tree-unverified'); }
      record.cancelled = true;
      for (const question of record.questions) if (question.state === 'pending') question.state = 'cancelled';
      record.activity = 'cancelling';
      await persist(record);
      agent.cancel({ kind: 'user' });
      await subagents.drainDescendants([agent]);
      const key = keyOf(record);
      const handle = handles.get(key);
      if (!handle) reject('managed-handle-unavailable');
      await handle.dispose();
      handles.delete(key); bindings.delete(key); runtime.managedAgents.delete(agent);
      record.cancellationSettled = true;
      record.activity = agent.status === 'running' ? 'cancelling' : 'cancelled';
      await persist(record);
      return { ...snapshot(record, agent), cancelled: true, cancelRequested: true, pendingInputCleared: true };
    }); },
    managedDestroy(input) { return serial(input, async () => {
      if (input.reportProtocol !== 1) reject('managed-report-protocol-required');
      let record;
      try { record = await load(input); }
      catch (error) {
        if (error.controlCode !== 'managed-agent-not-found') throw error;
        managedId(input.sessionId);
        const persistence = service('sessionPersistence');
        const registry = service('workspaceRegistry');
        if (!persistence?.stat || !registry?.list) reject('managed-cleanup-verification-unavailable');
        if (owner.agents.get(input.sessionId) || owner.sessions.get(input.sessionId) || await persistence.stat(input.sessionId)
            || registry.list().some(project => project.sessionIds.includes(input.sessionId))
            || registry.pinnedSessionIds?.includes(input.sessionId) || registry.archivedSessionIds?.includes(input.sessionId)
            || service('sessionProjectionCache')?.requireTable().get(input.sessionId)) reject('managed-agent-not-found');
        // Index rows are derived data and may outlive a finished delete until the next
        // search reconciles them, so they never prove cleanup unfinished; only the live
        // observation still answering for the session does.
        const query = service('sessionQuery');
        if (query && typeof query._observations?.cache?.has !== 'function') reject('managed-cleanup-verification-unavailable');
        if (query?._observations?.cache?.has(input.sessionId)) reject('managed-cleanup-incomplete');
        return { sessionId: input.sessionId, released: true, dataDeleted: true, destroyed: true, alreadyDestroyed: true };
      }
      if (record.treeProtocol === 1 && input.treeProtocol !== 1) reject('managed-tree-protocol-required');
      const key = keyOf(record);
      const agent = record.closing ? handles.get(key)?.agent : await activate(record);
      if (!record.cleanupTree) {
        const subagents = service('subagents');
        if (typeof subagents?.drainDescendants !== 'function') reject('managed-tree-unavailable');
        const root = agent ?? { id: record.sessionId, status: 'unloaded' };
        let nodes;
        try { nodes = await readManagedTree(subagents, owner.agents, root, record.descendantChanges); }
        catch { reject('managed-tree-unverified'); }
        if (nodes.some(node => node.mode === 'external' || (node !== nodes[0] && !['one-shot', 'continuable'].includes(node.mode)))) reject('managed-external-cleanup-unsupported');
        record.closing = true;
        record.activity = 'cleaning';
        await persist(record);
        if (agent) {
          agent.cancel({ kind: 'user' });
          await subagents.drainDescendants([agent]);
        } else if (nodes.some(node => owner.agents.get(node.sessionId) || owner.sessions.get(node.sessionId))) {
          reject('managed-release-incomplete');
        }
        try { nodes = await readManagedTree(subagents, owner.agents, root, record.descendantChanges); }
        catch { reject('managed-tree-unverified'); }
        if (nodes.some(node => node.mode === 'external' || (node !== nodes[0] && !['one-shot', 'continuable'].includes(node.mode)))) reject('managed-external-cleanup-unsupported');
        if (!agent && nodes.some(node => owner.agents.get(node.sessionId) || owner.sessions.get(node.sessionId))) reject('managed-release-incomplete');
        const plans = [];
        for (const node of nodes.slice().reverse()) {
          const candidate = node.sessionId === record.sessionId ? record : { ...record, sessionId: node.sessionId, cleanup: undefined };
          if (candidate !== record) {
            const { header } = await storedSession(node.sessionId);
            if (header?.id !== node.sessionId || typeof header.cwd !== 'string') reject('managed-tree-unverified');
            const relative = path.relative(record.workspace, await realpath(header.cwd));
            if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) reject('managed-tree-unverified');
          }
          const plan = await cleanupPlan(candidate, owner.agents.get(node.sessionId), { persistPlan: false });
          if (!await validateOwnedDirectory(plan.sessionDirectory, plan.sessionRoot, node.sessionId)) reject('managed-cleanup-path-unavailable');
          if (plan.spillDirectory) await validateOwnedDirectory(plan.spillDirectory, plan.spillRoot, plan.spillName);
          plans.push({ sessionId: node.sessionId, ...plan });
        }
        record.cleanupTree = plans;
        await persist(record);
      }
      record.closing = true;
      record.activity = 'cleaning';
      await persist(record);
      const handle = handles.get(key);
      if (handle) {
        handle.agent.cancel({ kind: 'user' });
        await service('subagents').drainDescendants([handle.agent]);
        await handle.dispose();
        handles.delete(key);
        bindings.delete(key);
      }
      for (const cleanup of record.cleanupTree) {
        if (owner.agents.get(cleanup.sessionId) || owner.sessions.get(cleanup.sessionId)) reject('managed-release-incomplete');
        await removeOwnedDirectory(cleanup.sessionDirectory, cleanup.sessionRoot, cleanup.sessionId);
        if (cleanup.spillDirectory) await removeOwnedDirectory(cleanup.spillDirectory, cleanup.spillRoot, cleanup.spillName);
      }
      const persistence = service('sessionPersistence');
      for (const cleanup of record.cleanupTree) persistence.coldLogMemo?.delete(cleanup.sessionId);
      const projectionCache = service('sessionProjectionCache');
      // Disposal emits a final asynchronous cache write; enqueue our final delete after it.
      if (projectionCache) {
        if (agent) await projectionCache.flushSoft(agent.session, 'managed-delete');
        for (const cleanup of record.cleanupTree) await projectionCache.requireTable().delete(cleanup.sessionId);
      }
      const registry = service('workspaceRegistry');
      for (const cleanup of record.cleanupTree) {
        await registry.get(record.workspaceId).detachSession(cleanup.sessionId);
        await registry.unpinSession(cleanup.sessionId);
        await registry.unarchiveSession(cleanup.sessionId);
        for (const field of ['headers', 'sessionPaths', 'invalidSessionPaths', 'missingSessionPaths']) registry[field]?.delete(cleanup.sessionId);
      }
      const query = service('sessionQuery');
      // Every search reconciles the index before it answers, so a deleted session can
      // never come back from it; forcing that full scan here takes minutes and holds
      // the shared query queue. Only the observation cache is cleared.
      for (const cleanup of record.cleanupTree) query?._observations?.cache?.delete(cleanup.sessionId);
      for (const cleanup of record.cleanupTree) if (await persistence.stat(cleanup.sessionId)) reject('managed-cleanup-incomplete');
      await (writes.get(key) ?? Promise.resolve());
      await storage.remove(key);
      records.delete(key);
      writes.delete(key);
      return { sessionId: record.sessionId, released: true, dataDeleted: true, destroyed: true };
    }); },
  };
  // Existing registrations belong to their Agent scopes. Swap only their
  // callbacks so hot code uses the shared record and current implementation.
  for (const binding of bindings.values()) {
    if (owner.agents.get(binding.record.sessionId) === binding.agent) installTools(binding.agent.ctx, binding.agent, binding.record);
  }
  return methods;
}

function reject(code) {
  const error = new Error(code);
  error.controlCode = code;
  throw error;
}

function latest(events, type) {
  if (!Array.isArray(events)) return undefined;
  for (let i = events.length - 1; i >= 0; i--) if (events[i].type === type) return events[i].data;
}

function modelValue(value) {
  if (!value || typeof value.provider !== 'string' || !value.provider.trim() || value.provider.length > 200
      || typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200
      || (value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string'
        || !value.reasoningEffort.trim() || value.reasoningEffort.length > 100))) reject('invalid-model');
  return { provider: value.provider, model: value.model,
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }) };
}

function sameSelectionValue(left, right) {
  return left?.provider === right?.provider && left?.model === right?.model
    && (left?.reasoningEffort ?? undefined) === (right?.reasoningEffort ?? undefined);
}

async function inWorkspace(candidate, workspace) {
  if (typeof candidate !== 'string' || typeof workspace !== 'string' || !path.isAbsolute(workspace)) return false;
  const [root, target] = await Promise.all([realpath(workspace), realpath(candidate)]);
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolveAgent(ctx, sessionId, workspace, activate) {
  if (!ID.test(sessionId ?? '')) reject('invalid-session');
  let agent = ctx.agents.get(sessionId);
  let activated = false;
  if (!agent && activate) {
    const controller = ctx.get('sessionController');
    if (controller) {
      const { header } = await readStoredSession(name => ctx.get(name), sessionId);
      if (!await inWorkspace(header?.cwd, workspace)) reject('workspace-mismatch');
      const result = await controller.resolveAgent(sessionId);
      if (result.error) reject('agent-unavailable');
      agent = result.agent;
    } else {
      const proxy = ctx.get('apiProxy');
      if (!proxy) reject('host-api-unavailable');
      const listed = await proxy.sessions.list({ rpcId: 'codex-capabilities-list', payload: {} });
      const row = listed.result?.value?.items?.find(item => item.sessionId === sessionId);
      if (!await inWorkspace(row?.cwd, workspace)) reject('workspace-mismatch');
      if (row.origin === 'subagent') reject('subagent-owned');
      const loaded = await proxy.sessions.models({ rpcId: 'codex-capabilities-load', payload: { sessionId } });
      if (!loaded.result?.ok) reject('agent-unavailable');
      agent = ctx.agents.get(sessionId);
    }
    activated = true;
  }
  if (!agent) reject('agent-not-loaded');
  if (!await inWorkspace(agent.session.header.cwd, workspace)) reject('workspace-mismatch');
  return { agent, activated };
}

/** Return a durable ordinary session's final event sequence without loading its Agent. */
async function historyCursor(ctx, sessionId, workspace) {
  if (!ID.test(sessionId ?? '')) reject('invalid-session');
  const { header, events } = await readStoredSession(name => ctx.get(name), sessionId);
  if (!await inWorkspace(header?.cwd, workspace)) reject('workspace-mismatch');
  if (header?.origin === 'subagent') reject('subagent-owned');
  if (!Array.isArray(events)) reject('history-cursor-unavailable');
  const event = events.findLast(value => Number.isSafeInteger(value?.seq) && value.seq >= 0);
  return { sessionId, throughSeq: event?.seq ?? -1 };
}

/** Read registered schemas and effective policy without executing any tool or model. */
export function liveModelSelection(agent) {
  if (!agent) return undefined;
  const session = agent.session;
  const projections = agent.ctx?.get('sessionProjections')?.snapshot(session)?.values ?? {};
  const value = projections.modelSelection?.next ?? projections.modelSelection?.lastUsed
    ?? latest(session.events ?? [], 'model/selection') ?? session.requestHeader?.()?.config ?? agent.options;
  return value?.provider && value?.model ? modelValue(value) : undefined;
}

export function capabilitySnapshot(agent, { activated = false } = {}) {
  const ctx = agent.ctx;
  const get = key => ctx.get(key);
  const session = agent.session;
  const tools = get('tools');
  if (!tools || typeof tools.schemas !== 'function') reject('tool-registry-unavailable');
  const projections = get('sessionProjections')?.snapshot(session)?.values ?? {};
  const sandbox = get('sandboxPolicy');
  const approval = get('approval');
  const permission = get('permissionPresets');
  const plan = get('planMode');
  const schemas = tools.schemas(agent).map(schema => {
    const definition = tools.get(schema.name, agent);
    return { ...schema,
      ...(definition?.output?.schema === undefined ? {} : { outputSchema: definition.output.schema }),
      ...(definition?.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
      availability: 'visible-in-session', permissionEvaluation: 'at-call-time',
    };
  });
  return {
    version: 1, capturedAt: new Date().toISOString(), sessionId: agent.id,
    cwd: session.header.cwd, status: agent.status, activated,
    agentPreset: projections.agentPreset ?? session.header.agentPreset ?? null,
    model: liveModelSelection(agent) ?? null,
    tools: schemas, totalTools: schemas.length,
    permissions: {
      sandbox: sandbox ? sandbox.resolve({ session }) : { available: false },
      processSandbox: { available: Boolean(get('sandbox')), implementation: get('sandbox')?.constructor?.name ?? null },
      approval: approval ? { policy: approval.overrideOf(session) ?? approval.config.policy ?? 'ask',
        source: approval.overrideOf(session) === undefined ? 'composition-default' : 'session-override' } : { available: false },
      preset: permission ? { current: projections.permissions?.currentValue
        ?? permission.current(Array.isArray(session.events) ? session.events : session), options: [...permission.names] } : { available: false },
      plan: projections.plan ? { ...projections.plan, source: 'session-projection' }
        : plan || schemas.some(tool => tool.name === 'exit_plan_mode')
          ? { active: latest(session.events, 'plan/mode')?.active ?? false, pending: null, source: 'session-events', pendingStateKnown: false }
          : { available: false },
      limitations: ['Tool schemas are the complete currently visible registry, not a guarantee that every argument is permitted.',
        'Argument-specific approval, filesystem observation, tool guards, external credentials and provider availability are evaluated when called.'],
    },
    complete: true, source: 'live-agent-services', modelRequestsStarted: 0,
  };
}

/**
 * Keep the last unexpected host failure beside the managed state. The caller only ever
 * receives a generic code, so without this the real cause of a failed resume or status
 * is lost. Local file only, and a failure to write it never changes the answer.
 */
async function noteHostFailure(stateDirectory, endpoint, error) {
  if (typeof stateDirectory !== 'string' || !stateDirectory) return;
  try {
    await writeFile(path.join(path.dirname(stateDirectory), 'host-last-error.json'), JSON.stringify({
      at: new Date().toISOString(), endpoint, name: error?.name, code: error?.code,
      message: String(error?.message ?? error).slice(0, 2000), stack: String(error?.stack ?? '').slice(0, 6000),
    }), { mode: 0o600 });
  } catch { /* Diagnostics must never change the answer. */ }
}

/** Build the fixed authenticated host methods; no arbitrary tool execution is exposed. */
export function createHostHandler(ctx, token, options = {}) {
  if (!/^[a-f0-9]{64}$/.test(token ?? '')) throw new Error('Invalid host bridge credential.');
  const tempHost=createDshTempHost(ctx);
  const owner=typeof ctx.root?.get==='function'?ctx.root:ctx;
  const observationKey=Symbol.for('futureaide-control.temp-observer');
  let observer=owner[observationKey];
  if (!observer) {
    observer={current:tempHost,seen:new WeakSet()}; owner[observationKey]=observer;
    const bind=agent=>{
      if (!agent || observer.seen.has(agent) || typeof agent.ctx?.on!=='function') return;
      observer.seen.add(agent);
            agent.ctx.on('tools/result',(exec)=>{if(exec?.agent===agent) {
        const run=async()=>{if(!await observer.current.canObserve())return; for(let attempt=0;attempt<3;attempt++){await observer.current.observeSession(agent.id); if(attempt<2) await new Promise(resolve=>{const t=setTimeout(resolve,350);t.unref?.();});}};
        const timer=setTimeout(()=>void run().catch(()=>{}),100); timer.unref?.();
      }});
    };
    if (typeof owner.on==='function') owner.on('agent/created',({agent})=>bind(agent));
    if (typeof owner.agents?.list==='function') for (const agent of owner.agents.list()) bind(agent);
  } else observer.current=tempHost;
  const cleanup = createDshHostCleanup(ctx, options);
  const residual = createDshResidualHost(ctx);
  const managed = options.stateDirectory || options.store ? createManagedHost(ctx, { ...options, cleanup }) : undefined;
  return async (endpoint, payload) => {
    try {
      const input = payload?.args;
      const supplied = input?.token;
      if (typeof supplied !== 'string' || supplied.length !== token.length
          || !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) reject('bridge-auth-required');
      if (/^(?:cleanup|managedCleanup)/.test(endpoint)) {
        const configured = owner.get('sessionPersistence')?.config?.root;
        const expected = input.cleanupRoot;
        if (!path.isAbsolute(configured ?? '') || !path.isAbsolute(expected?.path ?? '')) reject('cleanup-root-unverified');
        const canonical = await realpath(path.dirname(configured));
        const info = await lstat(canonical, { bigint: true });
        const samePath = process.platform === 'win32' ? canonical.toLowerCase() === expected.path.toLowerCase() : canonical === expected.path;
        if (!samePath || !info.isDirectory() || !info.ino || String(info.dev) !== expected.dev || String(info.ino) !== expected.ino) reject('cleanup-root-mismatch');
      }
      if (endpoint === 'cleanupHistory') return {ok:true,value:await cleanup.history(input.item)};
      if (endpoint === 'cleanupInventory') return { ok: true, value: await cleanup.inventory() };
      if (endpoint === 'cleanupInspect') return { ok: true, value: await cleanup.inspect(input.item) };
      if (endpoint === 'cleanupResidualInspect') return {ok:true,value:await residual.inspectResidual(input)};
      if (endpoint === 'cleanupResidualRemove') return {ok:true,value:await residual.removeResidual(input)};
      if (endpoint === 'cleanupFinalize') return { ok: true, value: await cleanup.finalize(input) };
      if (endpoint === 'cleanupRestore') return { ok: true, value: await cleanup.restore(input) };
      if (endpoint === 'cleanupRemove') return { ok: true, value: await cleanup.remove(input.item, input.context) };
      if (endpoint === 'cleanupTempUsage') return { ok: true, value: await tempHost.tempUsage(input.path) };
      if (managed && MANAGED_METHODS.includes(endpoint)) return { ok: true, value: await managed[endpoint](input) };
      if (!['capabilities', 'historyCursor', 'ping'].includes(endpoint)) reject('unknown-method');
      if (endpoint === 'ping') return { ok: true, value: { version: 1, revision: options.revision ?? null, ...(managed ? { treeProtocol: 1, reportProtocol: 1 } : {}),
        methods: ['capabilities', 'historyCursor', 'cleanupInventory', 'cleanupInspect', 'cleanupHistory', 'cleanupRemove', 'cleanupRestore', 'cleanupFinalize', 'cleanupTempUsage', 'cleanupResidualInspect', 'cleanupResidualRemove', ...(managed ? MANAGED_METHODS : [])], pid: process.pid,
        ...(managed && options.defaultModelOnly === true ? { modelPolicy: 'default-only' } : {}),
        compatibility: checkHostCompatibility(name => ctx.get(name)) } };
      if (endpoint === 'historyCursor') return { ok: true, value: await historyCursor(ctx, input.sessionId, input.workspace) };
      const { agent, activated } = await resolveAgent(ctx, input.sessionId, input.workspace, input.activate === true);
      return { ok: true, value: capabilitySnapshot(agent, { activated }) };
    } catch (error) {
      if (!error.controlCode) await noteHostFailure(options.stateDirectory, endpoint, error);
      return { ok: false, error: { code: error.controlCode ?? 'host-operation-failed',
        message: error.controlCode ?? 'The host operation failed; no private runtime configuration is returned.' } };
    }
  };
}

/** Mount an authenticated side channel through the host's normal Connection plugin. */
export async function apply(ctx, config) {
  if (typeof config?.credentialFile !== 'string' || !path.isAbsolute(config.credentialFile)) throw new Error('credentialFile must be absolute.');
  const record = JSON.parse(await readFile(config.credentialFile, 'utf8'));
  const handler = createHostHandler(ctx, record.token, {
    stateDirectory: config.managedStateDirectory ?? path.join(path.dirname(config.credentialFile), 'managed-host'),
    credentialDirectory: path.dirname(config.credentialFile),
    revision: new URL(import.meta.url).searchParams.get('v'),
    defaultModelOnly: config.defaultModelOnly === true,
    feedbackNode: config.feedbackNode, feedbackConfigFile: config.feedbackConfigFile,
    graceMs: config.cleanupGraceMs ?? 86400000,
  });
  const key = Symbol.for('futureaide-control.host-handler');
  const current = ctx.root[key];
  if (current && typeof current.dispose !== 'function') { current.handler = handler; return; }
  if (current) await current.dispose();
  const binding = { handler };
  // New Connection services expose register(owner, ...); pass our injected context
  // explicitly, because the rpc getter retains the Connection provider's context.
  const dispose = await (typeof ctx.connection.register === 'function'
    ? ctx.connection.register(ctx, '/futureaide-control', (...args) => binding.handler(...args))
    : ctx.connection.rpc.handle('/futureaide-control', (...args) => binding.handler(...args), { authority: 'loopback' }));
  // A replacement fiber owns its route; disposing the previous fiber must not
  // remove the replacement's route or leave an active bridge without one.
  let disposed = false;
  binding.dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (typeof dispose === 'function') await dispose();
    if (ctx.root[key] === binding) delete ctx.root[key];
  };
  ctx.root[key] = binding;
  ctx.effect(() => binding.dispose);
  if (config.discoveryFile !== undefined) {
    if (typeof config.discoveryFile !== 'string' || !path.isAbsolute(config.discoveryFile)
        || typeof config.dataRoot !== 'string' || !path.isAbsolute(config.dataRoot)) throw new Error('Discovery paths must be absolute.');
    const instanceKey = Symbol.for('futureaide-control.host-instance');
    const instanceId = ctx.root[instanceKey] ??= randomUUID();
    const launchUrl = await ctx.connection.authenticatedUrl(`http://127.0.0.1:${ctx.webServer.port}`);
    await mkdir(path.dirname(config.discoveryFile), { recursive: true, mode: 0o700 });
    await writeFile(config.discoveryFile, JSON.stringify({ version: 1, application: 'dsh', pid: process.pid,
      instanceId, dataRoot: config.dataRoot, launchUrl, startedAt: new Date().toISOString() }), { mode: 0o600 });
  }
}
