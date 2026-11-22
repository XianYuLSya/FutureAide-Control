import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startDshFixture } from './assembly/dsh.mjs';
import { makeFixtureRoot, freePort, writeControlConfig, writeClaudeSession, writeCodexHome, assemblyEnv, startWorker, waitForHealth, connectHttpMcp, callTool, devRoot } from './assembly/fixture.mjs';
import { inboxPath, pendingFeedback } from '../src/feedback-inbox.mjs';

const workerScript = `const {DatabaseSync}=require('node:sqlite'); const d=new DatabaseSync(process.argv[1]);d.exec('PRAGMA busy_timeout=100; BEGIN IMMEDIATE');console.log('locked');setTimeout(()=>{d.exec('ROLLBACK');console.log('released');d.close()},5000)`;
const p95 = values => [...values].sort((a,b)=>a-b)[Math.ceil(values.length*.95)-1];
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
test('isolated monitor continues dispatch and report while feedback SQLite is locked', {timeout:120000}, async t => {
 const {root,workspace}=await makeFixtureRoot(t,'feedback-lock');
 const dsh=await startDshFixture({root,workspace}); const reportPort=await freePort();
 const configPath=await writeControlConfig({root,workspace,dsh,reportPort});
 const claudeHome=await writeClaudeSession({root,workspace}); const codexHome=await writeCodexHome({root,configPath});
 const env=assemblyEnv({claudeHome,codexHome,fakeClaude:true}); env.FUTUREAIDE_ASSEMBLY_CLAUDE_WORKSPACE=workspace;
 const config=JSON.parse(await readFile(configPath,'utf8'));
 assert.ok(path.isAbsolute(root) && path.dirname(configPath)===root && config.workspace===workspace);
 assert.ok(config.dshDataRoot===path.join(root,'dsh-home') && config.instanceFile===dsh.instanceFile && config.hostBridgeFile===dsh.hostBridgeFile);
 assert.ok(new URL(dsh.baseUrl).hostname==='127.0.0.1' && config.reportPort===reportPort && env.CODEX_HOME===codexHome);
 assert.ok((await readFile(dsh.instanceFile,'utf8')).includes(dsh.baseUrl));
 const worker=await startWorker({configPath,env}); t.after(async()=>{await worker.close();await dsh.close()});
 await waitForHealth(reportPort,{timeoutMs:20000}); const mcp=await connectHttpMcp(reportPort); t.after(()=>mcp.close());
 const created=await callTool(mcp.client,'futureaide_create_agent',{name:'lock-benchmark',lifetime:'persistent'}); assert.equal(created.isError,false,JSON.stringify(created.value));
 const existing=worker.store.list().find(x=>x.name==='lock-benchmark'); assert.ok(existing);
 for (const phase of ['baseline','locked']) for(let i=0;i<10;i++) { const r=await callTool(mcp.client,'futureaide_create_agent',{name:`${phase}-${i}`,lifetime:'persistent'}); assert.equal(r.isError,false,JSON.stringify(r.value)); }
 const agentId='lock-report-agent', taskId='lock-report-task', requestId='lock-report-request';
 worker.store.insert({...existing,agentId,name:'lock-report-agent',target:'claude-cli',state:'working',task:{taskId,dispatches:[{requestId}],reports:[],answers:[]}});
 const transport=new StdioClientTransport({command:process.execPath,args:[path.join(devRoot,'src','mcp-server.mjs'),'--claude-cli-reports',worker.store.location,agentId,taskId,requestId,configPath],env,stderr:'pipe'});
 const reports=new Client({name:'lock-report-fixture',version:'1'}); await reports.connect(transport); t.after(()=>reports.close());
 // Create the isolated feedback DB before the separate process claims its write lock.
 pendingFeedback(configPath);
 const metrics={configPath,root,reportPort,dshBaseUrl:dsh.baseUrl,codexHome,baseline:{dispatch:[],report:[]},locked:{dispatch:[],report:[],feedback:[]},lock:[]};
 async function measure(client,tool,args) {const start=performance.now();const value=await callTool(client,tool,args);const ms=performance.now()-start;assert.equal(value.isError,false,JSON.stringify(value.value));return {ms,value:value.value,finishedAt:Date.now()};}
 for(let i=0;i<10;i++) {
   const sent=await measure(mcp.client,'futureaide_send_agent',{name:`baseline-${i}`,message:`baseline ${i}`}); assert.equal(sent.value.accepted,true,JSON.stringify(sent.value)); metrics.baseline.dispatch.push(sent.ms);
   metrics.baseline.report.push((await measure(reports,'report_parent',{message:`baseline ${i}`,final:false})).ms);
 }
 let iteration=0;
 while(iteration<10) {
   const lock=spawn(process.execPath,['-e',workerScript,inboxPath(configPath)],{stdio:['ignore','pipe','pipe'],windowsHide:true});
   let out=''; lock.stdout.setEncoding('utf8'); lock.stdout.on('data',x=>{out+=x});
   const started=Date.now(); while(!out.includes('locked')) {if(lock.exitCode!==null || Date.now()-started>5000) throw Error('isolated lock failed');await tick()}
   const lockedAt=Date.now(); const lockInfo={lockedAt,releasedAt:null}; metrics.lock.push(lockInfo);
   // Start a feedback request on the same management worker before each pair.
   while(iteration<10 && Date.now()-lockedAt<3000) {
     const n=iteration++; const fs=performance.now(); let finished=false;
     const feedback=callTool(mcp.client,'futureaide_feedback',{kind:'problem',message:`lock sample ${n}`}).then(r=>{finished=true;return {ms:performance.now()-fs,finishedAt:Date.now(),value:r.value,isError:r.isError}});
     await tick(); assert.equal(finished,false,'feedback must still be waiting for the lock when operations begin');
     const [dispatch,report,fb]=await Promise.all([
       measure(mcp.client,'futureaide_send_agent',{name:`locked-${n}`,message:`locked ${n}`}),
       measure(reports,'report_parent',{message:`locked ${n}`,final:false}), feedback]);
     assert.equal(dispatch.value.accepted,true,JSON.stringify(dispatch.value)); assert.equal(report.value.accepted,true); metrics.locked.dispatch.push(dispatch); metrics.locked.report.push(report); metrics.locked.feedback.push(fb);
   }
   while(!out.includes('released')) {if(lock.exitCode!==null) throw Error(`lock exited early: ${out}`);await tick()}
   lockInfo.releasedAt=Date.now();
 }
 const release=metrics.lock.at(-1).releasedAt;
 for(const x of [...metrics.locked.dispatch,...metrics.locked.report]) assert.ok(metrics.lock.some(l=>x.finishedAt>=l.lockedAt&&x.finishedAt<l.releasedAt));
 for(const f of metrics.locked.feedback){assert.ok(f.ms<=2100,JSON.stringify(f));assert.equal(f.value?.saved,false,JSON.stringify(f));assert.equal(f.value?.code,'feedback-busy',JSON.stringify(f));}
 const after=pendingFeedback(configPath); assert.equal(after.length,0);
 metrics.p95={baselineDispatch:p95(metrics.baseline.dispatch),lockedDispatch:p95(metrics.locked.dispatch.map(x=>x.ms)),baselineReport:p95(metrics.baseline.report),lockedReport:p95(metrics.locked.report.map(x=>x.ms))};
 metrics.p95.dispatchIncrease=metrics.p95.lockedDispatch-metrics.p95.baselineDispatch; metrics.p95.reportIncrease=metrics.p95.lockedReport-metrics.p95.baselineReport;
 await writeFile(path.join(root,'feedback-lock-results.json'),JSON.stringify(metrics,null,2));
 console.log(`feedback lock evidence: ${path.join(root,'feedback-lock-results.json')}`);
 assert.ok(metrics.p95.dispatchIncrease<=250,JSON.stringify(metrics.p95));assert.ok(metrics.p95.reportIncrease<=250,JSON.stringify(metrics.p95));
});
