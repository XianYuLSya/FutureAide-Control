import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDesktopCleanup } from '../src/cleanup-desktop.mjs';

const record = {target:'codex-desktop',workspace:'D:/fixture'};
const domain={version:1,home:'D:/fixture/home',dev:'1',ino:'1'};
const state = {binding:{sessionId:'root',owned:true,codexDomain:domain},tree:{nodes:[{sessionId:'root'}]},requests:{}};
function native({child=false,active=false,missing=false}={}) {
  return async (method,p) => {
    if (method === 'thread/read') { if(missing) throw new Error('thread not loaded'); return {thread:{id:p.threadId,cwd:'D:/fixture',status:{type:active?'active':'idle'},updatedAt:1}}; }
    if (method === 'thread/turns/list') return {data:[]};
    if (method === 'thread/list') return {data:child && p.parentThreadId==='root' && !p.archived ? [{id:'child'}] : []};
    throw new Error(`unexpected ${method}`);
  };
}
test('Codex validates tree, refuses deletion without atomic native guard',async()=>{
  const adapter=createDesktopCleanup({domainForThread:async()=>domain,nativeRequest:native()}); const result=await adapter.inspect(record,state);
  assert.equal(result.running,false); assert.deepEqual(result.treeIds,['root']);
  assert.equal((await adapter.remove(record,state,result)).reason,'cleanup-gate-unavailable');
});
test('Codex does not infer missing or newly discovered child as safe',async()=>{
  assert.equal((await createDesktopCleanup({domainForThread:async()=>domain,nativeRequest:native({missing:true})}).inspect(record,state)).running,null);
  assert.equal((await createDesktopCleanup({domainForThread:async()=>domain,nativeRequest:native({child:true})}).inspect(record,state)).running,null);
  assert.equal((await createDesktopCleanup({domainForThread:async()=>domain,nativeRequest:native({active:true})}).inspect(record,state)).running,true);
  assert.equal((await createDesktopCleanup({domainForThread:async()=>domain,nativeRequest:native()}).inspect(record,{requests:{x:{attempted:true,status:'unknown'}}})).running,null);
});
test('Claude retire checks worker and keeps native history',async()=>{
  const claude={target:'claude-cli',sessionId:'session',ownerId:'owner',agentId:'agent'};
  const s={requests:{req:{status:'accepted'}}};
  const adapter=createDesktopCleanup({stateDirectory:'D:/fixture',readClaudeTurn:async()=>({state:'ended',endedAt:'2026-01-01T00:00:00Z'})});
  const observation=await adapter.inspect(claude,s); assert.equal(observation.running,false);
  assert.deepEqual(await adapter.remove(claude,s,observation),{removed:true,nativeSessionRetained:true});
  assert.equal((await adapter.inspect(claude,{...s,active:'req'})).running,true);
  assert.equal((await adapter.ownerStatus({source:'codex-desktop'})).state,'unknown');
});


test('caller domain comes from native rollout and deletion absence remains unknown',async()=>{
  const {mkdir,writeFile,mkdtemp,rm}=await import('node:fs/promises');
  const os=await import('node:os'); const path=await import('node:path');
  const {resolveCallingContext}=await import('../src/calling-context.mjs');
  const base=await mkdtemp(path.join(os.tmpdir(),'futureaide-domain-'));
  try {
    const id='11111111-1111-4111-8111-111111111111',dir=path.join(base,'sessions','2026','01','01');
    await mkdir(dir,{recursive:true});const rollout=path.join(dir,`rollout-${id}.jsonl`);await writeFile(rollout,'fixture');
    const thread={id,cwd:base,path:rollout,status:{type:'idle'}};
    const owner=await resolveCallingContext({_meta:{threadId:id}},{callCodex:async()=>({via:'native-rpc',thread})});
    assert.ok(owner.codexDomain?.ino);
    let exists=true; const adapter=createDesktopCleanup({nativeRequest:async()=>{if(!exists)throw new Error('thread not loaded');return {thread}}});
    assert.equal((await adapter.ownerStatus(owner)).state,'present');
    exists=false;assert.equal((await adapter.ownerStatus(owner)).state,'unknown');
    exists=true;assert.equal((await adapter.ownerStatus({...owner,codexDomain:{...owner.codexDomain,ino:'different'}})).state,'unknown');
  } finally { await rm(base,{recursive:true,force:true}); }
});


test('desktop remove sends protected cleanup and preserves refusal reasons',async()=>{
  for (const status of ['deleted','inUse','unverified','notSent']) {
    let called=0,removed=false;
    const basic=native();
    const request=async(method,params,options)=>{
      if(method==='futureaide/cleanup/delete') {
        called++;assert.equal(options.canRelease(),true);assert.deepEqual(params.treeIds,['root']);
        if(status==='deleted')removed=true;
        return {status,...(status==='deleted'?{dispatched:true}:{reason:status})};
      }
      if(method==='thread/list' && !params.parentThreadId && removed)return {data:[]};
      return basic(method,params);
    };
    const adapter=createDesktopCleanup({nativeRequest:request,domainForThread:async()=>domain});
    const expected=await adapter.inspect(record,state);
    const result=await adapter.remove(record,state,expected,{canDelete:()=>true});
    assert.equal(called,1);assert.equal(result.removed,status==='deleted');
    if(status!=='deleted')assert.equal(result.reason,status);
  }
});

test('systemError is settled only with a fully read failed native turn',async()=>{
  const failed={id:'turn',status:'failed',completedAt:1795350000};let rows=[failed];
  const request=async(method,p)=>{
    if(method==='thread/read')return {thread:{id:p.threadId,cwd:'D:/fixture',status:{type:'systemError'},updatedAt:1}};
    if(method==='thread/turns/list')return {data:rows};if(method==='thread/list')return {data:[]};throw Error('unexpected');
  };
  const adapter=createDesktopCleanup({nativeRequest:request,domainForThread:async()=>domain});
  assert.equal((await adapter.inspect(record,state)).running,false);
  rows=[];assert.equal((await adapter.inspect(record,state)).running,null);
  rows=[{id:'other',status:'inProgress'}];assert.equal((await adapter.inspect(record,state)).running,true);
});
