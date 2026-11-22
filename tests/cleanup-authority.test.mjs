import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createCleanupService } from '../src/cleanup-service.mjs';
import { offlineVacuum } from '../src/cleanup-vacuum.mjs';

async function fixture(t,sharedRoot) {
  const dir=await mkdtemp(path.join(os.tmpdir(),'fa-cleanup-authority-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const config={configFile:path.join(dir,'config.json'),dshDataRoot:sharedRoot??path.join(dir,'data'),stateDirectory:path.join(dir,'state'),
    agentAutoCleanup:true,agentIdleRetentionMs:5000,onceTerminalRetentionMs:10000,diagnosticRetentionMs:10000};
  await Promise.all([mkdir(config.stateDirectory),mkdir(config.dshDataRoot,{recursive:true}),writeFile(config.configFile,'{}')]);
  const objects=new Map(), removed=[];
  function put(id,fields={}) {
    const item={id,root:config.dshDataRoot,kind:'native',running:false,eligible:true,firstEligible:true,activityVersion:id,treeIds:[id],...fields};
    objects.set(id,item);return item;
  }
  const backend={inventory:async()=>({complete:true,items:[...objects.values()]}),inspect:async i=>objects.get(i.id),
    remove:async(i,ctx)=>{assert.equal(await ctx.revalidate(),true);assert.equal(ctx.canDelete(),true);removed.push(i.id);objects.delete(i.id);return {removed:true};}};
  const service=createCleanupService(config,{dsh:backend,roster:backend});
  return {service,dir,config,put,removed,objects};
}
test('D08 activation membership, retained categories, new identities, first batch, revocation and hot disable',async t=>{
  const f=await fixture(t);
  f.put('keep');f.put('first',{kind:'old',eligible:false,observationMs:86400000});f.put('active',{kind:'busy',running:true});
  let snap=await f.service.preview(['dsh']);
  assert.deepEqual(await readdir(f.config.stateDirectory),[]);
  const approve=s=>f.service.approve(s,{snapshot:s.hash,remaining:'B',first:[s.items.find(i=>i.id==='first').key],keepKinds:['native']});
  await approve(snap);
  f.put('appeared-before-enable',{kind:'busy',running:true});
  await assert.rejects(f.service.switchEnabled(true),/inventory changed/i);
  snap=await f.service.preview(['dsh']);
  const {approval}=await approve(snap);
  await f.service.switchEnabled(true);
  await f.service.execute('first',{snapshot:snap,review:approval});
  assert.deepEqual(f.removed,['first']);
  f.put('new-same-kind');
  await f.service.execute('rules');
  assert.deepEqual(f.removed,['first','new-same-kind']);
  await f.service.switchEnabled(false);
  await f.service.revoke([snap.items.find(i=>i.id==='keep').key]);
  await f.service.execute('rules');
  assert.equal(f.objects.has('keep'),true);
  await f.service.switchEnabled(true);
  await f.service.execute('rules');
  assert.equal(f.objects.has('keep'),false);
});
test('overlapping C selections retain a shared child until each selection is revoked', async t => {
  const f = await fixture(t);
  f.put('a',{treeIds:['a','child']}); f.put('b',{treeIds:['b','child']}); f.put('child');
  const snap = await f.service.preview(['dsh']);
  const selected = snap.items.filter(i=>i.id!=='child').map(i=>i.key);
  await f.service.approve(snap,{snapshot:snap.hash,remaining:'B',keep:selected});
  await f.service.switchEnabled(true);
  await f.service.execute('rules');
  assert.deepEqual(f.removed,[]);
  await f.service.revoke([selected[0]]);
  await f.service.execute('rules');
  assert.deepEqual(f.removed,[]);
  await f.service.revoke([selected[1]]);
  await f.service.execute('rules');
  assert.ok(f.removed.includes('child'));
});
test('D10 turning off during a native write records that reply and prevents the next submission',async t=>{
  const f=await fixture(t);
  f.put('one');f.put('two');
  const backend={
    inventory:async()=>({items:[...f.objects.values()],complete:true}),
    inspect:async i=>f.objects.get(i.id),
    remove:async(i,ctx)=>{
      assert.equal(await ctx.revalidate(),true);
      f.removed.push(i.id);await service.switchEnabled(false);
      assert.equal(ctx.canDelete(),false);return {removed:true};
    },
  };
  const service=createCleanupService(f.config,{dsh:backend});
  const snap=await service.preview(['dsh']);
  const {approval}=await service.approve(snap,{snapshot:snap.hash,remaining:'B',first:snap.items.map(i=>i.key)});
  await service.switchEnabled(true);
  const batch=await service.execute('first',{snapshot:snap,review:approval});
  assert.deepEqual(f.removed,['one']);
  assert.equal(batch.items.length,2);
  assert.equal(batch.items[1].removed,false);
});
test('D11 different config directories sharing a physical root cannot take the original authorization',async t=>{
  const a=await fixture(t); a.put('protected');
  const snap=await a.service.preview(['dsh']);
  await a.service.approve(snap,{snapshot:snap.hash,remaining:'B',keepKinds:['native']});
  await a.service.switchEnabled(true);
  await a.service.switchEnabled(false);
  const b=await fixture(t,a.config.dshDataRoot);b.put('protected');
  const second=await b.service.preview(['dsh']);
  await assert.rejects(b.service.approve(second,{snapshot:second.hash,remaining:'B'}),/different root, configuration or profile/i);
  const ledger=path.join(a.config.dshDataRoot,'.futureaide-control','cleanup-authority.sqlite');
  await rename(ledger,ledger+'.isolated');
  await assert.rejects(b.service.execute('rules'),/ENOENT/);
  await assert.rejects(b.service.approve(second,{snapshot:second.hash,remaining:'B'}),/reserved cleanup authority is missing/i);
  assert.deepEqual((await readdir(path.dirname(ledger))).sort(),['cleanup-authority.sqlite.identity','cleanup-authority.sqlite.isolated']);
  await rename(ledger+'.isolated',ledger);
  await a.service.switchEnabled(true); await a.service.execute('rules');
  assert.deepEqual(a.removed,[]);
});
for(const excess of [false,true])test('D10 offline opt-in measured benefit '+(excess?'passes':'below')+' threshold',async t=>{
  const f=await fixture(t),dbFile=path.join(f.config.stateDirectory,'roster.sqlite');
  const db=new DatabaseSync(dbFile);
  db.exec('CREATE TABLE records(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO records VALUES(1,\'last message\');');
  if(excess) db.exec('INSERT INTO records VALUES(2,zeroblob(1048576)); DELETE FROM records WHERE id=2');
  db.close();
  const snap=await f.service.preview(['roster']);
  const decisions={snapshot:snap.hash,remaining:'B',vacuum:{selected:true,database:dbFile,minimumBytes:32768,maxPauseMs:10000,measuredVacuumMs:20}};
  const {approval}=await f.service.approve(snap,decisions);
  const backup=path.join(f.dir,'backup.sqlite');
  const result=await offlineVacuum(f.config,decisions,approval,backup);
  t.diagnostic(JSON.stringify({applied:result.applied,minimumBytes:result.minimumBytes,before:result.before,after:result.after,
    actualBytes:result.actualBytes,estimated:result.estimated,walBefore:result.walBefore,walAfter:result.walAfter}));
  assert.equal(result.applied,excess);assert.equal(result.actualBytes,result.before-result.after);
  assert.equal(result.actualBytes>=32768,excess);
  if(excess) {
    const writer=new DatabaseSync(dbFile);
    writer.exec('INSERT INTO records VALUES(2,zeroblob(1048576)); DELETE FROM records WHERE id=2'); writer.close();
    const retry=await offlineVacuum(f.config,decisions,approval,path.join(f.dir,'second-backup.sqlite'));
    assert.equal(retry.reason,'already-submitted'); assert.equal(retry.actualBytes,0);
  }
  for(const filename of [backup,dbFile]) {const reader=new DatabaseSync(filename,{readOnly:true});try{assert.equal(reader.prepare('SELECT body FROM records').get().body,'last message');}finally{reader.close();}}
});
