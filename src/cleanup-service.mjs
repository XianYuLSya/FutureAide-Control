import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { snapshotDigest } from './cleanup-manifest.mjs';
import path from 'node:path';
import { createAuthority, directoryIdentity, digest, openAuthority } from './cleanup-authority.mjs';
import { createFileCleanup } from './cleanup-files.mjs';
import { recoverRosterOperation } from './cleanup-roster-recovery.mjs';
import { replaceStateFile } from './replace-state-file.mjs';

const names=['roster','dsh','files'];
const publicFields=['id','kind','root','name','sessionId','agentId','ownerId','target','lifetime','bytes','treeIds',
  'activityVersion','lastActivityAt','running','eligible','firstEligible','observationMs','reason','branch','head','changes','commits','ignored','references','maintenanceOnly','ownership','path','nativeBytes'];
const bindingFile=c=>path.join(c.stateDirectory,'cleanup-binding.json');
const scopeOf=(provider,item)=>provider==='roster' || item.kind==='empty-owner'?'local':'shared';
const keyOf=(provider,item)=>JSON.stringify([provider,item.kind,item.root,item.id]);
const memberKey=(provider,item,id)=>JSON.stringify([provider,'tree-member',item.root,id]);
const memberKeys=(provider,item)=>(item.treeIds??[]).map(id=>memberKey(provider,item,id));
const fingerprint=i=>digest([i.id,i.kind,i.root,i.activityVersion,[...(i.treeIds??[])].sort()]);
function activationDigest(items) {
  return digest(items.map(i=>[i.key,i.fingerprint,i.eligible===true,i.firstEligible===true,i.running,i.reason]).sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0));
}
function publicItem(provider,item) {
  if(typeof item.id!=='string' || !item.id || typeof item.root!=='string' || !item.kind) throw new Error('Invalid inventory identity from '+provider);
  return {...Object.fromEntries(publicFields.filter(k=>item[k]!==undefined).map(k=>[k,item[k]])),provider,
    hasDsh:provider==='roster' && ((item.target??'dsh')==='dsh' || item.records?.some(r=>(r.target??'dsh')==='dsh')===true),
    scope:scopeOf(provider,item),key:keyOf(provider,item),memberKeys:memberKeys(provider,item),fingerprint:fingerprint(item)};
}
async function readBinding(config) {
  return JSON.parse(await readFile(bindingFile(config),'utf8'));
}
async function saveBinding(config,binding) {
  const dest=bindingFile(config), temp=dest+'.'+randomUUID()+'.tmp';
  await writeFile(temp,JSON.stringify(binding),'utf8');
  await replaceStateFile(temp,dest);
}
export async function defaultAdapters(config) {
  const [{createDshCleanup},{createDesktopCleanup},{createRosterCleanup}]=await Promise.all([
    import('./cleanup-dsh.mjs'),import('./cleanup-desktop.mjs'),import('./cleanup-roster.mjs')]);
  const dsh=createDshCleanup(config),desktop=createDesktopCleanup(config);
  return {dsh,roster:createRosterCleanup(config,{dsh,desktop}),files:createFileCleanup(config,{dsh})};
}
async function settings(config) {
  return {file:await realpath(config.configFile),profile:config.profile??null,state:path.resolve(config.stateDirectory),
    dsh:await directoryIdentity(config.dshDataRoot),once:config.onceTerminalRetentionMs,idle:config.agentIdleRetentionMs,logs:config.diagnosticRetentionMs,
    rulesVersion:1,codexAutoCleanup:config.codexAutoCleanup!==false,graceMs:config.cleanupGraceMs??86400000};
}
function verifySnapshot(snapshot) {
  const {hash,...body}=snapshot;
  if(snapshot.version!==1 || snapshotDigest(body)!==hash) throw new Error('Snapshot content does not match its digest.');
}

export function createCleanupService(config, adapters) {
  async function preview(providers=names,{maintenance=true,diagnosticsOnly=false}={}) {
    if (!providers.length || new Set(providers).size!==providers.length || !providers.every(p=>names.includes(p))) throw new Error('Invalid cleanup inventory scopes');
    const items=[],coverage={};
    const dshInventory=providers.includes('dsh')?await adapters.dsh.inventory({maintenance}):undefined;
    for(const provider of providers) {
      const result=provider==='dsh'?dshInventory:await adapters[provider].inventory({maintenance,dshInventory,diagnosticsOnly});
      coverage[provider]={complete:result.complete===true,reason:result.reason??null,...(result.moreDiagnostics?{moreDiagnostics:true}:{})};
      for(const value of result.items) items.push(publicItem(provider,value));
    }
    const unique=new Set(items.map(i=>i.key));
    if(unique.size!==items.length) throw new Error('Duplicate stable inventory identity');
    const summary={};
    for(const i of items) {
      const label=i.kind+'/'+(i.eligible?'eligible':'retained')+'/'+(i.reason??'unknown');
      const row=summary[label]??={count:0,bytes:0,unknownSize:0,samples:[]};
      row.count++;
      if(Number.isFinite(i.bytes)) row.bytes+=i.bytes; else row.unknownSize++;
      if(row.samples.length<3) row.samples.push(i.name??i.id);
    }
    const body={version:1,createdAt:new Date().toISOString(),config:await settings(config),providers,coverage,summary,items};
    return {...body,hash:snapshotDigest(body)};
  }
  async function approve(snapshot,decisions) {
    verifySnapshot(snapshot);
    if(decisions.snapshot!==snapshot.hash || digest(snapshot.config)!==digest(await settings(config))) throw new Error('Approval targets a different snapshot or configuration.');
    if(!['B','hold'].includes(decisions.remaining)) throw new Error('Explicitly choose B (normal rules) or hold for remaining inventory.');
    if(Object.values(snapshot.coverage).some(c=>!c.complete)) throw new Error('Incomplete inventory may not be activated.');
    const first=new Set(decisions.first??[]),keep=new Set(decisions.keep??[]);
    const all=new Map(snapshot.items.map(i=>[i.key,i]));
    const descendants=new Map();
    for(const i of snapshot.items)for(const k of memberKeys(i.provider,i))descendants.set(k,i);
    for(const k of keep)if(descendants.has(k))all.set(k,descendants.get(k));
    for(const k of [...first,...keep]) if(!all.has(k) || (first.has(k)&&keep.has(k))) throw new Error('Invalid or overlapping approval selections');
    const keepKinds=new Set(decisions.keepKinds??[]);
    for(const kind of keepKinds)if(!snapshot.items.some(i=>i.kind===kind))throw new Error('Unknown retention category: '+kind);
    for(const i of snapshot.items) if(keepKinds.has(i.kind)) keep.add(i.key);
    if([...first].some(k=>keep.has(k))) throw new Error('First batch overlaps retained category');
    for(const k of first) {
      const i=all.get(k);
      if(i.reason==='active-project' || i.kind==='worktree' && i.changes?.length)throw new Error('Active or modified development trees cannot be approved for removal.');
    }
    const entries=snapshot.items.map(i=>({key:i.key,scope:i.scope,fingerprint:i.fingerprint,
      decision:keep.has(i.key)?'C':first.has(i.key)?'A':decisions.remaining,
      ...(keep.has(i.key)?{protects:memberKeys(i.provider,i)}:{}),
      ...(i.kind==='worktree'&&i.changes?.length&&!keep.has(i.key)?{decision:'hold'}:{})}));
    for(const [key,item] of descendants) {
      const selected=keep.has(key);
      entries.push({key,scope:item.scope,fingerprint:item.fingerprint,decision:selected?'C':'B'});
    }
    const approval=digest([snapshot.hash,decisions]);
    await mkdir(config.stateDirectory,{recursive:true,mode:0o700});
    let binding;
    try { binding=await readBinding(config); } catch(e) { if(e.code!=='ENOENT') throw e; }
    if(binding && digest(binding.providers)!==digest(snapshot.providers)) throw new Error('Existing inventory scope differs.');
    binding={...binding,approval,snapshot:snapshot.hash,activationDigest:activationDigest(snapshot.items),settings:snapshot.config,providers:snapshot.providers,ids:{...binding?.ids}};
    const scopes=new Set(entries.map(e=>e.scope));
    if(snapshot.providers.includes('roster')) scopes.add('local');
    if(snapshot.providers.some(p=>p==='dsh'||p==='files')) scopes.add('shared');
    for(const scope of scopes) {
      let id;
      try { id=await createAuthority(config,scope==='shared',approval,entries.filter(e=>e.scope===scope)); }
      catch(e) {
        if(e.code!=='EEXIST') throw e;
        const ledger=await openAuthority(config,scope==='shared',{binding:binding.ids[scope],write:true});
        try {
          if(ledger.info.manifest!==approval) {
            if(binding.ids[scope]!==ledger.info.id) throw new Error('A different approval already owns this root.');
            ledger.replaceBeforeActivation(approval,entries.filter(e=>e.scope===scope));
          }
          id=ledger.info.id;
        } finally { ledger.close(); }
      }
      binding.ids[scope]=id;
    }
    await saveBinding(config,binding);
    return {approved:true,approval,decisions:entries.reduce((n,e)=>(n[e.decision]=(n[e.decision]??0)+1,n),{})};
  }
  async function authorities(fn,write=false,{tolerateUnavailable=false}={}) {
    const binding=await readBinding(config), result={};
    for(const [scope,id] of Object.entries(binding.ids)) {
      let ledger;
      try{
        ledger=await openAuthority(config,scope==='shared',{binding:id,write});
        if(ledger.info.manifest!==binding.approval)throw new Error('Authorization manifest binding changed.');
        result[scope]=await fn(ledger,scope);
      }catch(e){
        if(!tolerateUnavailable)throw e;
        result[scope]={enabled:false,reason:e.message};
      }finally{ledger?.close();}
    }
    return result;
  }
  async function switchEnabled(value) {
    if(value && (config.agentAutoCleanup!==true || config.cleanupConfigurationError)) throw new Error('Set agentAutoCleanup=true in the approved configuration before enabling.');
    if(value) {
      const binding=await readBinding(config);
      if(digest(binding.settings)!==digest(await settings(config)))throw new Error('Rules differ from the approved activation.');
      const pending=await authorities(l=>l.info.activated ? null : l.inventoryKeys());
      if(Object.values(pending).some(Boolean)) {
        const current=await preview(binding.providers);
        if(Object.values(current.coverage).some(c=>!c.complete)) throw new Error('Activation inventory is incomplete.');
        if(activationDigest(current.items)!==binding.activationDigest)throw new Error('Activation inventory changed. Review the current identities, activity and first-round impact.');
        for(const [scope,keys] of Object.entries(pending)) {
          const present=new Set(current.items.filter(i=>i.scope===scope).flatMap(i=>[i.key,...memberKeys(i.provider,i)]));
          if(keys && digest(keys.sort())!==digest([...present].sort())) {
            throw new Error('Activation inventory changed. Preview again and approve the updated snapshot.');
          }
        }
      }
    }
    try {return await authorities(l=>{l.toggle(value);return {enabled:value};},true,{tolerateUnavailable:!value});}
    catch(error) {
      await authorities(l=>l.toggle(false),true,{tolerateUnavailable:true});
      throw error;
    }
  }
  async function execute(mode,{snapshot,review,readWorktreeReview,worktreeReview,diagnosticsOnly=false,limit=Infinity,authorized=async()=>true}={}) {
    if(config.agentAutoCleanup!==true || config.cleanupConfigurationError) return {enabled:false,items:[]};
    const binding=await readBinding(config);
    if(mode==='first'){
      verifySnapshot(snapshot);
      if(binding.snapshot!==snapshot.hash || binding.approval!==review) throw new Error('First-batch approval digest mismatch');
    }else if(mode!=='rules')throw new Error('Invalid cleanup mode');
    if(diagnosticsOnly && !binding.providers.includes('files'))return {items:[]};
    const batch=mode==='first'?snapshot:await preview(diagnosticsOnly?['files']:binding.providers,{maintenance:false,diagnosticsOnly});
    const indices=new Map();
    for(const i of batch.items) {
      const id=i.sessionId??i.agentId??i.id;
      const refs=indices.get(id)??[]; refs.push(i.key,memberKey(i.provider,i,id));indices.set(id,refs);
      for(const child of i.treeIds??[]) {
        const childRefs=indices.get(child)??[];
        childRefs.push(memberKey(i.provider,i,child));
        indices.set(child,childRefs);
      }
    }
    const results=[],ledgers={};
    try {
      for(const [scope,id] of Object.entries(binding.ids)) {
        let ledger;
        try {
          ledger=await openAuthority(config,scope==='shared',{binding:id,write:true});
          if(ledger.info.manifest!==binding.approval)throw new Error('Authorization manifest binding changed.');
          ledgers[scope]=ledger;
        } catch(e) {ledger?.close();results.push({scope,removed:false,reason:e.message});}
      }
      const recovered=new Set();
      for(const ledger of Object.values(ledgers)) {
        if(!ledger.info.enabled || diagnosticsOnly)continue;
        for(const prior of ledger.pending()) {
          const plan=JSON.parse(prior.plan), detail=JSON.parse(prior.detail??'null');
          // A monitor may finish an already claimed first-batch ticket within its frozen scope.
          // It never starts a first-batch item that has not reached its native backend.
          if((prior.mode!==mode && !(mode==='rules' && prior.mode==='first' && (detail?.staged || detail?.ticketId || prior.state==='running'))) || results.length>=limit)continue;
          const staged=plan.provider==='dsh' && (detail?.staged || prior.state==='running');
          const roster=plan.provider==='roster' && (detail?.ticketId || prior.state==='running');
          if(!staged && !roster)continue;
          if(staged && detail?.eligibleAt && Date.now()<new Date(detail.eligibleAt).getTime())continue;
          const members=plan.members;
          const token=ledger.claim(prior.key,prior.mode,plan.fingerprint,members,plan);
          if(!token)continue;
          const canDelete=()=>ledger.valid(prior.key,token,prior.mode,plan.fingerprint,members)
            && (!plan.hasDsh || (!!ledgers.shared && binding.providers.includes('dsh') && ledgers.shared.permitsNativeTree(members,prior.mode)))
            && Object.values(ledgers).every(book=>!members.some(k=>book.lookup(k)?.decision==='C'));
          const revalidate=async()=>await authorized(plan) && canDelete();
          let outcome;
          try {
            if(!await revalidate())outcome={...detail,removed:false,reason:'authorization-changed'};
            else if(roster)outcome=await recoverRosterOperation(adapters.roster,prior,{mode,revalidate,canDelete,operationToken:plan.ticketToken});
            else outcome=await adapters.dsh.finalize(detail?.ticket??plan.ticketToken);
          } catch(e) {outcome={...detail,removed:false,reason:e.message};}
          if(!outcome || outcome.reason==='roster-ticket-not-found') {
            ledger.finish(prior.key,token,'held',{reason:'no-committed-backend-ticket'});
            continue;
          }
          if(staged && !outcome.removed)outcome={...detail,...outcome,staged:true};
          ledger.finish(prior.key,token,outcome.removed?'removed':outcome.staged?'staged':outcome.retryFromInventory?'retry':'held',outcome);
          recovered.add(prior.key);results.push({key:prior.key,...outcome});
        }
      }
      for(const i of batch.items) {
        if(recovered.has(i.key))continue;
        if(results.length>=limit) break;
        const ledger=ledgers[i.scope],adapter=adapters[i.provider];
        const entry=ledger?.lookup(i.key);
        const skip=reason=>{if(mode==='first' && entry?.decision==='A')results.push({key:i.key,removed:false,reason,bytes:0});};
        if(!ledger?.info.enabled || (mode==='rules'&&!batch.coverage[i.provider].complete)){skip('authority-disabled-or-incomplete');continue;}
        if(mode==='first'?entry?.decision!=='A':entry && entry.decision!=='B')continue;
        if(mode==='rules'&&i.maintenanceOnly)continue;
        if(mode==='rules' && config.codexAutoCleanup===false && i.target==='codex-desktop')continue;
        if(mode==='rules' && i.running!==false)continue;
        if(mode==='rules' && !i.eligible && !i.observationMs)continue;
        // A backend inventory may describe the same native child as a roster tree.
        // The managed route must archive and fence it before any native removal.
        if(i.provider==='dsh' && i.ownership==='managed'){skip('managed-name-must-be-approved-through-roster');continue;}
        const members=[i.key,...memberKeys(i.provider,i),...(i.treeIds??[]).flatMap(id=>indices.get(id)??[])];
        const requiresShared=i.hasDsh===true;
        if(requiresShared && (!ledgers.shared || !binding.providers.includes('dsh') || batch.coverage.dsh?.complete!==true)){skip('native-root-authorization-unavailable');continue;}
        const allowedMembers=()=>Object.values(ledgers).every(book=>!members.some(k=>book.lookup(k)?.decision==='C'))
          && (!requiresShared || ledgers.shared.permitsNativeTree(members,mode));
        if(!allowedMembers()){skip('protected-tree-member');continue;}
        const op=ledger.operation(i.key);
        if(op && ['removed','staged','restoring','restored'].includes(op.state)){skip('already-'+op.state);continue;}
        let current;
        try {current=await adapter.inspect(i);}catch(e){skip('inspection-failed: '+e.message);continue;}
        if(current.running!==false || !current.activityVersion || fingerprint(current)!==i.fingerprint) {
          if(mode==='first')results.push({key:i.key,removed:false,reason:'changed-or-uncertain'});
          continue;
        }
        const observedSince=ledger.observe(i.key,current.activityVersion,Date.now());
        const aged=current.observationMs>0 && Date.now()-observedSince>=current.observationMs;
        if(mode==='first' ? !(current.firstEligible===true || current.eligible===true) : !(current.eligible===true || aged)){skip(current.reason??'first-batch-precondition-failed');continue;}
        const token=ledger.claim(i.key,mode,i.fingerprint,members,{provider:i.provider,target:i.target,kind:i.kind,hasDsh:requiresShared});
        const operationToken=token && JSON.parse(ledger.operation(i.key).plan).ticketToken;
        if(!token){skip('ticket-unavailable-or-in-progress');continue;}
        let externalGateOpen=false;
        const canDelete=()=>externalGateOpen && allowedMembers() && ledger.valid(i.key,token,mode,i.fingerprint,members);
        const revalidate=async()=>{
          externalGateOpen=await authorized(current);
          return canDelete();
        };
        try {
          if (!await revalidate()) {ledger.finish(i.key,token,'held',{reason:'authorization-changed'});skip('authorization-changed');continue;}
          const outcome=await adapter.remove(current,{mode,observedSince,revalidate,canDelete,operationToken,worktreeReview,readWorktreeReview});
          ledger.finish(i.key,token,outcome.removed?'removed':outcome.staged?'staged':outcome.retryFromInventory?'retry':'held',outcome);
          results.push({key:i.key,...outcome});
        } catch(e) {
          ledger.finish(i.key,token,'needs-verification',{reason:e.message});
          results.push({key:i.key,removed:false,reason:e.message});
        }
      }
    } finally {for(const ledger of Object.values(ledgers))ledger.close();}
    return {items:results,moreDiagnostics:batch.coverage.files?.moreDiagnostics===true};
  }
  return {preview,approve,switchEnabled,execute,
    async status() {
      let status={};
      try {status=await authorities(l=>({authority:l.info,worker:l.acknowledgement(),operations:l.operations()}),false,{tolerateUnavailable:true});}
      catch(e){if(e.code!=='ENOENT')throw e;}
      if(!status.shared) {
        try {
          const ledger=await openAuthority(config,true);
          try {status.shared={enabled:false,reason:'shared-authority-not-bound-to-this-roster'};}finally{ledger.close();}
        }catch(e){status.shared={enabled:false,reason:e.code==='ENOENT'?'shared-authority-missing':e.message};}
      }
      return status;
    },
    monitorState:()=>authorities(l=>{
      const ack=l.acknowledgement();
      if(ack?.generation!==l.info.generation || ack.pid!==process.pid)l.acknowledge();
      return !!l.info.enabled;
    },true,{tolerateUnavailable:true}),
    async restore(ticket) {
      const binding=await readBinding(config);
      for(const [scope,id] of Object.entries(binding.ids)) {
        const ledger=await openAuthority(config,scope==='shared',{binding:id,write:true});
        try {
          const op=ledger.pending().find(row=>{
            const detail=JSON.parse(row.detail??'null');
            return ['staged','restoring'].includes(row.state) && [detail?.ticket,detail?.ticketId].includes(ticket);
          });
          if(!op)continue;
          if(!ledger.beginRestore(op.key,op.token))return {restored:false,reason:'ticket-in-use'};
          let result;
          try {
            result=scope==='shared'?await adapters.dsh.restore(ticket):await adapters.roster.restore(ticket);
            if(result.restored) {
              const plan=JSON.parse(op.plan);
              ledger.retain(op.key,plan.fingerprint,plan.members);
            }
          }finally{ledger.finish(op.key,op.token,result?.restored?'restored':'staged',result?.restored?result:JSON.parse(op.detail));}
          return result;
        }finally{ledger.close();}
      }
      throw new Error('No staged ticket is bound to this authorization.');
    },
    revoke:keys=>authorities(ledger=>{
      let count=0;
      for(const key of keys) {
        count+=ledger.revoke(key);
      }
      return count;
    },true),
    archives:query=>adapters.roster.archives(query)};
}
