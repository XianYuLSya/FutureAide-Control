import {mkdir,writeFile,readFile} from 'node:fs/promises';import path from 'node:path';import {randomUUID} from 'node:crypto';import assert from 'node:assert/strict';
import {RosterStore} from '../src/roster-store.mjs';import {createRosterCleanup} from '../src/cleanup-roster.mjs';import {createDesktopCleanup} from '../src/cleanup-desktop.mjs';
const url=process.argv[2],base=path.resolve(process.argv[3]??'.runtime/verification/agent-auto-cleanup/codex/rules-test');if(!url)throw Error('fixture URL required');await mkdir(base,{recursive:true});const info=await (await fetch(new URL('/info',url))).json();
async function call(method,params,options={}){const reply=await (await fetch(new URL('/rpc',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params,allow:options.canRelease?.()===true})})).json();if(reply.error)throw Object.assign(new Error(reply.error.message),{code:reply.error.code});return reply.result}
async function create(label){const body=await (await fetch(new URL('/create',url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label})})).json();if(body.error)throw Error(JSON.stringify(body));return body.result}
const outcome={fixture:url,workspace:info.work,tests:[]};
try{
 for(const spec of [{id:'r02',lifetime:'once',state:'failed',label:'FAIL_FIXTURE'},{id:'r04',lifetime:'persistent',state:'idle',label:'R04 idle fixture'},{id:'r01',lifetime:'once',state:'idle',label:'R01 delivered fixture'}]){
  const created=await create(spec.label),thread=created.thread,domain=created.domain,stateDirectory=path.join(base,spec.id);await mkdir(stateDirectory,{recursive:true});
  const desktop=createDesktopCleanup({stateDirectory,nativeRequest:call});const binding={binding:{sessionId:thread.id,owned:true,codexDomain:domain},tree:{nodes:[{sessionId:thread.id}]},requests:{}};
  const owner={ownerId:'owner-test',source:'codex-desktop',threadId:info.witnessId,codexDomain:domain,workspace:info.work};
  const native=await desktop.inspect({target:'codex-desktop',workspace:info.work},binding);assert.equal(native.running,false,JSON.stringify(native));assert.ok(native.lastActivityAt,JSON.stringify(native));
  const when=native.lastActivityAt,retention=10000;let now=Date.parse(when)+retention-1;
  const task={taskId:'task-'+spec.id,state:spec.state==='failed'?'failed':'completed',finishedAt:when};
  if(spec.id==='r01'){task.autoCleanupHeld=true;task.reports=[{id:'final-'+spec.id,message:'fixture final delivered',final:true,createdAt:when,delivery:{state:'delivered',deliveredAt:when}}]}
  const store=new RosterStore(path.join(stateDirectory,'roster.sqlite'));store.saveOwner(owner);
  const record={agentId:'agent-'+spec.id,ownerId:owner.ownerId,name:'fixture-'+spec.id,sessionId:thread.id,workspace:info.work,target:'codex-desktop',lifetime:spec.lifetime,state:spec.state,task};
  store.insert(record);store.saveBackendState(record.agentId,binding);await mkdir(path.join(stateDirectory,'scoped',owner.ownerId,record.agentId),{recursive:true});
  const engine=createRosterCleanup({stateDirectory,onceTerminalRetentionMs:retention,agentIdleRetentionMs:retention,cleanupNow:()=>now},{desktop});
  const before=(await engine.inventory()).items.find(row=>row.agentId===record.agentId);assert.ok(before,JSON.stringify(await engine.inventory()));
  if(spec.id!=='r01')assert.equal(before.eligible,false,JSON.stringify(before));else assert.equal(before.eligible,true,JSON.stringify(before));
  now++;const due=(await engine.inventory()).items.find(row=>row.agentId===record.agentId);assert.equal(due.eligible,true,JSON.stringify(due));
  const result=await engine.remove(due,{mode:'rules',revalidate:async()=>true,canDelete:()=>true,operationToken:randomUUID()});assert.equal(result.removed,true,JSON.stringify(result));
  const left=store.get(record.agentId);assert.equal(left,undefined);let after;try{after=await call('thread/read',{threadId:thread.id,includeTurns:false})}catch(e){after={error:e.message}}
  outcome.tests.push({id:spec.id,nativeThread:thread.id,nativeStatus:thread.status,when,retention,before:{eligible:before.eligible,reason:before.reason,lastActivityAt:before.lastActivityAt},due:{eligible:due.eligible,reason:due.reason,lastActivityAt:due.lastActivityAt},result,after});store.close();
 }
}catch(error){outcome.error=String(error.stack??error);process.exitCode=1}finally{await writeFile(path.join(base,'result.json'),JSON.stringify(outcome,null,2));console.log(JSON.stringify(outcome));}
