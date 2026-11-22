import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp,rm } from 'node:fs/promises';
import { createDesktopCleanup } from '../src/cleanup-desktop.mjs';
import { rememberDeleted } from '../src/cleanup-native-receipts.mjs';

test('R03 read failure alone is unknown; an acknowledged delete and live same-domain inventory confirm the missing recipient',async t=>{
  const stateDirectory=await mkdtemp(path.join(os.tmpdir(),'fa-deleted-caller-'));
  t.after(()=>rm(stateDirectory,{recursive:true,force:true}));
  const codexDomain={version:1,dev:'1',ino:'2',home:path.join(stateDirectory,'native')};
  const owner={source:'codex-desktop',threadId:'created-here',codexDomain};
  let domain=codexDomain, restored=false;
  const adapter=createDesktopCleanup({stateDirectory,domainForThread:async()=>domain,nativeRequest:async method=>{
    if(method==='thread/read')throw new Error('thread not loaded');
    return {data:[{id:restored?owner.threadId:'same-host-witness'}]};
  }});
  assert.equal((await adapter.ownerStatus(owner)).state,'unknown');
  rememberDeleted({stateDirectory},codexDomain,[owner.threadId]);
  assert.equal((await adapter.ownerStatus(owner)).state,'deleted');
  domain={...domain,ino:'3'};
  assert.equal((await adapter.ownerStatus(owner)).state,'unknown');
  domain=codexDomain;restored=true;
  assert.equal((await adapter.ownerStatus(owner)).state,'unknown');
});
