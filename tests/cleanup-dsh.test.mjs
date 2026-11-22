import test from 'node:test';
import assert from 'node:assert/strict';
import { createDshCleanup } from '../src/cleanup-dsh.mjs';
import { createDshHostCleanup } from '../src/host-plugin.mjs';

test('unavailable host is not treated as an empty complete inventory', async () => {
  const adapter=createDshCleanup({client:{cleanupInventory:async()=>{throw new Error('offline');},cleanupInspect:async()=>{throw new Error('offline');},cleanupRemove:async()=>{throw new Error('offline');},cleanupTempUsage:async()=>{throw new Error('offline');}}});
  assert.deepEqual(await adapter.inventory(),{items:[],complete:false,reason:'offline'});
  assert.deepEqual(await adapter.inspect({id:'x'}),{available:false,reason:'offline'});
  assert.deepEqual(await adapter.remove({id:'x'}),{removed:false,reason:'offline'});
  assert.deepEqual(await adapter.tempUsage('x'),{inUse:null,reason:'offline'});
});

test('missing host services cannot authorize deletion or prove temp unused', async () => {
  const host=createDshHostCleanup({get:()=>undefined});
  assert.equal((await host.inventory()).complete,false);
  assert.equal((await host.inspect({id:'x'})).available,false);
  assert.equal((await host.remove({id:'x'})).removed,false);
  assert.equal((await host.tempUsage('x')).inUse,null);
});


test('orphan archive refuses differing content for the same root, session and event sequence',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises'),{default:os}=await import('node:os'),{default:path}=await import('node:path');
  const {archiveOrphanHistory}=await import('../src/cleanup-dsh.mjs'); const root=await mkdtemp(path.join(os.tmpdir(),'orphan-archive-'));
  try {
    const config={stateDirectory:root,dshDataRoot:root}, history={complete:true,events:[{sessionId:'child',sourceId:'child:7',event:{seq:7,time:1795350000000,text:'original'}}]};
    assert.equal(archiveOrphanHistory(config,history,root).count,1);
    assert.equal(archiveOrphanHistory(config,history,root).count,1);
    const altered=structuredClone(history);altered.events[0].event.text='different';
    assert.throws(()=>archiveOrphanHistory(config,altered,root),/orphan-archive-verification-failed/);
  } finally {await rm(root,{recursive:true,force:true});}
});
