import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import {test} from 'node:test';import assert from 'node:assert/strict';
import {createTempCleanup} from '../src/cleanup-temp.mjs';
test('temporary cleanup requires a same-root host ownership and unused proof',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'temp-cleanup-'));try{
  const target=path.join(root,'dsh-spill-Ab1234');await mkdir(target);await writeFile(path.join(target,'one'),'hello');
  const unknown=createTempCleanup({tempDirectory:root},{dsh:{tempUsage:async()=>({inUse:null})}});assert.equal((await unknown.inspect(target)).owned,false);
  const adapter=createTempCleanup({tempDirectory:root},{dsh:{tempUsage:async()=>({owned:true,inUse:false})}});const item=await adapter.inspect(target);
  assert.equal(item.bytes,5);assert.equal((await adapter.remove(item,{revalidate:()=>false})).removed,false);
  assert.equal((await readFile(path.join(target,'one'),'utf8')),'hello');
  assert.equal((await adapter.remove(item,{revalidate:()=>true})).removed,false);
  await rm(path.join(target,'one'));const empty=await adapter.inspect(target);
  assert.deepEqual(await adapter.remove(empty,{revalidate:()=>true}),{removed:true,bytes:0});
  assert.equal((await adapter.inspect(path.join(root,'../dsh-spill-Ab1234'))).owned,false);
 }finally{await rm(root,{recursive:true,force:true})}
});
test('new activity or host uncertainty invalidates deletion',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'temp-cleanup-'));try{
  const target=path.join(root,'dsh-subprocess-Ab1234');await mkdir(target);await writeFile(path.join(target,'one'),'a');let busy=false;
  const adapter=createTempCleanup({tempDirectory:root},{dsh:{tempUsage:async()=>({owned:true,inUse:busy})}});const item=await adapter.inspect(target);
  busy=true;assert.equal((await adapter.remove(item,{revalidate:()=>true})).removed,false);busy=false;
  await writeFile(path.join(target,'one'),'changed');assert.equal((await adapter.remove(item,{revalidate:()=>true})).removed,false);
 }finally{await rm(root,{recursive:true,force:true})}
});

test('a shared hard link is never removed with the temporary directory',async()=>{
 const {link}=await import('node:fs/promises');const root=await mkdtemp(path.join(os.tmpdir(),'temp-cleanup-'));
 try{const target=path.join(root,'dsh-spill-Ab1234'),outside=path.join(root,'outside');await mkdir(target);await writeFile(outside,'shared');await link(outside,path.join(target,'link'));
 const adapter=createTempCleanup({tempDirectory:root},{dsh:{tempUsage:async()=>({owned:true,inUse:false})}});
 const result=await adapter.inspect(target);assert.equal(result.owned,false);assert.match(result.reason,/linked/);assert.equal(await readFile(outside,'utf8'),'shared');
 }finally{await rm(root,{recursive:true,force:true})}
});
