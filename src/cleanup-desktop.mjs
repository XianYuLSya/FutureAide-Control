import { createHash } from 'node:crypto';
import path from 'node:path';
import { lstat } from 'node:fs/promises';
import { requestCodexNative } from './codex-ipc.mjs';
import { readClaudeTurn } from './claude-cli-runner.mjs';
import { codexDomainForThread, sameCodexDomain } from './codex-domain.mjs';
import { deletionReceipt, rememberDeleted } from './cleanup-native-receipts.mjs';

const sources = ['cli','vscode','exec','appServer','subAgent','subAgentReview','subAgentCompact','subAgentThreadSpawn','subAgentOther','unknown'];
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const samePath = (a,b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const unknown = reason => ({ running: null, treeIds: [], activityVersion: '', reason });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]{0,119}$/.test(value);

// This adapter only observes native activity; it does not send cancel or interrupt.
// The caller must fence accepted inputs and remove the private roster after a successful retirement.
export function createDesktopCleanup(config = {}) {
  const request = config.nativeRequest ?? requestCodexNative;
  const readTurn = config.readClaudeTurn ?? readClaudeTurn;
  const domainForThread = config.domainForThread ?? codexDomainForThread;
  const isAlive = config.isProcessAlive ?? (pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  });
  async function pages(method, params) {
    const rows = [], cursors = new Set(); let cursor;
    do {
      const page = await request(method, { ...params, limit: 100, ...(cursor ? { cursor } : {}) }, { background: true });
      if (!Array.isArray(page?.data)) throw new Error('invalid-page');
      rows.push(...page.data);
      if (rows.length > 1000) throw new Error('tree-or-history-too-large');
      const next = page.nextCursor;
      if (next != null && (typeof next !== 'string' || !next || !page.data.length || cursors.has(next))) throw new Error('paging-incomplete');
      if (next) cursors.add(next);
      cursor = next;
    } while (cursor);
    return rows;
  }
  async function codex(record, state) {
    const root = state?.binding;
    if (root?.owned !== true || !validId(root.sessionId)) return unknown('codex-owned-binding-unconfirmed');
    if (Object.values(state.requests ?? {}).some(r => r?.attempted && r.status !== 'accepted' && r.status !== 'rejected')) return unknown('codex-dispatch-unconfirmed');
    const owned = new Set([root.sessionId, ...(state.tree?.nodes ?? []).map(n => n.sessionId)]);
    if ([...owned].some(id => !validId(id))) return unknown('codex-owned-tree-invalid');
    const queue = [{id:root.sessionId,parent:null}], found = new Set(), activity = [];
    try {
      for (const node of queue) {
        if (found.has(node.id) || !owned.has(node.id)) return unknown('codex-tree-changed');
        found.add(node.id);
        const response = await request('thread/read', {threadId:node.id, includeTurns:false}, {background:true});
        const thread = response?.thread;
        if (thread?.id !== node.id || !samePath(thread.cwd, record.workspace)) return unknown('codex-identity-or-workspace-unverified');
        const domain = await domainForThread(thread);
        if (!sameCodexDomain(root.codexDomain, domain)) return unknown('codex-creation-domain-unverified');
        const status = thread.status?.type;
        if (!['idle','notLoaded','active','systemError'].includes(status)) return unknown('codex-status-unknown');
        const turns = await pages('thread/turns/list', {threadId:node.id, itemsView:'summary'});
        if (turns.some(t => !['completed','failed','interrupted'].includes(t.status))) {
          return {running:true, treeIds:[...found], activityVersion:'', reason:'codex-turn-active-or-unknown'};
        }
        if (status === 'systemError' && !turns.some(turn => turn.status === 'failed')) return unknown('codex-system-error-unverified');
        if (status === 'active') return {running:true, treeIds:[...found], activityVersion:'', reason:'codex-thread-active'};
        activity.push({id:node.id,parent:node.parent,cwd:thread.cwd,path:thread.path,updatedAt:thread.updatedAt,turns});
        for (const archived of [false,true]) {
          const children = await pages('thread/list', {parentThreadId:node.id, archived, useStateDbOnly:true, sourceKinds:sources});
          for (const child of children) {
            if (!validId(child?.id) || queue.some(x => x.id === child.id)) return unknown('codex-tree-ambiguous');
            queue.push({id:child.id,parent:node.id});
          }
        }
      }
      if (owned.size !== found.size) return unknown('codex-tree-changed');
      const treeIds = [...found].sort();
      const turns=activity.flatMap(entry=>entry.turns), dates=turns.map(turn=>{
        const value=turn.completedAt ?? turn.endedAt;
        return typeof value==='number' && Number.isFinite(value) ? (value<1e12?value*1000:value) : Date.parse(value ?? '');
      });
      const lastActivityAt=dates.length && dates.every(Number.isFinite) ? new Date(Math.max(...dates)).toISOString() : null;
      return {running:false,treeIds,activityVersion:digest(activity),activity,lastActivityAt,historyPresent:turns.length>0};
    } catch (error) { return unknown(`codex-observation-unverified:${error.code ?? error.message ?? 'error'}`); }
  }
  async function claude(record, state) {
    if (!validId(record.sessionId) || !config.stateDirectory || !validId(record.ownerId) || !validId(record.agentId)) return unknown('claude-identity-unverified');
    if (!state || typeof state.requests !== 'object' || state.active) return state?.active
      ? {running:true,treeIds:[record.sessionId],activityVersion:'',reason:'claude-worker-active-or-unverified'} : unknown('claude-state-unverified');
    const results = [];
    try {
      for (const [id, entry] of Object.entries(state.requests)) {
        if (!validId(id) || !['accepted','rejected'].includes(entry?.status)) return unknown('claude-dispatch-unconfirmed');
        if (entry.status === 'rejected') continue;
        const dir = path.join(config.stateDirectory,'scoped',record.ownerId,record.agentId,'claude-cli','turns',id);
        const turn = await readTurn(dir);
        if (!['ended','failed','cancelled'].includes(turn?.state) || !turn.endedAt) return unknown('claude-worker-exit-unverified');
        if ([turn.workerPid,turn.claudePid].some(pid => Number.isSafeInteger(pid) && pid > 0 && isAlive(pid))) return {running:true,treeIds:[record.sessionId],activityVersion:'',reason:'claude-process-still-alive'};
        results.push({id,state:turn.state,startedAt:turn.startedAt,endedAt:turn.endedAt,request:entry});
      }
      const dates=results.map(value=>Date.parse(value.endedAt));
      const lastActivityAt=dates.length && dates.every(Number.isFinite) ? new Date(Math.max(...dates)).toISOString() : null;
      return {running:false,treeIds:[record.sessionId],activityVersion:digest(results),lastActivityAt,historyPresent:results.length>0};
    } catch (error) { return unknown(`claude-observation-unverified:${error.code ?? error.message ?? 'error'}`); }
  }
  async function inspect(record, state) {
    if (record?.target === 'codex-desktop') return codex(record,state);
    if (record?.target === 'claude-cli') return claude(record,state);
    return unknown('unsupported-target');
  }
  async function remove(record,state,expected,context = {}) {
    if (record?.target === 'codex-desktop' && config.codexAutoCleanup === false && context.mode !== 'first') return {removed:false,reason:'codex-auto-cleanup-disabled'};
    const current = await inspect(record,state);
    if (current.running !== false) return {removed:false,notSent:true,reason:current.reason ?? 'activity-unverified'};
    if (!expected || current.activityVersion !== expected.activityVersion || JSON.stringify(current.treeIds) !== JSON.stringify(expected.treeIds)) return {removed:false,notSent:true,reason:'activity-or-tree-changed'};
    if (record.target === 'codex-desktop') {
      if (typeof context.canDelete !== 'function') return {removed:false,reason:'cleanup-gate-unavailable'};
      let reply;
      try {
        reply = await request('futureaide/cleanup/delete', {threadId:state.binding.sessionId,
          treeIds:current.treeIds, activity:current.activity}, {canRelease:context.canDelete});
      } catch(error) { return {removed:false,reason:`codex-delete-unconfirmed:${error.code ?? 'error'}`}; }
      if (reply?.status !== 'deleted') return {removed:false,notSent:reply?.notSent===true || ['inUse','notSent'].includes(reply?.status),reason:reply?.reason ?? reply?.status ?? 'codex-delete-unconfirmed'};
      try {
        for (const archived of [false,true]) {
          const remaining=await pages('thread/list',{archived,useStateDbOnly:true,sourceKinds:sources});
          if (remaining.some(thread => current.treeIds.includes(thread.id))) return {removed:false,reason:'codex-delete-partial',deleteAcknowledged:true};
        }
      } catch {return {removed:false,reason:'codex-delete-verification-unavailable',deleteAcknowledged:true};}
      rememberDeleted(config,state.binding.codexDomain,current.treeIds);
      return {removed:true,deletedIds:current.treeIds};
    }
    // No native Claude history is deleted. The enclosing transaction retires its private state.
    return {removed:true,nativeSessionRetained:true};
  }
  async function ownerStatus(owner) {
    // A local missing/notLoaded result is not a same-domain deletion receipt.
    if (owner?.source !== 'codex-desktop' || !validId(owner.threadId) || !owner.codexDomain) return {state:'unknown',reason:'owner-identity-or-domain-unverified'};
    try {
      const thread = (await request('thread/read',{threadId:owner.threadId,includeTurns:false},{background:true}))?.thread;
      const domain = await domainForThread(thread);
      if (thread?.id === owner.threadId && sameCodexDomain(owner.codexDomain,domain)) return {state:'present'};
    } catch { /* No read response proves deletion. */ }
    const receipt=deletionReceipt(config,owner);
    if(receipt) {
      try {
        let sameHost=false;
        for(const archived of [false,true]) {
          const rows=await pages('thread/list',{archived,useStateDbOnly:true,sourceKinds:sources});
          if(rows.some(r=>r.id===owner.threadId))return {state:'unknown',reason:'owner-listed-again'};
          for(const r of rows) {
            if(sameHost)break;
            sameHost=sameCodexDomain(await domainForThread(r),owner.codexDomain);
          }
        }
        if(sameHost)return {state:'deleted',domain:owner.codexDomain,source:'confirmed-native-delete-and-current-lists',
          threadId:owner.threadId,receiptId:digest([owner.threadId,receipt.domain,receipt.removedAt]),
          reason:'confirmed-native-delete-in-creation-domain',removedAt:receipt.removedAt};
      }catch { /* No current confirmation from the original domain. */ }
    }
    return {state:'unknown',reason:'codex-owner-not-authoritatively-deleted'};
  }
  async function confirmDeleted(record,state,expected) {
    if(record.target!=='codex-desktop' || !state?.binding?.codexDomain || !expected?.treeIds?.length)return {removed:false};
    const domain=state.binding.codexDomain, ids=new Set(expected.treeIds);
    // A lost write reply is never replayed. Reconcile only the frozen target, using both native inventories,
    // the original physical rollouts and an independently identifiable live thread in the same host.
    const seen=new Set();let witness=false;
    try {
      for(const archived of [false,true]) {
        for(const row of await pages('thread/list',{archived,useStateDbOnly:true,sourceKinds:sources})) {
          if(ids.has(row.id))return {removed:false};
          if(!witness)witness=sameCodexDomain(domain,await domainForThread(row));
        }
      }
      if(!witness)return {removed:false};
      for(const node of expected.activity??[]) {
        if(!ids.has(node.id) || !node.path || !samePath(node.cwd,record.workspace))return {removed:false};
        const relative=path.relative(domain.home,node.path);
        if(!/^(sessions|archived_sessions)[/\\\\]/i.test(relative) || !path.basename(node.path).includes(node.id))return {removed:false};
        try{await lstat(node.path);return {removed:false};}catch(e){if(e.code!=='ENOENT')return {removed:false};}
        seen.add(node.id);
      }
    }catch{return {removed:false};}
    return seen.size===ids.size?{removed:true,deletedIds:expected.treeIds,recovered:true,reason:'native-lists-and-original-rollouts-absent'}:{removed:false};
  }
  return {inspect,remove,ownerStatus,confirmDeleted};
}
