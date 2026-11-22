import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';import path from 'node:path';import os from 'node:os';import {createHash} from 'node:crypto';
import {createDshResidualCleanup} from '../src/cleanup-dsh-residual.mjs';import {readRosterArchives} from '../src/cleanup-roster-transaction.mjs';
test('unreferenced sidecar is archived byte for byte before its private file is retired',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'residual-local-'));try{
  const home=path.join(root,'dsh'),managed=path.join(root,'managed-host'),stateDirectory=path.join(root,'state'),workspace=path.join(root,'work');
  await Promise.all([home,managed,stateDirectory,workspace].map(x=>mkdir(x,{recursive:true})));
  const configFile=path.join(root,'config.json');await writeFile(configFile,JSON.stringify({dshDataRoot:home,workspace,managedStateDirectory:managed}));
  const record={ownerId:'owner-a',agentId:'agent-a',sessionId:'session-managed',workspace,
    reports:[{id:'report-one',message:'唯一正文\n中文'}],questions:[{id:'question-one',message:'原问题'}]};
  const key=createHash('sha256').update(`${record.ownerId}\n${record.agentId}`).digest('hex'),file=path.join(managed,key+'.json'),raw=JSON.stringify(record,null,2);await writeFile(file,raw);
  const config={configFile,dshDataRoot:home,managedStateDirectory:managed,stateDirectory};let busy=true;
  const client={cleanupResidualInspect:async()=>busy?{running:true,reason:'live'}:{running:false,activityVersion:'host-v1'}};
  const adapter=createDshResidualCleanup(config,{client});const item={id:'managed-host:'+key+'.json',kind:'managed-host-residual',root:home,sessionId:record.sessionId,treeIds:[]};
  assert.equal((await adapter.inspect(item)).running,true);busy=false;const fresh=await adapter.inspect(item);assert.equal(fresh.running,false);
  assert.equal((await adapter.remove(fresh,{revalidate:()=>false})).removed,false);assert.equal(await readFile(file,'utf8'),raw);
  const result=await adapter.remove(fresh,{revalidate:()=>true});assert.equal(result.removed,true);
  await assert.rejects(readFile(file));const saved=readRosterArchives(path.join(stateDirectory,'roster.sqlite'),{originalId:record.sessionId});assert.equal(saved[0].payload.rawUtf8,raw);
  for(const entry of [...record.questions,...record.reports]) {
    const matches=readRosterArchives(path.join(stateDirectory,'roster.sqlite'),{originalId:entry.id});
    assert.deepEqual(matches.map(r=>r.payload.message),[entry.message]);
  }
  record.reports[0].message+='不同正文';await writeFile(file,JSON.stringify(record));
  const conflict=await adapter.remove(await adapter.inspect(item),{revalidate:()=>true});
  assert.equal(conflict.reason,'residual-archive-conflict');
  assert.equal(JSON.parse(await readFile(file,'utf8')).reports[0].message,record.reports[0].message);
  const invalid=Buffer.from(JSON.stringify({...record,notes:'fixture-invalid-byte'}));
  invalid[invalid.indexOf('fixture-invalid-byte')]=255;await writeFile(file,invalid);
  const damaged=await adapter.remove(await adapter.inspect(item),{revalidate:()=>true});
  assert.equal(damaged.reason,'sidecar-encoding-unverified');
  assert.deepEqual(await readFile(file),invalid);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('projection only reports success after host verifies deletion',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'projection-local-'));try{
  const home=path.join(root,'dsh'),proj=path.join(home,'storages','session_projcache','sessions'),workspace=path.join(root,'work'),stateDirectory=path.join(root,'state');await Promise.all([proj,workspace,stateDirectory].map(x=>mkdir(x,{recursive:true})));
  const configFile=path.join(root,'config.json');await writeFile(configFile,JSON.stringify({dshDataRoot:home,workspace}));const id='session-proj';await writeFile(path.join(proj,id+'.json'),'{}');
  let returned=false;const client={cleanupResidualInspect:async()=>({running:false,activityVersion:'host-v1'}),cleanupResidualRemove:async()=>({removed:returned,reason:'post-read-failed'})};
  const adapter=createDshResidualCleanup({configFile,dshDataRoot:home,stateDirectory},{client});const item={id:'projection:'+id,kind:'dsh-projection-residual',root:home,sessionId:id,treeIds:[]};const fresh=await adapter.inspect(item);
  assert.equal((await adapter.remove(fresh,{revalidate:()=>true})).removed,false);returned=true;assert.equal((await adapter.remove(fresh,{revalidate:()=>true})).removed,true);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('projection referenced by staged tree ticket is protected before host RPC',async()=>{
 let called=false;const id='session-staged';
 const readEvidence=async()=>({complete:true,stagedSessions:[{sessionId:id,ticket:'ticket',state:'staged'}],sessions:[],roster:[],legacy:[],projections:[],sidecars:[]});
 const adapter=createDshResidualCleanup({dshDataRoot:'fixture'},{readEvidence,client:{cleanupResidualInspect:async()=>{called=true}}});
 const result=await adapter.inspect({id:'projection:'+id,kind:'dsh-projection-residual',sessionId:id});
 assert.equal(result.running,true);assert.equal(result.reason,'session-in-staging-ticket');assert.equal(called,false);
});

test('one inventory snapshot is reused for each residual and commit rereads evidence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'residual-batch-'));try{
  const home=path.join(root,'dsh'),proj=path.join(home,'storages','session_projcache','sessions'),stateDirectory=path.join(root,'state');await mkdir(proj,{recursive:true});await mkdir(stateDirectory);
  const ids=['session-a','session-b'];for(const id of ids)await writeFile(path.join(proj,id+'.json'),'{}');
  let scans=0;const snapshot={complete:true,stagedSessions:[],sessions:[],roster:[],legacy:[],sidecars:[],projections:ids.map(id=>({sessionId:id,path:path.join(proj,id+'.json')}))};
  const adapter=createDshResidualCleanup({dshDataRoot:home,stateDirectory},{readEvidence:async()=>{scans++;return snapshot},client:{cleanupResidualInspect:async()=>({running:false,activityVersion:'host-v1'}),cleanupResidualRemove:async()=>({removed:true})}});
  const items=await Promise.all(ids.map(sessionId=>adapter.inspect({id:'projection:'+sessionId,kind:'dsh-projection-residual',sessionId,root:home,treeIds:[]},snapshot)));
  assert.equal(scans,0);assert.ok(items.every(x=>x.running===false));
  assert.equal((await adapter.remove(items[0],{revalidate:()=>true})).removed,true);assert.equal(scans,2);
 }finally{await rm(root,{recursive:true,force:true})}
});
