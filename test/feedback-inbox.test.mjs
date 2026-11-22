import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os'; import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {submitFeedback} from '../src/feedback-client.mjs';
import {inboxPath,pendingFeedback,organizeFeedback,feedbackTodos} from '../src/feedback-inbox.mjs';
test('concurrent writes, redaction, WAL and organization', async () => {
 const dir=mkdtempSync(path.join(os.tmpdir(),'feedback-test-')); const configFile=path.join(dir,'config.json');
 try {
 const secret='a'.repeat(64), now=new Date().toISOString();
 const ctx={target:'dsh',name:`名字 ${secret}`,source:'dsh',error:{tool:'dispatch',code:'timeout',at:now}};
 const [a,b]=await Promise.all(['abc','def'].map(id=>submitFeedback({kind:'problem',message:`派单超时 requestId=${id} ${secret}`},ctx,{configFile})));
 assert.equal(a.saved,true); assert.equal(b.saved,true); assert.equal(a.id,b.id); assert.deepEqual([a.count,b.count].sort(),[1,2]);
 const p=pendingFeedback(configFile)[0]; assert.equal(p.occurrences.length,2); assert.ok(!JSON.stringify(p).includes(secret));
 const db=new DatabaseSync(inboxPath(configFile)); assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode,'wal');
 assert.equal(readFileSync(inboxPath(configFile)).includes(Buffer.from(secret)),false);
 assert.throws(()=>organizeFeedback(configFile,{id:a.id,through:2,todo:secret,message:'说明'}));
 organizeFeedback(configFile,{id:a.id,through:1,todo:'first',message:`建议 ${secret}`});
 assert.equal(pendingFeedback(configFile)[0].newCount,1); assert.equal(feedbackTodos(configFile)[0].message,'建议 [redacted]');
 organizeFeedback(configFile,{id:a.id,through:1,todo:'first',message:'旧内容'}); assert.equal(feedbackTodos(configFile)[0].message,'建议 [redacted]');
 db.exec('BEGIN IMMEDIATE'); const start=Date.now(); const busy=await submitFeedback({kind:'problem',message:'持锁反馈'},ctx,{configFile}); assert.deepEqual(busy,{saved:false,code:'feedback-busy'}); assert.ok(Date.now()-start<2100); db.exec('ROLLBACK'); db.close();
 assert.equal(pendingFeedback(configFile)[0].count,2);
 } finally {rmSync(dir,{recursive:true,force:true});}
});
test('conservative matching', async()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'feedback-test-'));const configFile=path.join(dir,'config.json');try{
 const run=(message,context)=>submitFeedback({kind:'problem',message},context,{configFile});
 let a=await run('超时',{}),b=await run('超时',{});assert.notEqual(a.id,b.id);
 a=await run('第 1 次回包错位',{target:'plugin'});b=await run('第 2 次回包错位',{target:'plugin'});assert.notEqual(a.id,b.id);
 }finally{rmSync(dir,{recursive:true,force:true})}});
