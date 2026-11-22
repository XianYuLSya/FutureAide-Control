import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { RosterStore } from '../src/roster-store.mjs';

const fixture = new URL(process.argv[2]);
if (fixture.hostname !== '127.0.0.1' || !path.isAbsolute(process.argv[3] ?? '')) throw new Error('Pass the isolated fixture and a fresh absolute output directory.');
const root=process.argv[3], info=await (await fetch(new URL('/info',fixture))).json();
await mkdir(root);
const env={...process.env,FUTUREAIDE_REPORT_PORT:'0'};
for(const [key,dir] of Object.entries({USERPROFILE:'profile',DSH_HOME:'dsh',CLAUDE_CONFIG_DIR:'claude',TEMP:'temp',APPDATA:'appdata',LOCALAPPDATA:'local'})){
  env[key]=path.join(root,dir);await mkdir(env[key]);
}
env.TMP=env.TEMP;env.CODEX_HOME=info.home;
for(const key of ['CODEX_THREAD_ID','FUTUREAIDE_INSTANCE_FILE','FUTUREAIDE_LAUNCH_URL','FUTUREAIDE_DATA_ROOT','FUTUREAIDE_CLAUDE_SESSION_ID'])delete env[key];
const config=path.join(root,'config.json'),state=path.join(root,'state');
await mkdir(state);env.DSH_CONTROL_CONFIG=env.FUTUREAIDE_CONTROL_CONFIG=config;
const period=20000;
await writeFile(config,JSON.stringify({workspace:info.work,dshDataRoot:env.DSH_HOME,agentAutoCleanup:true,agentIdleRetentionMs:period,onceTerminalRetentionMs:period,agentCleanupIntervalMs:1050,idleSessionCleanup:false,reportPort:0}));
const loader=path.join(root,'isolation.mjs');
const redirect=`async (method,params,options={})=>{
 const reply=await (await fetch(${JSON.stringify(new URL('/rpc',fixture).href)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params,allow:options.canRelease?.()===true})})).json();
 if(reply.error) throw Object.assign(new Error(reply.error.message),{code:reply.error.code});return reply.result;}`;
await writeFile(loader,`import {registerHooks} from 'node:module';registerHooks({load(url,context,next){
 const r=next(url,context);if(!url.endsWith('/codex-ipc.mjs')&&!url.endsWith('/codex-notify.mjs'))return r;
 const src=String(r.source);
 if(url.endsWith('/codex-ipc.mjs')){const anchor='(method, params, options) => nativeRpc.request(method, params, options)';if(!src.includes(anchor))throw Error('unknown native transport');return {...r,source:src.replace(anchor,${JSON.stringify(redirect)})};}
 const anchor='export async function invokeCodexTool(threadId, toolName, args, options = {}) {';if(!src.includes(anchor))throw Error('unknown desktop transport');
 return {...r,source:src.replace(anchor,anchor+"throw new Error('Desktop tools unavailable in isolation');")};}});`);
env.NODE_OPTIONS='--import='+pathToFileURL(loader).href;
const exec=promisify(execFile),cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
async function command(action,...args){const result=await exec(process.execPath,[cli,'--config',config,'cleanup',action,...args],{env,windowsHide:true});return JSON.parse(result.stdout);}
const store=new RosterStore(path.join(state,'roster.sqlite'));
const output={period,ids:[],transport:'Authentic app-server via loopback, native renderer view simulated, Desktop tools disabled. Source roster states are seeded.'};
try{
 const created=[];
 for(const label of ['FAIL_FIXTURE','R04 monitor expiry']) {
   const r=await (await fetch(new URL('/create',fixture),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({label})})).json();
   assert.ok(r.result,JSON.stringify(r)); created.push(r.result);
 }
 const ended=new Date().toISOString();output.ended=ended;
 store.saveOwner({ownerId:'fixture-owner',source:'codex-desktop',workspace:info.work,threadId:info.witnessId,codexDomain:created[0].domain});
 for(const [i,entry] of created.entries()) {
   const thread=entry.thread, state=i===0?'failed':'idle',id='agent-'+i;
   store.insert({agentId:id,ownerId:'fixture-owner',name:id,sessionId:thread.id,workspace:info.work,target:'codex-desktop',lifetime:i?'persistent':'once',state,
     task:{taskId:'task-'+i,state:i?'completed':'failed',finishedAt:ended}});
   store.saveBackendState(id,{binding:{sessionId:thread.id,owned:true,codexDomain:entry.domain},tree:{nodes:[{sessionId:thread.id}]},requests:{}});
   output.ids.push({agentId:id,nativeId:thread.id,state:thread.status});
 }
 const manifest=path.join(root,'manifest.json'),decisions=path.join(root,'decisions.json');
 await command('preview','--scopes','roster','--output',manifest);const snap=JSON.parse(await readFile(manifest,'utf8'));
 output.before=snap.items.map(({id,eligible,firstEligible,reason})=>({id,eligible,firstEligible,reason}));
 assert.equal(output.before.length,2);assert.ok(output.before.every(i=>i.firstEligible&&!i.eligible),JSON.stringify(output.before));
 await writeFile(decisions,JSON.stringify({snapshot:snap.hash,remaining:'B'}));output.sign=await command('approve','--manifest',manifest,'--decisions',decisions);
 output.enabled=await command('enable');
 const deadline=Date.now()+80000;
 while(output.ids.some(i=>store.get(i.agentId)) && Date.now()<deadline)await delay(500);
 output.completedAt=new Date().toISOString(); output.status=await command('status');
 assert.ok(output.ids.every(i=>!store.get(i.agentId)),JSON.stringify(output.status));
 assert.equal(output.status.local.operations.filter(o=>o.state==='removed').length,2);
 for(const row of output.ids){
   const res=await (await fetch(new URL('/rpc',fixture),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method:'thread/read',params:{threadId:row.nativeId,includeTurns:false}})})).json();
   row.after=res.error?.message;assert.ok(row.after);
 }
 output.passed=true;
} catch(error){output.error=error.stack;process.exitCode=1;} finally {
 await command('disable').catch(()=>{});store.close();await writeFile(path.join(root,'result.json'),JSON.stringify(output,null,2));
 console.log(JSON.stringify({passed:output.passed,error:output.error,root}));
}
