import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,lstatSync,rmSync,existsSync} from 'node:fs';
import os from 'node:os';import path from 'node:path';
import {RosterStore} from '../src/roster-store.mjs';
import {readRosterTree,claimRosterTree,recordRosterStep,completeRosterTicket} from '../src/cleanup-roster-transaction.mjs';
import {createRosterCleanup} from '../src/cleanup-roster.mjs';
import {recoverRosterOperation} from '../src/cleanup-roster-recovery.mjs';

async function oldTicket() {
  const dir=mkdtempSync(path.join(os.tmpdir(),'old-roster-ticket-')),file=path.join(dir,'roster.sqlite');
  const store=new RosterStore(file);store.saveOwner({ownerId:'owner',workspace:dir});
  const record={agentId:'agent',ownerId:'owner',name:'n',sessionId:'s',target:'claude-cli',lifetime:'persistent',state:'idle'};
  store.insert(record);const privatePath=path.join(dir,'scoped','owner','agent');mkdirSync(privatePath,{recursive:true});
  const payload=path.join(privatePath,'payload');writeFileSync(payload,'1234567');
  await new Promise(resolve=>setTimeout(resolve,25));
  const stat=lstatSync(privatePath),identity={exists:true,dev:stat.dev,ino:stat.ino,ctimeMs:stat.ctimeMs};
  const tree=readRosterTree(file,'agent');claimRosterTree(file,{rootId:'agent',fingerprint:tree.fingerprint,ticketId:'old'});
  recordRosterStep(file,'old','agent','plan',{index:0,mode:'rules',record,privateIdentity:identity,native:{},backendState:{}});
  recordRosterStep(file,'old','agent','native-complete',{removed:true,nativeSessionRetained:true});
  return {dir,file,store,privatePath,payload,engine:createRosterCleanup({stateDirectory:dir}),close(){store.close();rmSync(dir,{recursive:true,force:true});}};
}

test('old ticket without measurement safely resumes and counts private bytes',async()=>{
  const f=await oldTicket();try{
    const result=await f.engine.resume('old',{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result));assert.equal(result.bytes,7);
    assert.equal((await f.engine.resume('old',{mode:'rules',revalidate:async()=>true})).bytes,0);
  }finally{f.close();}
});

test('old ticket cannot silently delete private data modified after claim',async()=>{
  const f=await oldTicket();try{
    await new Promise(resolve=>setTimeout(resolve,25));writeFileSync(f.payload,'new input');
    const result=await f.engine.resume('old',{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,false);assert.equal(result.reason,'private-legacy-content-changed');assert.equal(existsSync(f.payload),true);
  }finally{f.close();}
});

test('old ticket with an already missing private directory reports unknown',async()=>{
  const f=await oldTicket();try{
    rmSync(f.privatePath,{recursive:true});
    const result=await f.engine.resume('old',{mode:'rules',revalidate:async()=>true});
    assert.equal(result.removed,true,JSON.stringify(result));assert.equal(result.bytes,null);assert.equal(result.bytesUnknown,true);
    assert.equal((await f.engine.resume('old',{mode:'rules',revalidate:async()=>true})).bytes,0);
  }finally{f.close();}
});

test('completed ticket recovered before its first byte report never repeats that report',async()=>{
  const f=await oldTicket();try{
    recordRosterStep(f.file,'old','agent','private-complete',{removed:true,releasedBytes:7});
    completeRosterTicket(f.file,'old');
    const prior={key:JSON.stringify(['roster','managed-agent',f.dir,'agent']),mode:'rules',plan:JSON.stringify({ticketToken:'old'})};
    const first=await recoverRosterOperation(f.engine,prior,{revalidate:async()=>true});assert.equal(first.bytes,7);assert.equal(first.totalKnownBytes,7);
    const repeat=await recoverRosterOperation(f.engine,prior,{revalidate:async()=>true});assert.equal(repeat.bytes,0);assert.equal(repeat.totalKnownBytes,7);
  }finally{f.close();}
});
