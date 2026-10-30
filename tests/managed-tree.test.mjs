import test from 'node:test';
import assert from 'node:assert/strict';
import { readManagedTree, waitManagedTree } from '../src/host-plugin.mjs';

test('tree requires a connected durable catalog and retains each agent change attribution', async () => {
  const root = {id:'root',status:'idle'}, child = {id:'child',status:'running'};
  const agents = new Map([['root',root],['child',child]]);
  const service = {listDescendants:async () => [{kind:'child',id:'child',parentId:'root',label:'helper'}]};
  const rows = await readManagedTree(service,agents,root,{child:[{path:'child-file'}]});
  assert.equal(rows[1].parentSessionId,'root'); assert.equal(rows[1].changes[0].path,'child-file');
  await assert.rejects(readManagedTree({listDescendants:async () => [{kind:'diagnostic',id:'x',parentId:'root'}]},agents,root), /unverified/);
  await assert.rejects(readManagedTree({listDescendants:async () => [{kind:'child',id:'x',parentId:'foreign'}]},agents,root), /unverified/);
});

test('tree barrier rechecks the root after descendant results arrive', async () => {
  const root = {id:'root',status:'idle',session:{seq:1},whenIdle:async () => {}};
  let checks=0;
  const subagents = {waitForChildren:async () => { if (++checks === 1) { root.session.seq++; return true; } return false; }};
  assert.equal(await waitManagedTree(subagents,new Map([['root',root]]),root,()=>true),2);
  assert.equal(checks,2);
});
