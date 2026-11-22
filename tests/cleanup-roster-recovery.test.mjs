import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverRosterOperation } from '../src/cleanup-roster-recovery.mjs';
const key=JSON.stringify(['roster','managed-agent','/root','agent']);
test('recovers only the roster ticket exactly bound to the prior service token',async()=>{
  let calls=0;
  const adapter={ticket:id=>({id,root_id:'agent',status:'claimed'}),resume:async(id,context)=>{calls++;assert.equal(context.mode,'rules');return {removed:true,ticketId:id};}};
  const prior={key,mode:'rules',plan:JSON.stringify({ticketToken:'token'}),detail:null};
  assert.equal((await recoverRosterOperation(adapter,prior,{revalidate:async()=>true})).removed,true);
  assert.equal(calls,1);
  assert.equal((await recoverRosterOperation(adapter,{...prior,detail:JSON.stringify({ticketId:'other'})},{revalidate:async()=>true})).reason,'roster-ticket-token-conflict');
  assert.equal((await recoverRosterOperation({...adapter,ticket:()=>({id:'token',root_id:'other',status:'claimed'})},prior,{revalidate:async()=>true})).reason,'roster-ticket-identity-mismatch');
  assert.equal((await recoverRosterOperation(adapter,prior,{revalidate:async()=>false})).reason,'cleanup-authorization-changed');
  assert.equal(calls,1);
});
test('a completed ticket only reads back and never repeats native actions',async()=>{
  const result=await recoverRosterOperation({ticket:id=>({id,root_id:'agent',status:'completed'}),resume:()=>{throw new Error('must not run');}},
    {key,mode:'first',detail:JSON.stringify({ticketId:'token'})},{});
  assert.deepEqual(result,{removed:true,ticketId:'token',recovered:true});
  assert.equal(await recoverRosterOperation({}, {key,mode:'rules',detail:null,plan:null},{}),null);
});
