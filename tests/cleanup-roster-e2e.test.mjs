import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { RosterStore } from '../src/roster-store.mjs';
import { createRosterCleanup } from '../src/cleanup-roster.mjs';
import { createDesktopCleanup } from '../src/cleanup-desktop.mjs';
import { createHash } from 'node:crypto';
import { recoverRosterOperation } from '../src/cleanup-roster-recovery.mjs';

const proofDomain={version:1,home:'C:/fixture-codex',dev:'1',ino:'2'};
const deletedProof={state:'deleted',domain:proofDomain,source:'confirmed-native-delete-and-current-lists',threadId:'caller',receiptId:'deletion-receipt',removedAt:'2020-01-01T00:00:00Z'};
function fixture({lifetime='once', state='failed', task, ownerStatus, desktopOverrides={}, retention=100, cleanupNow} = {}) {
  const dir=mkdtempSync(path.join(os.tmpdir(),'cleanup-claude-'));
  const store=new RosterStore(path.join(dir,'roster.sqlite'));
  store.saveOwner({ownerId:'owner',workspace:'w',source:'codex-desktop',threadId:'caller',codexDomain:proofDomain});
  const record={agentId:'agent',ownerId:'owner',name:'helper',sessionId:'session',target:'claude-cli',lifetime,state,
    task:task ?? {taskId:'round',state:'failed',finishedAt:'2020-01-01T00:00:00Z',reports:[{id:'final',message:'未达正文\n完整',final:true,createdAt:'2020-01-01T00:00:00Z',delivery:{state:'blocked',blockedAt:'2020-01-01T00:00:01Z'}}]}};
  store.insert(record); store.saveBackendState('agent',{requests:{}});
  const privatePath=path.join(dir,'scoped','owner','agent'); mkdirSync(privatePath,{recursive:true}); writeFileSync(path.join(privatePath,'private'),'private');
  const nativePath=path.join(dir,'native-history'); writeFileSync(nativePath,'native survives');
  const desktop=createDesktopCleanup({stateDirectory:dir,...desktopOverrides});
  if(ownerStatus) desktop.ownerStatus=ownerStatus;
  const engine=createRosterCleanup({stateDirectory:dir,onceTerminalRetentionMs:retention,agentIdleRetentionMs:retention,cleanupNow},{desktop});
  return {dir,store,engine,record,privatePath,nativePath,close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('R02 a second final that was just sealed still needs the whole retention period',async()=>{
  const stamp=new Date().toISOString(),now=Date.parse(stamp);
  const f=fixture({state:'idle',retention:86400000,cleanupNow:()=>now,task:{taskId:'round',state:'completed',finishedAt:stamp,autoCleanupHeld:true,reports:[
    {id:'received',message:'ok',final:true,delivery:{state:'delivered',deliveredAt:stamp}},
    {id:'blocked',message:'second final',final:true,delivery:{state:'blocked',blockedAt:stamp}}]}});
  try {assert.equal((await f.engine.inventory()).items[0].eligible,false);}finally{f.close();}
});

test('R01 delivered final permits retiring a held once after its blocked intermediate text is saved',async()=>{
  const f=fixture({state:'supplement_blocked',task:{taskId:'round',state:'completed',autoCleanupHeld:true,finishedAt:'2020-01-02T00:00:00Z',
    reports:[{id:'intermediate',message:'封口正文\\n第二行',final:false,delivery:{state:'blocked',blockedAt:'2020-01-01T00:00:00Z'}},
      {id:'delivered',message:'已送达',final:true,delivery:{state:'delivered',deliveredAt:'2020-01-02T00:00:00Z'}}]}});
  try {
    const item=(await f.engine.inventory()).items[0];assert.equal(item.eligible,true,item.reason);
    const result=await f.engine.remove(item,{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result));
    assert.equal((await f.engine.archives({originalId:'intermediate'}))[0].payload.message,'封口正文\\n第二行');
  }finally{f.close();}
});

test('Claude failed once archives and removes private state while preserving native history',async()=>{
  const f=fixture();
  try {
    const item=(await f.engine.inventory()).items[0];
    assert.equal(item.running,false); assert.equal(item.eligible,true); assert.equal(item.firstEligible,true);
    const result=await f.engine.remove(item,{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result));
    assert.equal(f.store.get('agent'),undefined); assert.ok(f.store.owner('owner'));
    assert.equal(existsSync(f.privatePath),false); assert.equal(existsSync(f.nativePath),true);
    assert.equal((await f.engine.archives({name:'helper',originalId:'final'}))[0].payload.message,'未达正文\n完整');
    assert.equal(f.engine.ticket(result.ticketId).status,'completed');
  } finally {f.close();}
});

test('pending work and uncertain native activity never qualify',async()=>{
  const f=fixture({desktopOverrides:{readClaudeTurn:async()=>({state:'running'})}});
  try {
    f.store.saveBackendState('agent',{requests:{r:{status:'accepted'}}});
    const item=(await f.engine.inventory()).items[0];
    assert.notEqual(item.running,false); assert.equal(item.firstEligible,false);
    assert.equal((await f.engine.remove(item,{mode:'first',revalidate:async()=>true})).removed,false);
  } finally {f.close();}
});

test('owner deletion archives pending ask before it is voided and removes private state',async()=>{
  const f=fixture({lifetime:'persistent',state:'idle',task:{taskId:'round',finishedAt:'2020-01-01T00:00:00Z'},ownerStatus:async()=>deletedProof});
  try {
    f.store.enqueueSubmission({id:'ask',ownerId:'owner',agentId:'agent',taskId:'round',kind:'ask',message:'无人接收的问题',created:'2020-01-01T00:00:00Z'});
    const item=(await f.engine.inventory()).items[0];
    assert.equal(item.eligible,true);
    const result=await f.engine.remove(item,{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result));
    assert.equal((await f.engine.archives({originalId:'ask'}))[0].payload.message,'无人接收的问题');
  } finally {f.close();}
});

test('interrupted after native receipt resumes using the persisted ticket',async()=>{
  const f=fixture();
  try {
    const item=(await f.engine.inventory()).items[0]; let checks=0;
    const partial=await f.engine.remove(item,{mode:'rules',revalidate:async()=>++checks<7});
    assert.equal(partial.removed,false); assert.equal(f.engine.ticket(partial.ticketId).status,'claimed');
    assert.ok(partial.steps.some(step=>step.step==='native-complete'));
    const resumed=await f.engine.resume(partial.ticketId,{mode:'rules',revalidate:async()=>true});
    assert.equal(resumed.removed,true,JSON.stringify(resumed));
    assert.equal(f.store.get('agent'),undefined);
    assert.equal((await f.engine.resume(partial.ticketId,{mode:'rules',revalidate:async()=>true})).removed,true);
  } finally {f.close();}
});

test('service token recovers the matching real roster ticket',async()=>{
  const f=fixture();
  try {
    const item=(await f.engine.inventory()).items[0]; let checks=0;
    const partial=await f.engine.remove(item,{mode:'rules',operationToken:'service-token',revalidate:async()=>++checks<7});
    assert.equal(partial.ticketId,'service-token'); assert.equal(partial.removed,false);
    const prior={key:JSON.stringify(['roster','managed-agent',f.dir,'agent']),mode:'rules',plan:JSON.stringify({ticketToken:'service-token'})};
    const result=await recoverRosterOperation(f.engine,prior,{revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result));
  } finally {f.close();}
});

test('unknown old terminal time permits first only; rules wait a full observation period',async()=>{
  const f=fixture({task:{taskId:'round',state:'failed',reports:[]},retention:100000});
  try {
    const item=(await f.engine.inventory()).items[0];
    assert.equal(item.firstEligible,true); assert.equal(item.eligible,false); assert.equal(item.observationMs,100000);
    const before=await f.engine.remove(item,{mode:'rules',observedSince:Date.now()-1000,revalidate:async()=>true});
    assert.equal(before.removed,false);
    const after=await f.engine.remove(item,{mode:'rules',observedSince:Date.now()-100001,revalidate:async()=>true});
    assert.equal(after.removed,true,JSON.stringify(after));
  } finally {f.close();}
});

test('unverified cancellation and a cross-round pending report block cleanup',async()=>{
  const f=fixture({state:'cancelled',task:{taskId:'round',state:'cancelled',finishedAt:'2020-01-01T00:00:00Z'}});
  try {
    assert.equal((await f.engine.inventory()).items[0].firstEligible,false);
    const record=f.store.get('agent'); record.state='failed'; record.task.state='failed'; f.store.save(record);
    f.store.appendHistory('agent',{taskId:'old',reports:[{id:'old-report',message:'尚未收到',delivery:{state:'pending'}}]});
    const item=(await f.engine.inventory()).items[0];
    assert.equal(item.firstEligible,false); assert.equal(item.reason,'historical-report-pending');
  } finally {f.close();}
});

test('terminal and idle deadlines use the exact millisecond boundary',async()=>{
  const base=Date.parse('2020-01-01T00:00:00Z'); let now=base+999;
  const f=fixture({retention:1000,cleanupNow:()=>now,task:{taskId:'round',state:'failed',finishedAt:'2020-01-01T00:00:00Z',reports:[]}});
  try {
    assert.equal((await f.engine.inventory()).items[0].eligible,false);
    now=base+1000; assert.equal((await f.engine.inventory()).items[0].eligible,true);
  } finally {f.close();}
});

test('heartbeat updates do not change business version and changed activity does',async()=>{
  const f=fixture();
  try {
    const first=(await f.engine.inventory()).items[0];
    f.store.db.prepare("UPDATE agents SET body=json_set(body,'$.updatedAt','2030-01-01T00:00:00Z','$.nextAttemptAt',42) WHERE id='agent'").run();
    const heartbeat=(await f.engine.inventory()).items[0];
    assert.equal(heartbeat.activityVersion,first.activityVersion);
    f.store.db.prepare("UPDATE agents SET body=json_set(body,'$.task.reports[0].message','changed') WHERE id='agent'").run();
    const changed=(await f.engine.inventory()).items[0];
    assert.notEqual(changed.activityVersion,first.activityVersion);
  } finally {f.close();}
});

test('blocked final submission remains recoverable and qualifies after its seal time',async()=>{
  const f=fixture({state:'idle',task:{taskId:'round',finishedAt:'2020-01-01T00:00:00Z',reports:[]}});
  try {
    f.store.enqueueSubmission({id:'final-sub',ownerId:'owner',agentId:'agent',taskId:'round',kind:'report',message:'被封口',final:true,created:'2020-01-01T00:00:00Z'});
    f.store.db.prepare('UPDATE submissions SET delivery=? WHERE id=?').run(JSON.stringify({state:'blocked',blockedAt:'2020-01-01T00:00:01Z'}),'final-sub');
    const item=(await f.engine.inventory()).items[0]; assert.equal(item.eligible,true,JSON.stringify(item));
    const result=await f.engine.remove(item,{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result));
    assert.equal((await f.engine.archives({originalId:'final-sub'}))[0].payload.message,'被封口');
  } finally {f.close();}
});

test('delivered question still blocks while its answer is missing',async()=>{
  const f=fixture({lifetime:'persistent',state:'idle',task:{taskId:'round',finishedAt:'2020-01-01T00:00:00Z'}});
  try {
    f.store.enqueueSubmission({id:'ask',ownerId:'owner',agentId:'agent',taskId:'round',kind:'ask',message:'还没回答',created:'2020-01-01T00:00:00Z'});
    f.store.db.prepare("UPDATE submissions SET state='consumed',delivery=? WHERE id='ask'").run(JSON.stringify({state:'delivered',deliveredAt:'2020-01-01T00:00:00Z'}));
    const item=(await f.engine.inventory()).items[0]; assert.equal(item.firstEligible,false); assert.equal(item.reason,'question-unanswered');
  } finally {f.close();}
});

test('recipient-deleted disposition is durable before any native action',async()=>{
  const f=fixture({lifetime:'persistent',state:'idle',task:{taskId:'round',finishedAt:'2020-01-01T00:00:00Z'},ownerStatus:async()=>deletedProof});
  try {
    f.store.enqueueSubmission({id:'ask',ownerId:'owner',agentId:'agent',taskId:'round',kind:'ask',message:'保全原问题',created:'2020-01-01T00:00:00Z'});
    const item=(await f.engine.inventory()).items[0]; let calls=0;
    const result=await f.engine.remove(item,{mode:'rules',revalidate:async()=>++calls<5});
    assert.equal(result.removed,false);
    const row=f.store.db.prepare('SELECT state,delivery FROM submissions WHERE id=?').get('ask');
    assert.equal(row.state,'consumed'); assert.equal(JSON.parse(row.delivery).reason,'recipient-deleted');
    assert.equal((await f.engine.archives({originalId:'ask'}))[0].payload.message,'保全原问题');
    assert.equal((await f.engine.resume(result.ticketId,{mode:'rules',revalidate:async()=>true})).removed,true);
  } finally {f.close();}
});

test('managed DSH native byte estimate deduplicates the same native descendants',async()=>{
  const f=fixture();
  try {
    const r=f.store.get('agent');r.target='dsh';r.sessionId='parent';f.store.save(r);
    f.store.insert({agentId:'child',ownerId:'owner',name:'child',parentAgentId:'agent',sessionId:'child-session',target:'dsh',state:'idle'});
    const inventory={complete:false,items:[
      {id:'parent',nodes:[{sessionId:'parent',bytes:10},{sessionId:'child-session',bytes:20}]},
      {id:'child-session',nodes:[{sessionId:'child-session',bytes:20}]}]};
    const engine=createRosterCleanup({stateDirectory:f.dir},{dsh:{inventory:async()=>inventory}});
    const item=(await engine.inventory()).items[0];assert.equal(item.bytes,30);assert.equal(item.running,null);
  } finally {f.close();}
});

test('managed DSH contract archives raw native events before conditional removal',async()=>{
  const f=fixture();
  try {
    const record=f.store.get('agent');record.target='dsh';record.workspace=f.dir;f.store.save(record);
    const raw={seq:9,type:'assistant/message',time:'2020-01-01T00:00:00Z',data:{content:[{type:'text',text:'原始事件\n中文'}]}};
    let archivedBeforeRemove=false;
    const dsh={inventory:async()=>({complete:false,items:[]}),
      inspectManaged:async()=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:true,lastActivityAt:Date.parse('2020-01-01T00:00:00Z'),
        treeIds:['session'],activityVersion:'native-v1',history:[{sourceId:'session:9',sessionId:'session',event:raw}],questions:[],reports:[]}),
      removeManaged:async(r,s,expected,context)=>{archivedBeforeRemove=(await engine.archives({originalId:'session:9'})).length===1;assert.equal(expected.history[0].event.data.content[0].text,'原始事件\n中文');return {removed:true};}};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100},{dsh});
    const item=(await engine.inventory()).items[0];assert.equal(item.eligible,true,JSON.stringify(item));
    assert.equal((await engine.remove(item,{mode:'rules',revalidate:async()=>true})).removed,true);
    assert.equal(archivedBeforeRemove,true);
    assert.deepEqual((await engine.archives({originalId:'session:9'}))[0].payload.event,raw);
  } finally {f.close();}
});

test('managed DSH staging retains one roster ticket until native finalize confirms',async()=>{
  const f=fixture();
  try {
    const record=f.store.get('agent');record.target='dsh';record.workspace=f.dir;f.store.save(record);
    let stageCalls=0,finalCalls=0,childToken;
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async()=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:['session'],activityVersion:'v',history:[],questions:[],reports:[]}),
      removeManaged:async(r,s,e,c)=>{stageCalls++;childToken=c.operationToken;assert.match(childToken,/^[a-f0-9-]{36}$/);return {removed:false,staged:true,ticket:childToken,eligibleAt:'2099-01-01T00:00:00Z'};},
      finalizeManaged:async(r,s,e,c)=>{finalCalls++;assert.equal(c.operationToken,childToken);return {removed:true,ticket:childToken};}};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100},{dsh});
    const item=(await engine.inventory()).items[0];
    const staged=await engine.remove(item,{mode:'rules',operationToken:'op',revalidate:async()=>true});
    assert.equal(staged.staged,true,JSON.stringify(staged));assert.equal(f.store.get('agent').closed,true);
    assert.ok(staged.steps.some(row=>row.step==='native-staged'));assert.equal(staged.steps.some(row=>row.step==='native-complete'),false);
    assert.equal((await engine.resume('op',{mode:'rules',revalidate:async()=>true})).removed,true);
    assert.equal(stageCalls,1);assert.equal(finalCalls,1);assert.equal(f.store.get('agent'),undefined);
  } finally {f.close();}
});

test('recent native activity delays cleanup even when roster timestamps are old',async()=>{
  const now=Date.now(); const f=fixture({retention:100000,cleanupNow:()=>now});
  try {
    const desktop={inspect:async()=>({running:false,treeIds:['session'],activityVersion:'native',historyPresent:true,lastActivityAt:new Date(now-1000).toISOString()}),ownerStatus:async()=>({state:'unknown'})};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100000,cleanupNow:()=>now},{desktop});
    const item=(await engine.inventory()).items[0];assert.equal(item.firstEligible,true);assert.equal(item.eligible,false);
    assert.equal(Date.parse(item.lastActivityAt),now-1000);
  } finally {f.close();}
});

test('two disjoint managed DSH members use stable different native tickets',async()=>{
  const f=fixture();
  try {
    const root=f.store.get('agent');root.target='dsh';root.workspace=f.dir;f.store.save(root);
    f.store.insert({agentId:'child',ownerId:'owner',name:'child',parentAgentId:'agent',sessionId:'child-session',target:'dsh',workspace:f.dir,state:'idle',lifetime:'persistent'});
    const calls=[];
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async(r)=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:[r.sessionId],activityVersion:`v-${r.sessionId}`,history:[],questions:[],reports:[]}),
      removeManaged:async(r,s,e,c)=>{calls.push({id:r.agentId,token:c.operationToken});return {removed:true,ticket:c.operationToken};}};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100},{dsh});const item=(await engine.inventory()).items[0];
    assert.equal(item.eligible,true,JSON.stringify(item));const out=await engine.remove(item,{mode:'rules',operationToken:'parent-token',revalidate:async()=>true});
    assert.equal(out.removed,true,JSON.stringify(out));assert.equal(calls.length,2);assert.notEqual(calls[0].token,calls[1].token);
    assert.ok(calls.every(call=>/^[a-f0-9-]{36}$/.test(call.token)));
  } finally {f.close();}
});

test('overlapping contained DSH trees delete only the covering tree',async()=>{
  const f=fixture();
  try {
    const root=f.store.get('agent');root.target='dsh';root.workspace=f.dir;f.store.save(root);
    f.store.insert({agentId:'child',ownerId:'owner',name:'child',parentAgentId:'agent',sessionId:'child-session',target:'dsh',workspace:f.dir,state:'idle',lifetime:'persistent'});
    const calls=[];
    const dsh={supportsManagedSidecarCoverage:true,inventory:async()=>({complete:false,items:[]}),inspectManaged:async(r)=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:r.agentId==='agent'?['session','child-session']:['child-session'],activityVersion:`v-${r.sessionId}`,history:[],questions:[],reports:[]}),
      removeManaged:async(r)=>{calls.push(r.agentId);return {removed:true,managedAgentsRemoved:['agent','child']};}};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100},{dsh});const item=(await engine.inventory()).items[0];
    assert.equal(item.eligible,true,JSON.stringify(item));const out=await engine.remove(item,{mode:'rules',operationToken:'parent-token',revalidate:async()=>true});
    assert.equal(out.removed,true,JSON.stringify(out));assert.deepEqual(calls,['agent']);
  } finally {f.close();}
});

test('partially overlapping native trees are held as ambiguous',async()=>{
  const f=fixture();
  try {
    const root=f.store.get('agent');root.target='dsh';root.workspace=f.dir;f.store.save(root);
    f.store.insert({agentId:'child',ownerId:'owner',name:'child',parentAgentId:'agent',sessionId:'child-session',target:'dsh',workspace:f.dir,state:'idle',lifetime:'persistent'});
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async(r)=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:[r.sessionId,'shared'],activityVersion:'v',history:[],questions:[],reports:[]}),removeManaged:async()=>{throw new Error('must not delete');}};
    const engine=createRosterCleanup({stateDirectory:f.dir},{dsh});const item=(await engine.inventory()).items[0];assert.equal(item.firstEligible,false);
  } finally {f.close();}
});

test('DSH pending question is archived and disposition bound before host cleanup',async()=>{
  const proof=deletedProof;
  const f=fixture({lifetime:'persistent',state:'idle',task:{taskId:'round',finishedAt:'2020-01-01T00:00:00Z'},ownerStatus:async()=>proof});
  try {
    const record=f.store.get('agent');record.target='dsh';record.workspace=f.dir;f.store.save(record);
    const question={id:'q1',state:'pending',message:'原生问题\n中文',createdAt:'2020-01-01T00:00:00Z'};
    let gotDisposition;
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async()=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:true,lastActivityAt:Date.parse('2020-01-01T00:00:00Z'),treeIds:['session'],activityVersion:'v',history:[{sourceId:'s:1',sessionId:'session',event:{type:'ask',data:question}}],questions:[question],reports:[]}),
      removeManaged:async(r,s,e,context)=>{gotDisposition=context.disposition;return {removed:true};}};
    const desktop={ownerStatus:async()=>proof};const engine=createRosterCleanup({stateDirectory:f.dir},{dsh,desktop});
    const item=(await engine.inventory()).items[0];assert.equal(item.eligible,true,JSON.stringify(item));
    const out=await engine.remove(item,{mode:'rules',operationToken:'parent',revalidate:async()=>true});assert.equal(out.removed,true,JSON.stringify(out));
    assert.equal(gotDisposition.ticketId,'parent');assert.equal(gotDisposition.ownerProof.receiptId,'deletion-receipt');
    assert.equal(gotDisposition.questionReceipts.length,1);const receipt=gotDisposition.questionReceipts[0];
    assert.equal(receipt.id,'q1');assert.equal(receipt.sessionId,'session');assert.equal(receipt.messageHash,createHash('sha256').update(question.message,'utf8').digest('hex'));
    assert.ok((await engine.archives({originalId:'q1'})).some(row=>row.archive_key===receipt.archiveKey && row.sha256===receipt.archiveSha256));
  } finally {f.close();}
});

test('DSH pending question is retained if deleted-owner proof is incomplete',async()=>{
  const f=fixture({lifetime:'persistent',state:'idle',task:{taskId:'round',finishedAt:'2020-01-01T00:00:00Z'}});
  try {
    const record=f.store.get('agent');record.target='dsh';record.workspace=f.dir;f.store.save(record);
    let invoked=false;
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async()=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:['session'],activityVersion:'v',history:[],questions:[{id:'q',message:'untouched',state:'pending'}],reports:[]}),removeManaged:async()=>{invoked=true;return {removed:true};}};
    const engine=createRosterCleanup({stateDirectory:f.dir},{dsh,desktop:{ownerStatus:async()=>({state:'deleted'})}});
    const out=await engine.remove((await engine.inventory()).items[0],{mode:'rules',operationToken:'parent',revalidate:async()=>true});
    assert.equal(out.removed,false);assert.equal(invoked,false);assert.ok(f.store.get('agent'));
  } finally {f.close();}
});

test('two managed members resume staged operations on their own stable tokens',async()=>{
  const f=fixture();
  try {
    const root=f.store.get('agent');root.target='dsh';root.workspace=f.dir;f.store.save(root);
    f.store.insert({agentId:'child',ownerId:'owner',name:'child',parentAgentId:'agent',sessionId:'child-session',target:'dsh',workspace:f.dir,state:'idle',lifetime:'persistent'});
    const staged=new Map(),finalized=new Map();
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async(r)=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:[r.sessionId],activityVersion:`v-${r.sessionId}`,history:[],questions:[],reports:[]}),
      removeManaged:async(r,s,e,c)=>{staged.set(r.agentId,c.operationToken);return {removed:false,staged:true,ticket:c.operationToken};},
      finalizeManaged:async(r,s,e,c)=>{assert.equal(c.operationToken,staged.get(r.agentId));finalized.set(r.agentId,c.operationToken);return {removed:true,ticket:c.operationToken};}};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100},{dsh});
    const result=await engine.remove((await engine.inventory()).items[0],{mode:'rules',operationToken:'roster-parent',revalidate:async()=>true});assert.equal(result.staged,true);
    const next=await engine.resume('roster-parent',{mode:'rules',revalidate:async()=>true});assert.equal(next.staged,true,JSON.stringify(next));
    const last=await engine.resume('roster-parent',{mode:'rules',revalidate:async()=>true});assert.equal(last.removed,true,JSON.stringify(last));
    assert.equal(staged.size,2);assert.equal(finalized.size,2);assert.notEqual(staged.get('agent'),staged.get('child'));
  } finally {f.close();}
});

test('cross-round sealed sole report is archived exactly once before record removal',async()=>{
  const f=fixture({lifetime:'persistent',state:'idle',task:{taskId:'new-round',state:'completed',finishedAt:'2020-01-03T00:00:00Z',reports:[]}});
  const original='上一轮唯一正文\n中文与附件 id: a-123';
  try {
    f.store.appendHistory('agent',{taskId:'old-round',finishedAt:'2020-01-01T00:00:00Z',reports:[{id:'old-only',message:original,final:false,createdAt:'2020-01-01T00:00:00Z',delivery:{state:'blocked',blockedAt:'2020-01-01T00:00:01Z'}}]});
    assert.equal(f.store.historyFor('agent')[0].reports[0].message,original);
    const candidate=(await f.engine.inventory()).items[0];assert.equal(candidate.eligible,true,JSON.stringify(candidate));
    assert.equal((await f.engine.remove(candidate,{mode:'rules',revalidate:async()=>false})).removed,false);
    assert.equal(f.store.historyFor('agent')[0].reports[0].message,original);
    assert.equal((await f.engine.archives({originalId:'old-only'})).length,0);
    const result=await f.engine.remove(candidate,{mode:'rules',revalidate:async()=>true});assert.equal(result.removed,true,JSON.stringify(result));
    assert.equal(f.store.get('agent'),undefined);assert.equal(f.store.historyFor('agent').length,0);
    const archived=await f.engine.archives({originalId:'old-only'});assert.equal(archived.length,1);assert.equal(archived[0].payload.message,original);
  } finally {f.close();}
});

test('R04 persistent idle waits through 12h minus one millisecond and becomes eligible at boundary',async()=>{
  const base=Date.parse('2020-01-01T00:00:00Z'), duration=12*60*60*1000;let now=base+duration-1;
  const f=fixture({lifetime:'persistent',state:'idle',retention:duration,cleanupNow:()=>now,
    task:{taskId:'round',state:'completed',finishedAt:'2020-01-01T00:00:00Z',reports:[]}});
  try {
    const before=(await f.engine.inventory()).items[0];assert.equal(before.firstEligible,true);assert.equal(before.eligible,false);
    now++;const due=(await f.engine.inventory()).items[0];assert.equal(due.eligible,true);
    const result=await f.engine.remove(due,{mode:'rules',revalidate:async()=>true});assert.equal(result.removed,true,JSON.stringify(result));
  } finally {f.close();}
});

test('release bytes count confirmed Claude private data once, never the retained archive',async()=>{
  const f=fixture();
  try {
    const result=await f.engine.remove((await f.engine.inventory()).items[0],{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result));assert.equal(result.bytes,7);assert.equal(result.totalKnownBytes,7);
    assert.ok((await f.engine.archives({originalId:'final'})).length);
    const repeat=await f.engine.resume(result.ticketId,{mode:'rules',revalidate:async()=>true});
    assert.equal(repeat.bytes,0);assert.equal(repeat.totalKnownBytes,7);
  }finally{f.close();}
});

test('partial two-member cleanup reports each finalized native receipt only once',async()=>{
  const f=fixture();
  try {
    const root=f.store.get('agent');root.target='dsh';root.workspace=f.dir;f.store.save(root);
    f.store.insert({agentId:'child',ownerId:'owner',name:'child',parentAgentId:'agent',sessionId:'child-session',target:'dsh',workspace:f.dir,state:'idle',lifetime:'persistent'});
    const calls=new Map();
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async(r)=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:[r.sessionId],activityVersion:`v-${r.sessionId}`,history:[],questions:[],reports:[]}),
      removeManaged:async(r,s,e,c)=>{calls.set(r.agentId,c.operationToken);return r.agentId==='child'?{removed:true,bytes:100}:{removed:false,staged:true,ticket:c.operationToken,bytes:0};},
      finalizeManaged:async()=>({removed:true,bytes:200})};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100},{dsh});
    const first=await engine.remove((await engine.inventory()).items[0],{mode:'rules',operationToken:'parent-bytes',revalidate:async()=>true});
    assert.equal(first.staged,true,JSON.stringify(first));assert.equal(first.bytes,100);
    const second=await engine.resume('parent-bytes',{mode:'rules',revalidate:async()=>true});
    assert.equal(second.removed,true,JSON.stringify(second));assert.equal(second.bytes,207);assert.equal(second.totalKnownBytes,307);
    assert.equal((await engine.resume('parent-bytes',{mode:'rules',revalidate:async()=>true})).bytes,0);
  }finally{f.close();}
});

test('lost native receipt reports unknown size while preserving known private bytes',async()=>{
  const f=fixture();
  try {
    const root=f.store.get('agent');root.target='dsh';root.workspace=f.dir;f.store.save(root);
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async(r)=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:[r.sessionId],activityVersion:'v',history:[],questions:[],reports:[]}),
      removeManaged:async()=>({removed:true,alreadyRemoved:true,bytes:0})};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100},{dsh});
    const result=await engine.remove((await engine.inventory()).items[0],{mode:'rules',operationToken:'unknown-bytes',revalidate:async()=>true});
    assert.equal(result.removed,true);assert.equal(result.bytes,null);assert.equal(result.knownBytes,7);assert.equal(result.bytesUnknown,true);
    const repeat=await engine.resume('unknown-bytes',{mode:'rules',revalidate:async()=>true});
    assert.equal(repeat.bytes,0);assert.equal(repeat.totalKnownBytes,7);assert.equal(repeat.bytesUnknown,true);
  }finally{f.close();}
});

test('changed private content is preserved and partial native release is reported',async()=>{
  const f=fixture();
  try {
    const root=f.store.get('agent');root.target='dsh';root.workspace=f.dir;f.store.save(root);
    const dsh={inventory:async()=>({complete:false,items:[]}),inspectManaged:async(r)=>({running:false,ownership:'managed',complete:true,historyComplete:true,historyPresent:false,treeIds:[r.sessionId],activityVersion:'v',history:[],questions:[],reports:[]}),
      removeManaged:async()=>{writeFileSync(path.join(f.privatePath,'private'),'new input after snapshot');return {removed:true,bytes:80};}};
    const engine=createRosterCleanup({stateDirectory:f.dir,onceTerminalRetentionMs:100},{dsh});
    const result=await engine.remove((await engine.inventory()).items[0],{mode:'rules',operationToken:'changed-private',revalidate:async()=>true});
    assert.equal(result.removed,false);assert.equal(result.reason,'private-content-changed');assert.equal(result.knownBytes,80);
    assert.equal(result.bytesUnknown,true);assert.equal(existsSync(path.join(f.privatePath,'private')),true);
    const repeat=await engine.resume('changed-private',{mode:'rules',revalidate:async()=>true});
    assert.equal(repeat.knownBytes,0);assert.equal(repeat.totalKnownBytes,80);
  }finally{f.close();}
});
