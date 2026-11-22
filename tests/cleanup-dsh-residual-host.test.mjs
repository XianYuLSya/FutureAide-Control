import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,mkdir,rm} from 'node:fs/promises';import os from 'node:os';import path from 'node:path';
import {createDshResidualHost} from '../src/host-plugin.mjs';
test('host removes only a verified unreferenced projection and confirms table read-back',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'dsh-residual-'));try{
  await mkdir(path.join(root,'sessions'));const data=new Map([['session-x',{payload:'cache'}]]);let native=false,reference=false,activity=[];
  const services={sessionPersistence:{name:'session-persistence-jsonl',config:{root:path.join(root,'sessions')},list:async()=>native?[{header:{id:'session-x'}}]:[],stat:async()=>native?{}:undefined},
   workspaceRegistry:{list:()=>[{sessionIds:reference?['session-x']:[]}],pinnedSessionIds:[],archivedSessionIds:[],ctx:{waterfall:async()=>activity}},
   sessionProjectionCache:{requireTable:()=>({get:async id=>data.get(id),delete:async id=>data.delete(id)})}};
  const host=createDshResidualHost({get:name=>services[name],agents:new Map(),sessions:new Map()});const input={kind:'projection',sessionId:'session-x',root};
  native=true;assert.equal((await host.inspectResidual(input)).running,true);native=false;reference=true;assert.equal((await host.inspectResidual(input)).running,true);reference=false;activity=null;assert.equal((await host.inspectResidual(input)).running,null);activity=[];
  const found=await host.inspectResidual(input);assert.equal(found.running,false);assert.equal((await host.removeResidual({...input,activityVersion:'old'})).removed,false);
  assert.equal((await host.removeResidual({...input,activityVersion:found.activityVersion})).removed,true);assert.equal(data.has('session-x'),false);
 }finally{await rm(root,{recursive:true,force:true})}
});
