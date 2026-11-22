import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {lstat,readdir,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {listProfiles,loadConfig} from './config.mjs';
const hash=v=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
const eq=(a,b)=>typeof a==='string'&&typeof b==='string'&&path.resolve(a).toLowerCase()===path.resolve(b).toLowerCase();
const valid=v=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(v);
const uuid=/^session-[a-f0-9]{8}-[a-f0-9-]{27}$/i;
async function entries(dir) {try{return await readdir(dir,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return [];throw e}}
async function physical(dir) {return (await realpath(dir)).toLowerCase()}
async function safeRead(file){const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe-evidence-file');return {body:JSON.parse(await readFile(file,'utf8')),bytes:s.size};}
async function roster(file) {
  try {const s=await lstat(file);if(!s.isFile()||s.isSymbolicLink())throw Error('unsafe-roster');}
  catch(e){if(e.code==='ENOENT')return [];throw e}
  const db=new DatabaseSync(file,{readOnly:true});try{
    db.exec('BEGIN');const rows=db.prepare('SELECT body FROM agents').all();const result=rows.map(r=>JSON.parse(r.body));db.exec('COMMIT');return result;
  }finally{db.close()}
}
async function fileSizeTree(dir) {
  let bytes=0;
  for(const e of await entries(dir)){const file=path.join(dir,e.name),s=await lstat(file);if(s.isSymbolicLink())throw Error('attachment-link');if(s.isDirectory())bytes+=await fileSizeTree(file);else if(s.isFile())bytes+=s.size;else throw Error('attachment-special-file');}
  return bytes;
}
/** Read exact, same-root records only. Any unreadable profile/source makes absence unproved. */
export async function collectDshEvidence(config) {
  const result={complete:true,errors:[],roster:[],legacy:[],sidecars:[],receipts:[],deletedRoots:[],orphanProofs:[],deletedSessions:[],stagedSessions:[],projections:[],sessions:[],attachments:null};
  if(!config?.configFile || !config?.dshDataRoot){return {...result,complete:false,errors:['configuration-domain-unverified']};}
  let domain;
  try {domain=await physical(config.dshDataRoot)}catch{return {...result,complete:false,errors:['dsh-root-unavailable']}}
  const sidecarRoots=new Set();
  try {
    const profiles=await listProfiles(config.configFile), names=[null,...profiles.items.map(x=>x.profile)];
    for(const name of names){
      const p=await loadConfig(config.configFile,name===null?undefined:name);
      let same=false;try{same=await physical(p.dshDataRoot)===domain}catch{result.complete=false;result.errors.push('profile-root-unavailable:'+String(name));continue}
      if(!same)continue;
      sidecarRoots.add(p.managedStateDirectory??path.join(path.dirname(p.hostBridgeFile),'managed-host'));
      try {for(const entry of await entries(path.join(p.stateDirectory,'requests'))){
        if(entry.isSymbolicLink()){result.complete=false;result.errors.push('receipt-link:'+entry.name);continue}
        if(!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
        const value=(await safeRead(path.join(p.stateDirectory,'requests',entry.name))).body;
        if(value.kind!=='create')continue;
        const key=hash(['create',value.sessionId,value.requestId]);
        const sessionId='session-codex-'+hash([p.stateDirectory,p.workspace,value.requestId]).slice(0,32);
        let sameHost=false;try{sameHost=await physical(value.instance?.dataRoot)===domain}catch{}
        if(entry.name!==key+'.json' || value.sessionId!==sessionId || value.status!=='accepted' || value.result?.sessionId!==sessionId || value.result?.accepted!==true || !sameHost){result.complete=false;result.errors.push('create-receipt-unverified:'+entry.name);continue}
        result.receipts.push({sessionId,workspace:p.workspace,profile:name,path:path.join(p.stateDirectory,'requests',entry.name)});
      }}catch{result.complete=false;result.errors.push('receipts-unreadable:'+String(name))}
      try{for(const item of await roster(path.join(p.stateDirectory,'roster.sqlite'))){
        if((item.target??'dsh')==='dsh' && valid(item.sessionId)) result.roster.push({sessionId:item.sessionId,ownerId:item.ownerId,agentId:item.agentId,workspace:item.workspace,profile:name});
      }}catch(e){result.complete=false;result.errors.push('roster-unreadable:'+String(name));}
    }
  }catch(e){result.complete=false;result.errors.push('profile-enumeration-unavailable')}
  const base=path.dirname(config.configFile),legacyRoot=config.registryDirectory??path.join(base,'agents');
  try {for(const e of await entries(legacyRoot)){
    if(e.isSymbolicLink()){result.complete=false;result.errors.push('legacy-registry-link:'+e.name);continue}
    if(!e.isDirectory()||!/^agent-[a-f0-9]{32}$/.test(e.name))continue;
    const item=(await safeRead(path.join(legacyRoot,e.name,'agent.json'))).body;
    if(item.agentId!==e.name || !valid(item.sessionId) || !item.transport?.dataRoot){result.complete=false;result.errors.push('legacy-binding-unverified:'+e.name);continue}
    let same=false;try{same=await physical(item.transport.dataRoot)===domain}catch{result.complete=false;result.errors.push('legacy-domain-unavailable:'+e.name);continue}
    if(same)result.legacy.push({sessionId:item.sessionId,agentId:item.agentId,workspace:item.workspace});
  }}catch(e){result.complete=false;result.errors.push('legacy-registry-unreadable')}
  const sidecarRoot=config.managedStateDirectory??path.join(path.dirname(config.hostBridgeFile??path.join(base,'host-bridge.json')),'managed-host');
  sidecarRoots.add(sidecarRoot);
  try {for(const currentRoot of sidecarRoots) for(const e of await entries(currentRoot)){
    if(e.isSymbolicLink()){result.complete=false;result.errors.push('sidecar-link:'+e.name);continue}
    if(!e.isFile()||!/^([a-f0-9]{64})\.json$/.test(e.name))continue;
    const file=path.join(currentRoot,e.name),{body,bytes}=await safeRead(file);
    const expected=createHash('sha256').update(`${body.ownerId}\n${body.agentId}`).digest('hex');
    if(expected+'.json'!==e.name || !valid(body.ownerId)||!valid(body.agentId)||!valid(body.sessionId)||!path.isAbsolute(body.workspace??'')){result.complete=false;result.errors.push('sidecar-identity-invalid:'+e.name);continue}
    result.sidecars.push({sessionId:body.sessionId,ownerId:body.ownerId,agentId:body.agentId,workspace:body.workspace,path:file,bytes});
  }}catch(e){result.complete=false;result.errors.push('sidecar-unreadable')}
  try {
    const tickets=path.join(config.dshDataRoot,'.futureaide-control','staging');
    for(const entry of await entries(tickets)){
      if(entry.isSymbolicLink() || !entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)){result.complete=false;result.errors.push('ticket-layout-unverified:'+entry.name);continue}
      const filename=path.join(tickets,entry.name,'ticket.json'),{body}=await safeRead(filename);
      if(![1,2].includes(body.version) || body.ticket!==entry.name || !valid(body.sessionId)){result.complete=false;result.errors.push('ticket-invalid:'+entry.name);continue}
      const ticketDir=path.join(tickets,entry.name),sessionRoot=path.join(config.dshDataRoot,'sessions');
      const nodes=body.version===1?[{sessionId:body.sessionId,source:body.source,staged:body.staged}]:body.nodes;
      if(!Array.isArray(nodes)||!nodes.length||new Set(nodes.map(n=>n.sessionId)).size!==nodes.length||!nodes.some(n=>n.sessionId===body.sessionId)){
        result.complete=false;result.errors.push('ticket-nodes-invalid:'+entry.name);continue;
      }
      const invalid=nodes.some(node=>{
        if(!valid(node.sessionId)||typeof node.source!=='string'||!path.isAbsolute(node.source))return true;
        const relative=path.relative(sessionRoot,node.source);
        return !relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)||path.basename(node.source)!==node.sessionId
          || (body.version===2 && !eq(node.staged,path.join(ticketDir,node.sessionId)));
      });
      if(invalid){result.complete=false;result.errors.push('ticket-source-unverified:'+entry.name);continue}
      if(['planned','staged','finalizing'].includes(body.state)) {for(const node of nodes)result.stagedSessions.push({sessionId:node.sessionId,ticket:entry.name,state:body.state});continue;}
      if(body.state!=='deleted')continue;
      for(const node of nodes)result.deletedSessions.push({sessionId:node.sessionId,ticket:entry.name,version:body.version});
      if (body.version===2 && ((body.managed && valid(body.managed.ownerId) && valid(body.managed.agentId) && typeof body.managed.version==='string') || (!body.managed && (uuid.test(body.sessionId) || body.ordinaryEvidence?.receiptPath))) && !result.roster.some(x=>x.sessionId===body.sessionId)) {
        const rootNode=nodes.find(n=>n.sessionId===body.sessionId);
        let rootMissing=false; try {await lstat(rootNode.source);} catch(e) {if(e.code==='ENOENT') rootMissing=true; else throw e;}
        if (rootMissing && rootNode.header?.id===body.sessionId) for (const node of nodes) {
          if (node.header?.id!==node.sessionId || node.header.origin!=='subagent' || node.header.parentSession!==body.sessionId || !/^[a-f0-9]{64}$/i.test(node.contentHash??'') || typeof node.log!=='string') continue;
          try {
            const dir=await lstat(node.source); if (!dir.isDirectory() || dir.isSymbolicLink() || !eq(await realpath(node.source),node.source)) continue;
            const file=path.join(node.source,path.basename(node.log)), before=await lstat(file,{bigint:true});
            if(!before.isFile() || before.isSymbolicLink() || !eq(await realpath(file),file)) continue;
            const bytes=await readFile(file), after=await lstat(file,{bigint:true});
            if(before.ino!==after.ino || before.dev!==after.dev || before.size!==after.size || before.mtimeNs!==after.mtimeNs || createHash('sha256').update(bytes).digest('hex')!==node.contentHash) continue;
            result.orphanProofs.push({sessionId:node.sessionId,rootId:body.sessionId,deletedTicket:entry.name,header:node.header,contentHash:node.contentHash,kind:body.managed?'managed':'direct'});
          } catch(e) {if(e.code!=='ENOENT') throw e;}
        }
      }
      const matching=result.sidecars.filter(x=>x.sessionId===body.sessionId && (body.version===2 || (x.ownerId===body.managed?.ownerId && x.agentId===body.managed?.agentId && eq(x.workspace,body.header?.cwd))));
      if(matching.length===1 && !result.roster.some(x=>x.sessionId===body.sessionId))result.deletedRoots.push({sessionId:body.sessionId,ticket:entry.name,ownerId:matching[0].ownerId,agentId:matching[0].agentId,version:body.version});
    }
  }catch(error){result.complete=false;result.errors.push('deletion-ticket-enumeration-unavailable:'+(error.code??error.message))}  try {
    const projection=path.join(config.dshDataRoot,'storages','session_projcache','sessions');
    for(const e of await entries(projection)){
      if(e.isSymbolicLink()){result.complete=false;result.errors.push('projection-link:'+e.name);continue}
      if(!e.isFile() || !e.name.endsWith('.json')){result.complete=false;result.errors.push('projection-layout-unverified:'+e.name);continue}
      const id=e.name.slice(0,-5);if(!valid(id)){result.complete=false;result.errors.push('projection-id-invalid:'+e.name);continue}
      const stat=await lstat(path.join(projection,e.name));result.projections.push({sessionId:id,path:path.join(projection,e.name),bytes:stat.size});
    }
  }catch{result.complete=false;result.errors.push('projection-enumeration-unavailable')}
  try {
    const sessionRoot=path.join(config.dshDataRoot,'sessions');
    for(const group of await entries(sessionRoot)){
      if(group.isSymbolicLink() || !group.isDirectory()){result.complete=false;result.errors.push('session-layout-unverified:'+group.name);continue}
      const groupDir=path.join(sessionRoot,group.name);
      for(const e of await entries(groupDir)){
        if(e.isSymbolicLink() || !e.isDirectory() || !valid(e.name)){result.complete=false;result.errors.push('session-entry-unverified:'+e.name);continue}
        result.sessions.push({sessionId:e.name,path:path.join(groupDir,e.name),bytes:await fileSizeTree(path.join(groupDir,e.name))});
      }
    }
  }catch{result.complete=false;result.errors.push('session-enumeration-unavailable')}
  try {result.attachments=await fileSizeTree(path.join(config.dshDataRoot,'attachments'))}catch{result.errors.push('attachment-size-unavailable')}
  return result;
}

/** Rows are only classified; this module never mutates native files or indexes. */
export function classifyDshInventory(native,evidence,config) {
  const raw=Array.isArray(native?.items)?native.items:[], byId=new Map(raw.map(x=>[x.sessionId??x.id,x]));
  const owned=new Map();
  const add=(entry,source)=>{const found=owned.get(entry.sessionId)??[];found.push({...entry,source});owned.set(entry.sessionId,found)};
  for(const item of evidence.roster)add(item,'roster');for(const item of evidence.legacy)add(item,'legacy');
  for(const item of raw){const id=item.sessionId??item.id,claims=owned.get(id);if(claims?.some(c=>c.source==='roster'||c.source==='legacy'))for(const child of item.treeIds??[])if(child!==id)add({sessionId:child,parentSessionId:id},'managed-descendant');}
  // Sidecars count as evidence only after exact native ID, workspace and hashed owner/agent binding agree.
  for(const item of evidence.sidecars){const native=byId.get(item.sessionId);if(native && eq(native.row?.header?.cwd,item.workspace))add(item,'sidecar');}
  const marked=raw.map(item=>{
    const id=item.sessionId??item.id,claims=owned.get(id)??[],rostered=claims.some(c=>c.source==='roster'||c.source==='legacy'||c.source==='managed-descendant');
    let ownership='unknown',reason='dsh-origin-unverified';
    if(rostered){ownership='managed';reason='managed-via-roster';}
    else if(claims.some(c=>c.source==='sidecar')){ownership='unknown';reason='managed-sidecar-owner-status-unverified';}
    else if(evidence.complete && item.row?.header?.origin==='subagent'){
      const proof=(evidence.orphanProofs??[]).find(p=>p.sessionId===id && hash(p.header)===hash(item.row.header));
      if(proof){ownership=proof.kind==='direct'?'direct-orphan':'orphan';reason=proof.kind==='direct'?'direct-root-confirmed-deleted':'managed-root-confirmed-deleted';}
      else {
        let parent=item.row.header.parentSession, ancestor;const walked=new Set([id]);let safe=true;
        while(valid(parent) && !walked.has(parent)) {
          walked.add(parent); if(owned.has(parent)){safe=false;break}
          ancestor=byId.get(parent); if(!ancestor){safe=false;break}
          if(ancestor.row?.header?.origin!=='subagent')break;
          parent=ancestor.row.header.parentSession;
        }
        if(safe && ancestor && ancestor.row?.header?.origin!=='subagent' && !ancestor.row?.header?.parentSession
          && (uuid.test(ancestor.sessionId??ancestor.id) || evidence.receipts?.some(r=>r.sessionId===(ancestor.sessionId??ancestor.id) && eq(r.workspace,ancestor.row.header.cwd)))) {
          ownership='direct-subtree';reason='direct-parent-chain-confirmed';
        }
      }
    }    else if(evidence.complete && evidence.receipts?.some(receipt=>receipt.sessionId===id && eq(receipt.workspace,item.row?.header?.cwd))){ownership='direct';reason='confirmed-ordinary-create-receipt';}
    else if(evidence.complete && uuid.test(id??'') && item.row?.header?.id===id && item.row.header.origin!=='subagent' && !item.row.header.parentSession){ownership='direct';reason=item.reason??'direct-session';}
    const nativeBytes=Number.isFinite(item.bytes)?item.bytes:null;
    const childIds=Array.isArray(item.treeIds)?item.treeIds:[id];
    // A parent with any registered native descendant is never a direct deletion route.
    if(ownership==='direct' && childIds.some(child=>owned.has(child))){ownership='unknown';reason='contains-managed-descendant';}
    const version=hash([item.activityVersion,ownership,claims.map(c=>[c.source,c.ownerId,c.agentId,c.profile,c.sessionId]),evidence.complete]);
    const orphan=(evidence.orphanProofs??[]).find(p=>p.sessionId===id && hash(p.header)===hash(item.row?.header));
    const receipt=(evidence.receipts??[]).find(r=>r.sessionId===id && eq(r.workspace,item.row?.header?.cwd));
    return {...item,ownership,reason,activityVersion:version,hostActivityVersion:item.activityVersion,nativeBytes,...(['orphan','direct-orphan'].includes(ownership)&&orphan?{orphanEvidence:{deletedTicket:orphan.deletedTicket,rootId:orphan.rootId,kind:orphan.kind}}:{}),...(ownership==='direct'&&receipt?{ordinaryEvidence:{receiptPath:receipt.path}}:{}),
      ...(ownership==='managed'?{bytes:0,eligible:false,firstEligible:false,references:(item.nodes??[]).map(node=>({kind:'native-session',bytes:node.bytes,sessionId:node.sessionId}))}:{}),
      ...(ownership==='unknown'?{eligible:false,firstEligible:false,...(reason==='contains-managed-descendant'?{bytes:0,references:(item.nodes??[]).map(node=>({kind:'native-session',bytes:node.bytes,sessionId:node.sessionId}))}:{})}:{})};
  });
  // Every native node remains selectable. Count physical bytes once, even where
  // an ancestor and its independently eligible descendant both appear.
  const seen=new Set(),items=[];
  for(const row of marked.sort((a,b)=>(b.ownership==='managed')-(a.ownership==='managed') || (b.treeIds?.length??0)-(a.treeIds?.length??0))){
    const id=row.sessionId??row.id;
    if(row.ownership!=='managed' && row.reason!=='contains-managed-descendant') {
      if(Array.isArray(row.nodes) && row.nodes.length) row.bytes=row.nodes.reduce((sum,node)=>sum+(seen.has(node.sessionId)?0:Number(node.bytes??0)),0);
      else if(seen.has(id)) row.bytes=0;
    }
    items.push(row);for(const child of row.treeIds??[id])seen.add(child);
  }
  for(const disk of evidence.sessions??[]) if(!byId.has(disk.sessionId))items.push({id:disk.sessionId,kind:'dsh-session-unlisted',root:config.dshDataRoot,sessionId:disk.sessionId,bytes:disk.bytes,running:null,ownership:'unknown',eligible:false,firstEligible:false,treeIds:[disk.sessionId],reason:'native-list-missing-session',activityVersion:hash(disk)});
  for(const projection of evidence.projections??[]) if(!byId.has(projection.sessionId))items.push({id:'projection:'+projection.sessionId,kind:'dsh-projection-residual',root:config.dshDataRoot,sessionId:projection.sessionId,bytes:projection.bytes,running:null,ownership:'unknown',eligible:false,firstEligible:false,treeIds:[],reason:'projection-owner-unverified',activityVersion:hash(projection)});
  for(const sidecar of evidence.sidecars) if(!byId.has(sidecar.sessionId))items.push({id:'managed-host:'+path.basename(sidecar.path),kind:'managed-host-residual',root:config.dshDataRoot,sessionId:sidecar.sessionId,bytes:sidecar.bytes,running:null,ownership:'unknown',eligible:false,firstEligible:false,treeIds:[],reason:'native-presence-unverified',activityVersion:hash(sidecar)});
  items.push({id:'shared-attachments',kind:'dsh-shared-attachments',root:config.dshDataRoot,bytes:0,nativeBytes:evidence.attachments,running:null,ownership:'unknown',treeIds:[],eligible:false,firstEligible:false,reason:'shared-attachment-references-unverified',activityVersion:hash(evidence.attachments)});
  const hostCovered=native?.complete===true || (native?.reason==='native-subagent-and-orphan-coverage-unverified' && raw.every(row=>row.activityVersion && Array.isArray(row.treeIds)));
  return {items,complete:hostCovered&&evidence.complete,reason:[...(hostCovered?[]:[native?.reason??'native-enumeration-unverified']),...evidence.errors].filter(Boolean).join('; ')};
}
