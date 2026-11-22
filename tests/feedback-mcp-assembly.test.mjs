import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { makeScopedServer, scopedManagement } from '../src/mcp-server.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor, ownerIdForSource } from '../src/calling-context.mjs';
import { pendingFeedback } from '../src/feedback-inbox.mjs';
const thread = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const cli = fileURLToPath(new URL('../src/mcp-server.mjs', import.meta.url));
async function connect(server) { const client = new Client({ name:'feedback-isolated-test', version:'1' }); const [a,b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a); return client; }
function result(r) { return JSON.parse(r.content[0].text); }
test('isolated actual feedback writes from Codex, Claude management, managed Codex and CLI', async () => {
 const root = await mkdtemp(path.join(os.tmpdir(),'futureaide-feedback-mcp-')); const configFile=path.join(root,'config.json');
 const roster=path.join(root,'roster.sqlite'); const store = new RosterStore(roster);
 const config={configFile,stateDirectory:root,workspace:root,idleSessionCleanup:false};
 const service=createScopedAgents(config,{store});
 const owner=ownerIdFor(thread); const claudeOwner=ownerIdForSource('claude-desktop','claude-session');
 store.saveOwner({ownerId:owner,source:'codex-desktop',threadId:thread,workspace:root});
 store.saveOwner({ownerId:claudeOwner,source:'claude-desktop',nativeSessionId:'claude-session',workspace:root});
 const task={taskId:'task-one',startedAt:new Date().toISOString(),dispatches:[{requestId:'request-one'}],reports:[]};
 store.insert({agentId:'codex-agent',ownerId:owner,name:'codex helper',target:'codex-desktop',sessionId:'logical-codex',state:'running',workspace:root,task});
 store.saveBackendState('codex-agent',{binding:{threadId:child}});
 store.insert({agentId:'cli-agent',ownerId:owner,name:'cli helper',target:'claude-cli',sessionId:'logical-cli',state:'running',workspace:root,task});
 store.insert({agentId:'dsh-agent',ownerId:owner,name:'target',target:'dsh',sessionId:'logical-dsh',state:'running',workspace:root,task});
 const scoped=makeScopedServer({configReady:Promise.resolve(config),scopedFactory:()=>({...service,resume:async()=>{},ensureIdleMonitor:async()=>{}})});
 const cx=await connect(scoped); const mgmt=new McpServer({name:'isolated',version:'1'}); scopedManagement({service})({server:mgmt,trusted:async()=>({nativeSessionId:'claude-session',workspace:root})}); const cl=await connect(mgmt);
 const cp=new Client({name:'cli-test',version:'1'}); await cp.connect(new StdioClientTransport({command:process.execPath,args:[cli,'--claude-cli-reports',roster,'cli-agent','task-one','request-one',configFile,'--no-idle-session-cleanup']}));
 try {
  const failure = await cx.callTool({name:'futureaide_run_agent',arguments:{name:'target',target:'claude-cli',message:'conflicting target'},_meta:{threadId:thread}});
  assert.equal(result(failure).error.code,'target-conflict');
  const codexFailure = await cx.callTool({name:'report_parent',arguments:{message:'   '},_meta:{threadId:child}});
  assert.equal(result(codexFailure).error.code,'operation-failed');
  const cliFailure = await cp.callTool({name:'report_parent',arguments:{message:'   '}});
  assert.equal(result(cliFailure).error.code,'invalid-message');
  const a=result(await cx.callTool({name:'futureaide_feedback',arguments:{kind:'friction',message:'caller symptom',name:'target'},_meta:{threadId:thread}}));
  const b=result(await cl.callTool({name:'futureaide_feedback',arguments:{kind:'problem',message:'claude symptom'}}));
  const c=result(await cx.callTool({name:'feedback',arguments:{kind:'problem',message:'codex symptom'},_meta:{threadId:child}}));
  const d=result(await cp.callTool({name:'feedback',arguments:{kind:'problem',message:'cli symptom'}}));
  assert.deepEqual([a.saved,b.saved,c.saved,d.saved],[true,true,true,true]);
  const rows=pendingFeedback(configFile).flatMap(x=>x.occurrences);
  assert.equal(rows.find(x=>x.message==='caller symptom').error.code,'target-conflict');
  assert.equal(rows.find(x=>x.message==='codex symptom').error.code,'operation-failed');
  assert.equal(rows.find(x=>x.message==='cli symptom').error.code,'invalid-message');
  assert.equal(rows.find(x=>x.message==='claude symptom').error,null);
  assert.deepEqual(rows.map(x=>[x.source,x.caller,x.target,x.name]).sort(),[
   ['codex-desktop','codex-desktop','dsh','target'],['claude-desktop','claude-desktop','plugin',null],['codex-desktop','codex-desktop','codex-desktop','codex helper'],['claude-cli','codex-desktop','claude-cli','cli helper']].sort());
 } finally { await cp.close(); await cl.close(); await mgmt.close(); await cx.close(); await scoped.close(); store.close(); }
});
