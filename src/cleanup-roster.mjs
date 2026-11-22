import { DatabaseSync } from 'node:sqlite';
import { forgetUnsentStep,markRosterRestored } from './cleanup-roster-transaction.mjs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { sameCodexDomain } from './codex-domain.mjs';
import { lstat, realpath, readdir, rm } from 'node:fs/promises';
import { rosterTreeFromSnapshot, claimRosterTree, readRosterTicket, listRosterTickets, verifyRosterTicket, releaseRosterTicket, readRosterArchives, voidRosterRecipient, recordRosterStep, rosterSteps, completeRosterTicket, takeRosterReleasedBytes } from './cleanup-roster-transaction.mjs';

// Preview must not run roster migrations, change WAL settings, or create a database.
function snapshot(filename) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    db.exec('BEGIN');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    if (!tables.has('agents') || !tables.has('owners')) throw new Error('roster schema lacks agents or owners');
    const read = table => tables.has(table) ? db.prepare(`SELECT * FROM ${table}`).all() : [];
    const result = Object.fromEntries(['agents', 'owners', 'backend_state', 'submissions', 'supplements', 'agent_history'].map(table => [table, read(table)]));
    result.tables = [...tables];
    db.exec('COMMIT');
    return result;
  } finally { db.close(); }
}
const parse = value => value == null ? undefined : JSON.parse(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// Polling metadata does not represent a new accepted business action. Keep all
// other fields, including task/answer/report identities and delivery outcomes.
function businessValue(value) {
  if (Array.isArray(value)) return value.map(businessValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['updatedAt', 'nextAttemptAt', 'retryCount'].includes(key))
    .map(([key, entry]) => {
      if (typeof entry === 'string' && ['body', 'delivery', 'selection'].includes(key)) {
        try { return [key, businessValue(JSON.parse(entry))]; } catch { /* retain original */ }
      }
      return [key, businessValue(entry)];
    }));
}

function managedNativeBytes(tree, inventory) {
  const members=tree.filter(record => (record.target ?? 'dsh') === 'dsh');
  if (!members.length) return null;
  const totals=new Map();
  for (const record of members) {
    const matches=(inventory?.items ?? []).filter(item => (item.sessionId ?? item.id) === record.sessionId);
    if (matches.length !== 1) return null;
    const item=matches[0], nodes=Array.isArray(item.nodes) ? item.nodes : item.references;
    if (!Array.isArray(nodes) || !nodes.length) return null;
    for (const node of nodes) {
      const id=node.sessionId ?? node.id, bytes=node.bytes ?? node.nativeBytes;
      if (typeof id !== 'string' || !Number.isFinite(bytes) || bytes < 0 || (totals.has(id) && totals.get(id) !== bytes)) return null;
      totals.set(id,bytes);
    }
  }
  return [...totals.values()].reduce((sum,value)=>sum+value,0);
}

// Overlapping native trees can be deleted once only when one verified tree fully
// covers the others. Partial overlap or two competing roots is ambiguous.
function managedGroups(tree, natives) {
  const entries=tree.filter(record => (record.target ?? 'dsh') === 'dsh').map(record => {
    const native=natives.find(value => value.agentId === record.agentId);
    if (!native?.managed || !Array.isArray(native.treeIds) || !native.treeIds.includes(record.sessionId) || new Set(native.treeIds).size !== native.treeIds.length) return null;
    return {record,ids:new Set(native.treeIds)};
  });
  if (entries.some(entry => !entry)) return null;
  const contains=(a,b)=>[...b].every(id=>a.has(id));
  for (let i=0;i<entries.length;i++) for (let j=i+1;j<entries.length;j++) {
    const a=entries[i].ids,b=entries[j].ids;
    if ([...a].some(id=>b.has(id)) && !contains(a,b) && !contains(b,a)) return null;
    if (contains(a,b) && contains(b,a)) return null;
  }
  const result=new Map();
  for (const entry of entries) {
    const candidates=entries.filter(candidate => contains(candidate.ids,entry.ids)).sort((a,b)=>b.ids.size-a.ids.size);
    result.set(entry.record.agentId,candidates[0].record.agentId);
  }
  return result;
}

function nativeToken(ticketId, agentId) {
  const value=hash(['managed-native-v1',ticketId,agentId]);
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20,32)}`;
}

const time = value => { const n = typeof value === 'number' ? (value > 0 && value < 1e12 ? value * 1000 : value) : Date.parse(value ?? ''); return Number.isFinite(n) && n > 0 ? n : null; };
function assess(tree, data, ownerDeleted, now, config, natives, states) {
  const ids = new Set(tree.map(row => row.agentId));
  let uncertainClock = false;
  const events = [];
  for (const native of natives) {
    const member=tree.find(record => record.agentId === native.agentId);
    const observed=time(native.lastActivityAt);
    const hasHistory=native.historyPresent === true || (Array.isArray(native.history) && native.history.length > 0)
      || Object.keys(states.get(native.agentId)?.requests ?? {}).length > 0
      || (member?.target === 'codex-desktop' && native.historyPresent !== false);
    if (observed !== null) events.push(observed); else if (hasHistory) uncertainClock=true;
    if (!ownerDeleted && (native.questions ?? []).some(question => question.state === 'pending')) return {safe:false,reason:'native-question-pending'};
    if ((native.reports ?? []).some(report => {
      const mirrored=(member?.task?.reports ?? []).find(item => item.id === report.id);
      const state=report.delivery?.state ?? mirrored?.delivery?.state;
      return ['sending','unknown'].includes(state) || (!ownerDeleted && !['delivered','blocked'].includes(state));
    })) return {safe:false,reason:'native-report-pending'};
  }
  const collectDates = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (['createdAt','startedAt','finishedAt','endedAt','acceptedAt','deliveredAt','blockedAt','answeredAt'].includes(key)) {
        const n=time(child); if (n!==null) events.push(n);
      } else if (child && typeof child === 'object') collectDates(child);
    }
  };
  const submissions = data.submissions.filter(row => ids.has(row.agent));
  const supplements = data.supplements.filter(row => ids.has(row.agent));
  if (supplements.some(row => ['sending','unknown'].includes(row.status))) return { safe:false, reason:'input-outcome-unknown' };
  if (!ownerDeleted && supplements.some(row => row.status === 'queued')) return { safe:false, reason:'pending-supplement' };
  if (supplements.length) uncertainClock = true; // the legacy queue has no completion time
  for (const row of submissions) {
    const delivery = parse(row.delivery) ?? {};
    if (['sending','unknown'].includes(delivery.state)) return {safe:false,reason:'delivery-outcome-unknown'};
    if (!ownerDeleted && ((row.state === 'pending' && delivery.state !== 'blocked') || !['delivered','blocked'].includes(delivery.state))) return {safe:false,reason:'pending-submission'};
    if (['delivered','blocked'].includes(delivery.state) && time(delivery.deliveredAt ?? delivery.blockedAt) === null) uncertainClock = true;
    const resolved=time(delivery.deliveredAt ?? delivery.blockedAt); if (resolved !== null) events.push(resolved);
  }
  for (const record of tree) {
    const task = record.task;
    const archivedSupplement=record.state==='supplement_blocked' && record.lifetime==='once' && task?.state==='completed';
    if (!['idle','failed','cancelled','completed'].includes(record.state) && !archivedSupplement && !(ownerDeleted && task?.finishedAt)) return {safe:false,reason:'roster-state-not-settled'};
    if (record.closed || record.cleanupRosterTicket) return {safe:false,reason:'roster-already-closed'};
    if ((task?.cancelRequested || record.state === 'cancelled' || task?.state === 'cancelled') && !(task?.cancelVerified && task?.cancelTreeSettled)) return {safe:false,reason:'cancellation-not-verified'};
    if ((task?.dispatches ?? []).some(d => ['sending','unknown','retrying'].includes(d.state) || (d.attempted && !d.accepted && !d.rejected))) return {safe:false,reason:'dispatch-outcome-unknown'};
    if ((task?.answers ?? []).some(a => !a.dispatched)) return {safe:false,reason:'answer-in-flight'};
    if (!ownerDeleted && (record.observation?.questions ?? []).some(q => q.state === 'pending')) return {safe:false,reason:'question-pending'};
    if (!ownerDeleted && Object.values(task?.questionNotices ?? {}).some(notice => !['delivered','blocked'].includes(notice?.state))) return {safe:false,reason:'question-notice-pending'};
    for (const notice of Object.values(task?.questionNotices ?? {})) {
      const resolved=time(notice?.deliveredAt ?? notice?.blockedAt);
      if (resolved === null) uncertainClock = true; else events.push(resolved);
    }
    for (const report of task?.reports ?? []) {
      const state = report.delivery?.state;
      if (['sending','unknown'].includes(state)) return {safe:false,reason:'report-outcome-unknown'};
      if (!ownerDeleted && !['delivered','blocked'].includes(state)) return {safe:false,reason:'report-pending'};
      if (['delivered','blocked'].includes(state) && time(report.delivery?.deliveredAt ?? report.delivery?.blockedAt) === null) uncertainClock = true;
      for (const value of [report.createdAt,report.delivery?.deliveredAt,report.delivery?.blockedAt,report.delivery?.finishedAt]) { const n=time(value); if (n!==null) events.push(n); }
    }
    if (task && time(task.finishedAt) === null) uncertainClock = true;
    for (const value of [task?.startedAt,task?.finishedAt,record.lastActivityAt]) { const n=time(value); if (n!==null) events.push(n); }
    collectDates(task);
    collectDates(record.observation);
  }
  for (const row of [...submissions,...supplements]) { const n=time(row.created); if (n!==null) events.push(n); }
  const pastTasks=[];
  const historyRows=[...data.agent_history.filter(entry => ids.has(entry.agent)),
    ...tree.flatMap(record => (Array.isArray(record.history) ? record.history : []).map(task => ({agent:record.agentId,body:JSON.stringify(task)})))];
  for (const row of historyRows) {
    let past;
    try { past=JSON.parse(row.body); } catch { return {safe:false,reason:'history-unreadable'}; }
    pastTasks.push({agent:row.agent,task:past});
    for (const report of past.reports ?? []) {
      const state=report.delivery?.state;
      if (['sending','unknown'].includes(state)) return {safe:false,reason:'historical-report-outcome-unknown'};
      if (!ownerDeleted && !['delivered','blocked'].includes(state)) return {safe:false,reason:'historical-report-pending'};
      if (['delivered','blocked'].includes(state) && time(report.delivery?.deliveredAt ?? report.delivery?.blockedAt) === null) uncertainClock = true;
    }
    if ((past.answers ?? []).some(answer => !answer.dispatched)) return {safe:false,reason:'historical-answer-in-flight'};
    if (!ownerDeleted && Object.values(past.questionNotices ?? {}).some(notice => !['delivered','blocked'].includes(notice?.state))) return {safe:false,reason:'historical-question-pending'};
    collectDates(past);
  }
  if (!ownerDeleted) for (const ask of submissions.filter(row => row.kind === 'ask')) {
    const record=tree.find(entry => entry.agentId === ask.agent);
    const rounds=[record?.task,...pastTasks.filter(entry => entry.agent === ask.agent).map(entry => entry.task)].filter(Boolean);
    const matching=rounds.find(round => round.taskId === ask.task);
    if (!matching || !(matching.answers ?? []).some(answer => (answer.questionIds ?? []).includes(`submission:${ask.id}`) && answer.dispatched))
      return {safe:false,reason:'question-unanswered'};
  }
  const root = tree[0], task = root.task;
  if (root.lifetime === 'once') {
    if (!task) return {safe:false,reason:'once-without-task'};
    const failed = ['failed','cancelled'].includes(root.state) || ['failed','cancelled'].includes(task.state);
    const blocked = (task.reports ?? []).some(r => r.final && r.delivery?.state === 'blocked')
      || submissions.some(row => row.agent === root.agentId && row.task === task.taskId && row.final === 1 && (parse(row.delivery) ?? {}).state === 'blocked');
    const finalStates=[
      ...(task.reports??[]).filter(r=>r.final===true).map(r=>r.delivery?.state),
      ...submissions.filter(r=>r.agent===root.agentId && r.task===task.taskId && r.final===1).map(r=>parse(r.delivery)?.state),
    ];
    const finalDelivered=finalStates.length>0 && finalStates.every(s=>s==='delivered');
    if(task.state==='completed' && finalDelivered && (task.autoCleanupHeld===true || root.state==='supplement_blocked'
      || (task.reports??[]).some(r=>r.delivery?.state==='blocked')))return {safe:true,reason:'delivered-once-with-sealed-body',since:null,immediate:true};
    if (!failed && !blocked) return {safe:false,reason:'once-terminal-not-proven'};
    const finished=time(task.finishedAt);
    const blockedTimes=(task.reports ?? []).filter(r => r.final && r.delivery?.state === 'blocked').map(r => time(r.delivery.blockedAt ?? r.delivery.finishedAt));
    if (finished === null || uncertainClock || blockedTimes.some(value => value === null)) return {safe:true,reason:'terminal-time-unproven',since:null,observationMs:config.onceTerminalRetentionMs ?? 86400000};
    const since=Math.max(finished,...blockedTimes,...events);
    return {safe:true,reason:'once-terminal',since,observationMs:config.onceTerminalRetentionMs ?? 86400000};
  }
  if (root.lifetime !== 'persistent') return {safe:false,reason:'lifetime-unknown'};
  if (ownerDeleted) return {safe:true,reason:'recipient-deleted',since:null,immediate:true};
  return {safe:true,reason:'persistent-idle',since:!uncertainClock && events.length ? Math.max(...events) : null,observationMs:config.agentIdleRetentionMs ?? 43200000};
}

async function privateIdentity(config, record) {
  const valid = value => typeof value === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,119}$/.test(value) && value !== '.' && value !== '..';
  if (!valid(record.ownerId) || !valid(record.agentId)) throw new Error('private-identity-invalid');
  const scoped = path.resolve(config.stateDirectory,'scoped'), owner=path.join(scoped,record.ownerId), target=path.join(owner,record.agentId);
  try {
    for (const p of [scoped,owner,target]) {
      const stat=await lstat(p);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('private-path-not-plain-directory');
    }
    const actualRoot=await realpath(scoped), actual=await realpath(target), relative=path.relative(actualRoot,actual);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('private-path-outside-root');
    const stat=await lstat(target);
    return {exists:true,dev:stat.dev,ino:stat.ino,ctimeMs:stat.ctimeMs};
  } catch (error) { if(error.code!=='ENOENT') throw error; return {exists:false}; }
}
async function privateSnapshot(config,record) {
  const identity=await privateIdentity(config,record);
  if (!identity.exists) return {identity,known:true,bytes:0,fingerprint:hash([])};
  const target=path.resolve(config.stateDirectory,'scoped',record.ownerId,record.agentId), entries=[];
  let bytes=0,known=true,latestMutationMs=0;
  async function visit(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file=path.join(dir,name), st=await lstat(file);
      latestMutationMs=Math.max(latestMutationMs,st.mtimeMs,st.ctimeMs);
      entries.push([path.relative(target,file),st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs,st.nlink,st.mode]);
      if (st.isSymbolicLink()) known=false;
      else if (st.isDirectory()) await visit(file);
      else if (st.isFile()) {if (st.nlink!==1) known=false; bytes+=st.size;}
      else known=false;
      if (!Number.isSafeInteger(bytes)) known=false;
    }
  }
  await visit(target);
  const after=await privateIdentity(config,record);
  if (!after.exists || after.dev!==identity.dev || after.ino!==identity.ino || after.ctimeMs!==identity.ctimeMs) throw new Error('private-identity-changed');
  return {identity,known,bytes:known?bytes:null,fingerprint:hash(entries),latestMutationMs};
}
async function removePrivate(config, record, expected, planned) {
  const current=await privateIdentity(config,record);
  if (!current.exists) return {releasedBytes:expected?.exists ? null : 0,...(expected?.exists ? {bytesReason:'private-removal-outcome-unconfirmed'} : {})};
  if (!expected?.exists || current.dev !== expected.dev || current.ino !== expected.ino || current.ctimeMs !== expected.ctimeMs) throw new Error('private-identity-changed');
  const measured=await privateSnapshot(config,record);
  if (!planned || measured.fingerprint!==planned.fingerprint || measured.bytes!==planned.bytes || measured.known!==planned.known) throw new Error('private-content-changed');
  const target=path.resolve(config.stateDirectory,'scoped',record.ownerId,record.agentId);
  await rm(target,{recursive:true});
  try { await lstat(target); throw new Error('private-path-still-present'); } catch (error) { if(error.code!=='ENOENT') throw error; }
  return {releasedBytes:measured.known ? measured.bytes : null,...(!measured.known ? {bytesReason:'private-size-unavailable'} : {})};
}

/** Read-only roster discovery. Destructive operations are disabled until a durable tree claim exists. */
export function createRosterCleanup(config, { dsh, desktop } = {}) {
  const filename = config.rosterFile ?? path.join(config.stateDirectory, 'roster.sqlite');
  const root = path.resolve(config.stateDirectory);
  const now = () => typeof config.cleanupNow === 'function' ? config.cleanupNow() : Date.now();
  async function inventory({agentId,dshInventory:sharedInventory}={}) {
    let data;
    try { data = snapshot(filename); }
    catch (error) { return { items: [], complete: false, reason: `roster-read-failed: ${error.message}` }; }
    try {
      const records = data.agents.map(row => ({ ...parse(row.body), agentId: row.id, ownerId: row.owner, name: row.name }));
      let dshInventory=sharedInventory;
      if(!agentId && !dshInventory && records.some(r=>(r.target??'dsh')==='dsh') && dsh?.inventory) {
        try {dshInventory=await dsh.inventory();}catch { /* Physical bytes are unknown for this preview. */ }
      }
      const owners = new Map(data.owners.map(row => [row.id, parse(row.body)]));
      const states = new Map(data.backend_state.map(row => [row.agent, parse(row.body)]));
      const ids = new Set(records.map(record => record.agentId));
      const roots = records.filter(record => !record.parentAgentId || !ids.has(record.parentAgentId));
      const items = [];
      for (const record of roots) {
        if(agentId && record.agentId!==agentId)continue;
        const tree = [record];
        for (let i = 0; i < tree.length; i++) {
          for (const child of records.filter(candidate => candidate.parentAgentId === tree[i].agentId)) {
            if (!tree.includes(child)) tree.push(child);
          }
        }
        const treeIds = tree.map(entry => entry.agentId).sort();
        const related = table => data[table].filter(row => treeIds.includes(row.agent));
        const rosterVersion = hash(businessValue({ tree, backend: treeIds.map(id => states.get(id)), submissions: related('submissions'), supplements: related('supplements'), history: related('agent_history') }));
        const target = record.target ?? 'dsh';
        const natives = [];
        for (const member of tree) {
          let native;
          try {
            if ((member.target ?? 'dsh') === 'dsh') {
              const found = dsh?.inspectManaged ? await dsh.inspectManaged(member,states.get(member.agentId)) : undefined;
              native = found?.ownership === 'managed' && found.complete === true && found.historyComplete === true && Array.isArray(found.history)
                ? {...found, managed:true} : {running:null, reason:found?.reason ?? 'managed-dsh-native-identity-unverified'};
            } else if (desktop?.inspect) native = await desktop.inspect(member, states.get(member.agentId));
            else native = { running:null, reason:'backend-inspection-unavailable' };
          } catch (error) { native = { running:null, reason:`backend-inspection-failed: ${error.message}` }; }
          natives.push({ agentId:member.agentId, ...native });
        }
        const running = natives.some(n => n.running === true) ? true : natives.every(n => n.running === false && n.activityVersion && Array.isArray(n.treeIds)) ? false : null;
        const owner = owners.get(record.ownerId);
        let ownerStatus = { state: 'unknown', reason: 'owner-status-unavailable' };
        if (desktop?.ownerStatus && owner) {
          try { ownerStatus = await desktop.ownerStatus(owner); } catch { /* unknown is conservative */ }
        }
        const ownerDeleted = ownerStatus?.state === 'deleted' && owner?.source === 'codex-desktop'
          && typeof owner.threadId === 'string' && ownerStatus.threadId === owner.threadId
          && sameCodexDomain(owner.codexDomain,ownerStatus.domain)
          && ownerStatus.source === 'confirmed-native-delete-and-current-lists' && typeof ownerStatus.receiptId === 'string' && !!ownerStatus.receiptId
          && tree.every(member => member.ownerId === record.ownerId);
        const observedAt=now();
        const rule = assess(tree,data,ownerDeleted,observedAt,config,natives,states);
        const schemaReady=['agents','owners','backend_state','submissions','supplements','agent_history','leases'].every(table => data.tables.includes(table));
        const managedDsh=tree.filter(member => (member.target ?? 'dsh') === 'dsh');
        const groups=managedGroups(tree,natives);
        const includesManagedSidecars=groups && [...groups].some(([id,leader])=>id!==leader);
        const nativeRemovalReady=!managedDsh.length || (typeof dsh?.removeManaged === 'function' && groups !== null
          && (!includesManagedSidecars || dsh?.supportsManagedSidecarCoverage === true));
        const firstEligible = running === false && rule.safe === true && schemaReady && nativeRemovalReady;
        const eligible = firstEligible && (rule.immediate || (rule.since !== null && observedAt >= rule.since + rule.observationMs));
        items.push({ id: record.agentId, kind: 'managed-agent', root, agentId: record.agentId,
          name: record.name, ownerId: record.ownerId, target, lifetime: record.lifetime,
          bytes: managedNativeBytes(tree,dshInventory), activityVersion: hash({ rosterVersion, natives: natives.map(n => [n.agentId,n.activityVersion,n.treeIds,n.history ? hash(n.history) : null]) }),
          treeIds:[...new Set([...treeIds,...natives.flatMap(n => Array.isArray(n.treeIds) ? n.treeIds : [])])].sort(), running,
          lastActivityAt: rule.since === null || rule.since === undefined ? null : new Date(rule.since).toISOString(), eligible, firstEligible,
          ...(firstEligible && !rule.immediate && rule.since === null ? { observationMs:rule.observationMs } : {}),
          reason: !schemaReady ? 'roster-schema-incomplete' : !nativeRemovalReady ? 'managed-dsh-remove-unavailable' : running === false ? rule.reason : (natives.find(n => n.running !== false)?.reason ?? 'activity-unverified'),
          rosterFingerprint: rosterTreeFromSnapshot(data, record.agentId).fingerprint,
          natives, nativeGroups:groups ? Object.fromEntries(groups) : null, ownerStatus, ownerDeleted, record, records:tree, backendStates:Object.fromEntries(tree.map(member => [member.agentId,states.get(member.agentId)])) });
      }
      // A parent cycle cannot be represented as a rooted tree; report an incomplete scan.
      const represented = new Set(items.flatMap(item => item.records.map(record => record.agentId)));
      const complete = agentId ? roots.some(r=>r.agentId===agentId) : represented.size === records.length;
      return { items, complete, ...(complete ? {} : { reason: 'roster-tree-cycle-or-unreachable-record' }) };
    } catch (error) { return { items: [], complete: false, reason: `roster-schema-or-data-invalid: ${error.message}` }; }
  }
  async function inspect(item) {
    const current = await inventory({agentId:item.id});
    if (!current.complete) return { ...item, running:null, eligible:false, firstEligible:false, reason:current.reason };
    return current.items.find(entry => entry.id === item.id) ?? { ...item, running:null, eligible:false, firstEligible:false, reason:'roster-item-not-found' };
  }
  async function resume(id, context = {}) {
    const withBytes=result=>{try{return {...result,...takeRosterReleasedBytes(filename,id)};}catch(error){return {...result,bytes:null,bytesUnknown:true,bytesReason:`release-accounting-unavailable:${error.message}`};}};
    if (!['first','rules'].includes(context.mode) || typeof context.revalidate !== 'function') return {removed:false,reason:'cleanup-authorization-missing',ticketId:id,bytes:0};
    const existing=readRosterTicket(filename,id);
    if (existing?.status === 'completed') return withBytes({removed:true,ticketId:id});
    if (!existing || existing.status !== 'claimed') return {removed:false,reason:'ticket-not-claimed',ticketId:id,bytes:0};
    try {
      let steps=rosterSteps(filename,id);
      const plans=steps.filter(step => step.step === 'plan').map(step => ({agentId:step.agent,...step.payload}))
        .sort((a,b)=>Number(a.nativeLeader && a.nativeLeader!==a.agentId)-Number(b.nativeLeader && b.nativeLeader!==b.agentId) || b.index-a.index);
      if (plans.length !== JSON.parse(existing.tree_ids).length || plans.some(plan => plan.mode !== context.mode)) throw new Error('ticket-plan-incomplete-or-mode-changed');
      for (const plan of plans) {
        if (!await context.revalidate() || !verifyRosterTicket(filename,id).valid) throw new Error('cleanup-authorization-or-tree-changed');
        steps=rosterSteps(filename,id);
        const done = step => steps.some(row => row.agent === plan.agentId && row.step === step);
        if (!done('native-complete')) {
          if (plan.nativeLeader && plan.nativeLeader !== plan.agentId) {
            const leader=steps.find(row => row.agent===plan.nativeLeader && row.step==='native-complete');
            if (!leader?.payload?.removed) throw new Error('native-covering-tree-unconfirmed');
            if (!Array.isArray(leader.payload.managedAgentsRemoved) || !leader.payload.managedAgentsRemoved.includes(plan.agentId))
              throw new Error('covered-managed-sidecar-unconfirmed');
            recordRosterStep(filename,id,plan.agentId,'native-complete',{removed:true,coveredBy:plan.nativeLeader,nativeTicket:plan.nativeToken,releasedBytes:0});
          } else {
          const staged=steps.find(row => row.agent === plan.agentId && row.step === 'native-staged')?.payload;
          // The DSH stage is idempotent under its exact operation token. Codex has no replayable delete.
          if (done('native-started') && !staged && plan.record.target==='codex-desktop') {
            const acknowledged=await desktop.confirmDeleted?.(plan.record,plan.backendState,plan.native);
            if(acknowledged?.removed) {recordRosterStep(filename,id,plan.agentId,'native-complete',{...acknowledged,releasedBytes:null});return resume(id,context);}
            throw new Error('native-outcome-unconfirmed');
          }
          if (!await context.revalidate()) throw new Error('cleanup-authorization-changed');
          if (!done('native-started')) recordRosterStep(filename,id,plan.agentId,'native-started',{target:plan.record.target ?? 'dsh'});
          const voided=steps.find(s=>s.step==='recipient-voided')?.payload;
          const grouped=plans.filter(member => (member.nativeLeader ?? member.agentId) === plan.agentId);
          const receiptMap=new Map(grouped.flatMap(member => voided?.questionReceipts?.[member.agentId] ?? []).map(receipt => [`${receipt.sessionId}\n${receipt.id}`,receipt]));
          const nativeContext={...context,operationToken:plan.nativeToken??id,recipientDeleted:!!voided,
            ...(voided?.ownerProof ? {disposition:{recipientDeleted:true,ticketId:id,operationToken:plan.nativeToken??id,ownerId:voided.ownerId,
              archiveManifestHash:voided.archiveManifestHash,ownerProof:voided.ownerProof,questionReceipts:[...receiptMap.values()]}} : {})};
          const result = (plan.record.target ?? 'dsh') === 'dsh'
            ? staged ? typeof dsh.finalizeManaged === 'function'
              ? await dsh.finalizeManaged(plan.record,plan.backendState,plan.native,nativeContext)
              : {removed:false,reason:'managed-finalize-unavailable'}
              : await dsh.removeManaged(plan.record,plan.backendState,plan.native,nativeContext)
            : await desktop.remove(plan.record,plan.backendState,plan.native,nativeContext);
          if (result?.staged === true && result.removed !== true) {
            if (!staged) recordRosterStep(filename,id,plan.agentId,'native-staged',result);
            return withBytes({removed:false,reason:result.reason ?? 'awaiting-grace-and-recheck',staged:true,ticketId:id,eligibleAt:result.eligibleAt,steps:rosterSteps(filename,id)});
          }
          if(result?.notSent===true) {
            forgetUnsentStep(filename,id,plan.agentId);
            try {
              releaseRosterTicket(filename,id);
              return withBytes({removed:false,retryFromInventory:true,reason:result.reason??'native-operation-not-sent'});
            }catch(error){if(error.message!=='ticket-already-started')throw error;}
          }
          if (result?.removed !== true) throw new Error(result?.reason ?? 'native-removal-unconfirmed');
          const releasedBytes=result.alreadyRemoved ? null : Number.isSafeInteger(result.bytes) && result.bytes>=0
            ? result.bytes : result.nativeSessionRetained===true ? 0 : null;
          recordRosterStep(filename,id,plan.agentId,'native-complete',{...result,releasedBytes});
          }
        }
        if (!await context.revalidate() || !verifyRosterTicket(filename,id).valid) throw new Error('cleanup-authorization-or-tree-changed');
        if (!done('private-complete')) {
          const previous=steps.find(row => row.agent===plan.agentId && row.step==='private-started')?.payload;
          // A ticket written by the previous version has no snapshot. Measure only
          // the still-identical directory; an already missing directory stays unknown.
          let measured=plan.privateSnapshot ?? previous?.snapshot;
          if (!measured) {
            measured=await privateSnapshot(config,plan.record);
            const claimTime=Date.parse(existing.created);
            if (measured.identity.exists && (!Number.isFinite(claimTime) || measured.latestMutationMs>claimTime)) throw new Error('private-legacy-content-changed');
          }
          if (previous?.fingerprint && measured.fingerprint!==previous.fingerprint) throw new Error('private-content-changed');
          if (!done('private-started')) recordRosterStep(filename,id,plan.agentId,'private-started',{fingerprint:measured.fingerprint,snapshot:measured});
          const released=await removePrivate(config,plan.record,plan.privateIdentity,measured);
          recordRosterStep(filename,id,plan.agentId,'private-complete',{removed:true,...released});
        }
      }
      if (!await context.revalidate() || !verifyRosterTicket(filename,id).valid) throw new Error('cleanup-authorization-or-tree-changed');
      completeRosterTicket(filename,id);
      return withBytes({removed:true,ticketId:id,nativeSessionRetained:plans.every(plan => plan.record.target === 'claude-cli')});
    } catch (error) { return withBytes({removed:false,reason:error.message,ticketId:id,steps:rosterSteps(filename,id)}); }
  }
  async function remove(item, context = {}) {
    if (!['first','rules'].includes(context.mode) || typeof context.revalidate !== 'function') return {removed:false,reason:'cleanup-authorization-missing'};
    if (!await context.revalidate()) return {removed:false,reason:'cleanup-authorization-changed'};
    const current = await inspect(item);
    if (current.running !== false || current.activityVersion !== item.activityVersion || JSON.stringify(current.treeIds) !== JSON.stringify(item.treeIds)) return {removed:false,reason:'changed-or-uncertain'};
    const observed = Number(context.observedSince);
    const aged = current.observationMs > 0 && Number.isFinite(observed) && observed > 0 && now() >= observed + current.observationMs;
    if (context.mode === 'first' ? !current.firstEligible : !(current.eligible || (current.firstEligible && aged))) return {removed:false,reason:'not-eligible'};
    if (context.mode !== 'first' && config.codexAutoCleanup === false && current.records.some(record => record.target === 'codex-desktop')) return {removed:false,reason:'codex-auto-cleanup-disabled'};
    if (!await context.revalidate()) return {removed:false,reason:'cleanup-authorization-changed'};
    let claimed;
    const externalArchives=current.natives.flatMap(native => {
      if(!native.managed)return [];
      const member=current.records.find(record=>record.agentId===native.agentId);
      const entries=native.history.map(entry=>({...entry,agentId:native.agentId}));
      for(const [type,list] of [['question',native.questions],['report',native.reports]]) {
        for(const entry of list??[]) {
          if(!entry.id)throw new Error('native-body-without-stable-id');
          entries.push({agentId:native.agentId,sourceId:entry.id,sessionId:entry.sessionId ?? member.sessionId,event:entry,sourceType:type});
        }
      }
      return entries;
    });
    try { claimed = claimRosterTree(filename,{rootId:current.agentId,fingerprint:current.rosterFingerprint,externalArchives,...(context.operationToken ? {ticketId:context.operationToken} : {})}); }
    catch (error) { return {removed:false,reason:error.message}; }
    const id = claimed.id;
    try {
      if (!await context.revalidate()) { releaseRosterTicket(filename,id); return {removed:false,reason:'cleanup-authorization-changed',ticketId:id}; }
      const byId = new Map(current.natives.map(native => [native.agentId,native]));
      for (const [index,record] of current.records.entries()) {
        if (!await context.revalidate() || !verifyRosterTicket(filename,id).valid) throw new Error('cleanup-authorization-or-tree-changed');
        const leader=current.nativeGroups?.[record.agentId];
        const privateState=await privateSnapshot(config,record);
        recordRosterStep(filename,id,record.agentId,'plan',{index,mode:context.mode,record,backendState:current.backendStates[record.agentId],native:byId.get(record.agentId),
          ...(leader ? {nativeLeader:leader,nativeToken:nativeToken(id,leader)} : {}),privateIdentity:privateState.identity,privateSnapshot:privateState});
      }
      if (current.ownerDeleted) {
        const nativeQuestions=current.natives.flatMap(native => {
          const member=current.records.find(record => record.agentId===native.agentId);
          return native.managed ? (native.questions??[]).filter(question=>question.state==='pending')
            .map(question=>({agentId:native.agentId,sessionId:question.sessionId??member.sessionId,id:question.id,message:question.message})) : [];
        });
        const status=current.ownerStatus;
        const ownerProof=status.domain && status.source && status.threadId && status.receiptId
          ? {state:'deleted',domain:typeof status.domain==='string'?status.domain:JSON.stringify(status.domain),source:status.source,
            threadId:status.threadId,receiptId:status.receiptId,removedAt:status.removedAt} : undefined;
        voidRosterRecipient(filename,id,current.ownerId,{ownerProof,nativeQuestions});
      }
      return await resume(id,context);
    } catch (error) {
      try { releaseRosterTicket(filename,id); } catch { /* retain ticket for inspection */ }
      return {removed:false,reason:error.message,ticketId:id,steps:rosterSteps(filename,id)};
    }
  }
  async function archives(query = {}) { return readRosterArchives(filename, query); }
  // These are transaction primitives, not permission to delete at a native host.
  const claim = (item, options = {}) => claimRosterTree(filename, { ...options, rootId: item.agentId, fingerprint: item.rosterFingerprint });
  const ticket = id => readRosterTicket(filename, id);
  const tickets = status => listRosterTickets(filename, status);
  const verifyTicket = id => verifyRosterTicket(filename, id);
  const releasedBytes = id => takeRosterReleasedBytes(filename,id);
  const release = id => releaseRosterTicket(filename, id);
  async function restore(id) {
    const receipt=readRosterTicket(filename,id);
    if(receipt?.status!=='claimed')return {restored:false,reason:'ticket-not-claimed'};
    const steps=rosterSteps(filename,id);
    if(steps.some(s=>['native-complete','private-complete'].includes(s.step)))return {restored:false,reason:'ticket-has-committed-lifecycle-changes'};
    for(const step of steps.filter(s=>s.step==='native-started')) {
      const stage=steps.find(s=>s.step==='native-staged' && s.agent===step.agent);
      const plan=steps.find(s=>s.step==='plan' && s.agent===step.agent)?.payload;
      if(!stage || !plan || (plan.record.target??'dsh')!=='dsh')return {restored:false,reason:'native-stage-unverified'};
      const result=await dsh.restoreManaged(plan.record,{operationToken:stage.payload.ticket??id});
      if(!result?.restored)return result;
      markRosterRestored(filename,id,step.agent);
    }
    releaseRosterTicket(filename,id,undefined,{restored:true});
    return {restored:true,ticket:id};
  }
  return { inventory, inspect, remove, resume, restore, archives, claim, ticket, tickets, verifyTicket, releasedBytes, release };
}
