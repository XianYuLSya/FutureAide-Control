import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createDshTempHost} from '../src/host-plugin.mjs';
test('read-only usage needs a live-recorded real tool locator, stopped producer, and empty root',async()=>{
 const base=await mkdtemp(path.join(os.tmpdir(),'dsh-temp-host-'));try{
  const home=path.join(base,'home'),temp=path.join(base,'temp'),sessions=path.join(home,'sessions');await mkdir(sessions,{recursive:true});await mkdir(temp);
  const target=path.join(temp,'dsh-subprocess-Ab1234');await mkdir(target);const file=path.join(target,`dsh-subprocess-${process.pid}-1-123456abcdef-stdout.log`);await writeFile(file,'fixture');
  const events=[{type:'tool/call',data:{callId:'call1',name:'pwsh'}},{type:'tool/result',data:{message:{toolCallId:'call1',content:[{type:'text',text:`[output truncated; full output: ${file}]`}]}}}];
  let alive=true;const services={sessionPersistence:{config:{root:sessions},list:async()=>[{header:{id:'session-x'}}]},sessionQuery:{readSession:async()=>({events})}};
  const host=createDshTempHost({get:name=>services[name]},{tempRoot:temp,alive:()=>alive,authorize:()=>true});
  assert.equal((await host.tempUsage(target)).owned,false);
  await assert.rejects(readdir(path.join(home,'.futureaide-control','temp-evidence')));
  const observed=await host.observeSession('session-x');assert.equal(observed[0].inUse,true);
  assert.equal((await host.tempUsage(target)).inUse,true);alive=false;
  assert.equal((await host.tempUsage(target)).reason,'temporary-contents-or-references-present');
  await rm(file);const empty=await host.tempUsage(target);assert.equal(empty.owned,true);assert.equal(empty.inUse,false);
  const evidenceDir=path.join(home,'.futureaide-control','temp-evidence');assert.equal((await readdir(evidenceDir)).length,1);
 }finally{await rm(base,{recursive:true,force:true})}
});



test('normal collection requires enabled same-root authority and enabled configuration',async()=>{
 const {createAuthority,openAuthority}=await import('../src/cleanup-authority.mjs');const base=await mkdtemp(path.join(os.tmpdir(),'dsh-temp-auth-'));try{
  const home=path.join(base,'home'),sessions=path.join(home,'sessions'),temp=path.join(base,'temp'),configFile=path.join(base,'config.json');await mkdir(sessions,{recursive:true});await mkdir(temp);await writeFile(configFile,JSON.stringify({dshDataRoot:home,agentAutoCleanup:true}));
  const target=path.join(temp,'dsh-subprocess-Ab1234');await mkdir(target);const file=path.join(target,`dsh-subprocess-${process.pid}-1-123456abcdef-stdout.log`);await writeFile(file,'fixture');
  const events=[{type:'tool/call',data:{callId:'call1',name:'pwsh'}},{type:'tool/result',data:{message:{toolCallId:'call1',content:[{type:'text',text:`[output truncated; full output: ${file}]`}]}}}];
  const services={sessionPersistence:{config:{root:sessions},list:async()=>[{header:{id:'session-x'}}]},sessionQuery:{readSession:async()=>({events})}};
  const host=createDshTempHost({get:name=>services[name]},{tempRoot:temp});assert.equal(await host.canObserve(),false);assert.deepEqual(await host.observeSession('session-x'),[]);
  const config={configFile,dshDataRoot:home,profile:null};const id=await createAuthority(config,true,'test',[]);const authority=await openAuthority(config,true,{binding:id,write:true});authority.toggle(true);
  assert.equal(await host.canObserve(),true);await host.observeSession('session-x');assert.equal((await host.tempUsage(target)).inUse,true);
  authority.toggle(false);assert.equal(await host.canObserve(),false);authority.close();
  await writeFile(configFile,JSON.stringify({dshDataRoot:home,agentAutoCleanup:false}));assert.equal(await host.canObserve(),false);
 }finally{await rm(base,{recursive:true,force:true})}
});
