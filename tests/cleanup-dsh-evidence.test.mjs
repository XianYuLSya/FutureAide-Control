import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';import {createHash} from 'node:crypto';import os from 'node:os';import path from 'node:path';
import {collectDshEvidence,classifyDshInventory} from '../src/cleanup-dsh-evidence.mjs';
const item=(id,workspace,treeIds=[id])=>({id,sessionId:id,kind:'dsh-session',root:'root',bytes:100,running:false,activityVersion:'v1',treeIds,row:{header:{id,cwd:workspace}},nodes:treeIds.map(sessionId=>({sessionId,bytes:100/treeIds.length}))});
test('same-prefix managed registry, roster, ordinary and unverified sidecar remain distinct',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-evidence-'));
 try{
  const home=path.join(dir,'dsh'),work=path.join(dir,'work'),state=path.join(dir,'state'),registry=path.join(dir,'agents'),managed=path.join(dir,'managed-host');
  await Promise.all([home,work,state,registry,managed].map(x=>mkdir(x,{recursive:true})));
  const configFile=path.join(dir,'config.json'),config={configFile,dshDataRoot:home,registryDirectory:registry,managedStateDirectory:managed};
  await writeFile(configFile,JSON.stringify({dshDataRoot:home,workspace:work,managedStateDirectory:managed}));
  const db=new DatabaseSync(path.join(state,'roster.sqlite'));db.exec('CREATE TABLE agents(body TEXT)');db.prepare('INSERT INTO agents VALUES (?)').run(JSON.stringify({target:'dsh',sessionId:'session-codex-roster',ownerId:'owner-a',agentId:'agent-a',workspace:work}));db.close();
  const legacyId='agent-'+ 'a'.repeat(32);await mkdir(path.join(registry,legacyId));await writeFile(path.join(registry,legacyId,'agent.json'),JSON.stringify({agentId:legacyId,sessionId:'session-codex-legacy',workspace:work,transport:{dataRoot:home}}));
  const sidecar={ownerId:'owner-b',agentId:'agent-b',sessionId:'session-codex-sidecar',workspace:work};const key=createHash('sha256').update(`${sidecar.ownerId}\n${sidecar.agentId}`).digest('hex');await writeFile(path.join(managed,key+'.json'),JSON.stringify(sidecar));
  const evidence=await collectDshEvidence(config);assert.equal(evidence.complete,true);assert.equal(evidence.roster.length,1);assert.equal(evidence.legacy.length,1);
  const direct='session-11111111-1111-4111-8111-111111111111', unknown='session-codex-ordinary';
  const native={complete:true,items:['session-codex-roster','session-codex-legacy','session-codex-sidecar',unknown,direct].map(id=>item(id,work))};
  const report=classifyDshInventory(native,evidence,config);const by=new Map(report.items.map(row=>[row.id,row]));
  assert.equal(by.get('session-codex-roster').ownership,'managed');assert.equal(by.get('session-codex-roster').bytes,0);assert.equal(by.get('session-codex-roster').nativeBytes,100);
  assert.equal(by.get('session-codex-legacy').ownership,'managed');assert.equal(by.get('session-codex-sidecar').ownership,'unknown');assert.equal(by.get(unknown).ownership,'unknown');assert.equal(by.get(direct).ownership,'direct');
  assert.equal(by.get('shared-attachments').bytes,0);assert.equal(report.complete,true);
 }finally{await rm(dir,{recursive:true,force:true})}
});
test('incomplete evidence and a managed descendant do not authorize an ordinary tree',()=>{
 const root='session-11111111-1111-4111-8111-111111111111',child='session-codex-child',work=path.resolve('fixture');
 const input={items:[item(root,work,[root,child]),item(child,work)],complete:true};
 const evidence={complete:true,errors:[],roster:[{sessionId:child,agentId:'x'}],legacy:[],sidecars:[],attachments:null};
 const result=classifyDshInventory(input,evidence,{dshDataRoot:work});
 assert.equal(result.items.find(x=>x.id===root).ownership,'unknown');assert.equal(result.items.find(x=>x.id===root).eligible,false);assert.equal(result.items.find(x=>x.id===child).ownership,'managed');
 const unknown=classifyDshInventory({items:[item(root,work)],complete:true},{...evidence,complete:false,roster:[]},{dshDataRoot:work});assert.equal(unknown.items[0].ownership,'unknown');
});


test('old deleted ticket without original child evidence keeps the child unverified',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-orphan-proof-'));
 try{
  const home=path.join(dir,'dsh'),work=path.join(dir,'work'),managed=path.join(dir,'managed-host'),configFile=path.join(dir,'config.json');
  await Promise.all([home,work,managed].map(x=>mkdir(x,{recursive:true})));
  await writeFile(configFile,JSON.stringify({dshDataRoot:home,workspace:work,managedStateDirectory:managed}));
  const root='session-codex-root',child='session-child',ticket='11111111-1111-4111-8111-111111111111',sidecar={ownerId:'owner-a',agentId:'agent-a',sessionId:root,workspace:work};
  const key=createHash('sha256').update(`${sidecar.ownerId}\n${sidecar.agentId}`).digest('hex');await writeFile(path.join(managed,key+'.json'),JSON.stringify(sidecar));
  const tickets=path.join(home,'.futureaide-control','staging',ticket);await mkdir(tickets,{recursive:true});
  const manifest={version:1,ticket,sessionId:root,state:'deleted',source:path.join(home,'sessions','project',root),header:{cwd:work},managed:{ownerId:sidecar.ownerId,agentId:sidecar.agentId}};
  await writeFile(path.join(tickets,'ticket.json'),JSON.stringify(manifest));
  const config={configFile,dshDataRoot:home,managedStateDirectory:managed}, evidence=await collectDshEvidence(config);assert.equal(evidence.deletedRoots.length,1);
  const row=item(child,work);row.row.header.origin='subagent';row.row.header.parentSession=root;
  const report=classifyDshInventory({items:[row],complete:true},evidence,config);assert.equal(report.items.find(x=>x.id===child).ownership,'unknown');assert.equal(report.items.find(x=>x.id===child).eligible,false);
  const bad=classifyDshInventory({items:[row],complete:true},{...evidence,deletedRoots:[]},config);assert.equal(bad.items.find(x=>x.id===child).ownership,'unknown');
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('v2 native tree ticket enumerates nodes and rejects wrong staging identities',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'dsh-ticket-v2-'));try{
  const home=path.join(dir,'home'),work=path.join(dir,'work'),configFile=path.join(dir,'config.json');await mkdir(home,{recursive:true});await mkdir(work,{recursive:true});await writeFile(configFile,JSON.stringify({dshDataRoot:home,workspace:work}));
  const ticket='22222222-2222-4222-8222-222222222222',ticketDir=path.join(home,'.futureaide-control','staging',ticket);await mkdir(ticketDir,{recursive:true});
  const ids=['session-root','session-child'];const body={version:2,ticket,sessionId:ids[0],state:'deleted',nodes:ids.map(sessionId=>({sessionId,source:path.join(home,'sessions','project',sessionId),staged:path.join(ticketDir,sessionId)}))};
  await writeFile(path.join(ticketDir,'ticket.json'),JSON.stringify(body));const config={configFile,dshDataRoot:home};const good=await collectDshEvidence(config);
  assert.equal(good.complete,true);assert.deepEqual(good.deletedSessions.map(x=>x.sessionId),ids);
  body.nodes[1].staged=path.join(ticketDir,'other');await writeFile(path.join(ticketDir,'ticket.json'),JSON.stringify(body));const bad=await collectDshEvidence(config);
  assert.equal(bad.complete,false);assert.ok(bad.errors.some(x=>x.startsWith('ticket-source-unverified')));
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('real isolated DSH v2 restored ticket is accepted without making coverage incomplete',async t=>{
 const {access}=await import('node:fs/promises');const root=path.resolve('.runtime/verification/agent-auto-cleanup/dsh/tree5');const configFile=path.join(root,'evidence-config.json');
 try{await access(configFile)}catch{return t.skip('isolated real ticket sample unavailable')}
 const evidence=await collectDshEvidence({configFile,dshDataRoot:path.join(root,'home')});assert.equal(evidence.complete,true,JSON.stringify(evidence.errors));assert.equal(evidence.sessions.length,3);
});


test('direct native child requires an unbroken unmanaged parent chain',()=>{
 const work=path.resolve('work'),root='session-11111111-1111-4111-8111-111111111111',child='22222222-2222-4222-8222-222222222222';
 const parent=item(root,work,[root,child]),desc=item(child,work);desc.row.header.origin='subagent';desc.row.header.parentSession=root;
 const evidence={complete:true,errors:[],roster:[],legacy:[],sidecars:[],receipts:[],deletedRoots:[],orphanProofs:[],sessions:[],projections:[],attachments:0};
 const classified=classifyDshInventory({items:[parent,desc],complete:true},evidence,{dshDataRoot:work});
 assert.equal(classified.items.find(x=>x.id===child).ownership,'direct-subtree');
 const missing=classifyDshInventory({items:[desc],complete:true},evidence,{dshDataRoot:work});assert.equal(missing.items.find(x=>x.id===child).ownership,'unknown');
 const managed=classifyDshInventory({items:[parent,desc],complete:true},{...evidence,roster:[{sessionId:root,ownerId:'o',agentId:'a'}]},{dshDataRoot:work});
 assert.notEqual(managed.items.find(x=>x.id===child).ownership,'direct-subtree');
});
