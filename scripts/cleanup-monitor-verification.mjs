import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, readFile, writeFile, rename, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { RosterStore } from '../src/roster-store.mjs';

const exec=promisify(execFile);
const rootArg=process.argv[2];
if(!path.isAbsolute(rootArg??''))throw new Error('Pass an absolute isolated verification directory.');
await mkdir(rootArg,{recursive:true});
const root=await mkdtemp(path.join(rootArg,'monitor-'));
const shared=path.join(root,'dsh'),tmp=path.join(root,'temp');
const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
for(const name of ['temp','dsh','codex','claude','appdata','local','home'])await mkdir(path.join(root,name));
const env={...process.env,TMP:tmp,TEMP:tmp,DSH_HOME:shared,CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
  APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'local'),USERPROFILE:path.join(root,'home'),FUTUREAIDE_REPORT_PORT:'0'};
for(const name of ['FUTUREAIDE_INSTANCE_FILE','FUTUREAIDE_LAUNCH_URL','FUTUREAIDE_DATA_ROOT','CODEX_THREAD_ID'])delete env[name];
async function setup(name){
  const base=path.join(root,name), file=path.join(base,'config.json'),profile=path.join(base,'profiles','named.json'),state=path.join(base,'state','profiles','named');
  await Promise.all([mkdir(path.dirname(profile),{recursive:true}),mkdir(state,{recursive:true}),mkdir(path.join(base,'diagnostics'),{recursive:true})]);
  const settings={workspace:base,dataRoot:shared,baseUrl:'http://127.0.0.1:1',instanceFile:path.join(root,'unavailable.json'),
    reportPort:0,idleSessionCleanup:false,agentCleanupIntervalMs:1200,diagnosticRetentionMs:100};
  await writeFile(file,JSON.stringify({...settings,agentAutoCleanup:false}));await writeFile(profile,JSON.stringify({...settings,agentAutoCleanup:true}));
  const roster=new RosterStore(path.join(state,'roster.sqlite'));roster.close();
  return {base,file,state,profile,settings};
}
async function command(c,action,...args){
  const {stdout}=await exec(process.execPath,[cli,'cleanup',action,'--config',c.file,'--profile','named',...args],{
    windowsHide:true,env:{...env,DSH_CONTROL_CONFIG:c.file,FUTUREAIDE_CONTROL_CONFIG:c.file}});
  return JSON.parse(stdout);
}
async function observe(c,predicate){
  const until=Date.now()+30000;
  while(Date.now()<until){const data=await command(c,'status');if(predicate(data))return data;await delay(150);}
  throw new Error('Monitor acknowledgement timed out.');
}
async function permit(c,scopes,keepKinds=[]){
  const m=path.join(c.base,'snapshot.json'),d=path.join(c.base,'choices.json');
  await command(c,'preview','--scopes',scopes,'--output',m);
  const snapshot=JSON.parse(await readFile(m,'utf8'));
  await writeFile(d,JSON.stringify({snapshot:snapshot.hash,remaining:'B',keepKinds}));
  return command(c,'approve','--manifest',m,'--decisions',d);
}
async function endOwnMonitor(c){
  const db=new DatabaseSync(path.join(c.state,'roster.sqlite'));
  try {db.prepare("DELETE FROM leases WHERE key='scoped-monitor' OR holder LIKE 'monitor-%'").run();}finally{db.close();}
}
const a=await setup('a'),b=await setup('b'),events=[];
const keep=path.join(a.base,'diagnostics','mcp-2147483646-1600000000000.jsonl');
await writeFile(keep,JSON.stringify({pid:2147483646,event:'start'})+'\n');
try {
  await permit(a,'files',['diagnostic']);
  await command(a,'enable');
  const enabled=await observe(a,s=>s.shared?.worker?.generation===s.shared?.authority.generation);
  events.push({phase:'A-start',...enabled.shared});
  // A live named worker must see a change even if it holds an old in-memory configuration.
  const offAt=Date.now();
  await command(a,'disable');
  const disabled=await observe(a,s=>s.shared?.worker?.generation===s.shared?.authority.generation);
  assert.equal(disabled.shared.authority.enabled,0);
  events.push({phase:'A-disabled',elapsedMs:Date.now()-offAt,...disabled.shared});
  await command(a,'enable');
  await observe(a,s=>s.shared?.authority.enabled===1 && s.shared?.worker?.generation===s.shared?.authority.generation);
  const editAt=Date.now();
  await writeFile(a.profile,JSON.stringify({...a.settings,agentAutoCleanup:false}));
  const edited=await observe(a,s=>s.shared?.authority.enabled===0 && s.shared?.worker?.generation===s.shared?.authority.generation);
  events.push({phase:'A-config-off',elapsedMs:Date.now()-editAt,...edited.shared});
  await endOwnMonitor(a);
  const workerPid=enabled.shared.worker.pid;
  for(let i=0;i<60;i++) {try{process.kill(workerPid,0);}catch(e){if(e.code==='ESRCH')break;throw e;}await delay(200);}
  assert.throws(()=>process.kill(workerPid,0),{code:'ESRCH'});
  // B runs alone. Its local roster approval is independent from the shared root.
  await permit(b,'roster');await command(b,'enable');
  events.push({phase:'B-start',...(await observe(b,s=>s.local?.worker?.generation===s.local?.authority.generation)).local});
  async function tryForeign(){
    const output=path.join(b.base,'foreign-'+events.length+'.json'),choices=output+'.choices';
    await command(b,'preview','--scopes','files','--output',output);
    const snap=JSON.parse(await readFile(output,'utf8'));await writeFile(choices,JSON.stringify({snapshot:snap.hash,remaining:'B'}));
    try{await command(b,'approve','--manifest',output,'--decisions',choices);assert.fail('Foreign approval succeeded');}
    catch(error){if(error.code==='ERR_ASSERTION')throw error;return error.stderr||error.stdout||error.message;}
  }
  const ledger=path.join(shared,'.futureaide-control','cleanup-authority.sqlite');
  const foreignStatus=await command(b,'status');
  assert.match(foreignStatus.shared.reason,/different root, configuration or profile/i);
  events.push({phase:'foreign-root',reason:foreignStatus.shared.reason,error:await tryForeign()});
  await rename(ledger,ledger+'.reserved-test');
  try{
    const missing=await command(b,'status');
    assert.equal(missing.shared.reason,'shared-authority-missing');
    events.push({phase:'missing-root',reason:missing.shared.reason,error:await tryForeign()});
    await assert.rejects(stat(ledger),{code:'ENOENT'});
  }
  finally{await rename(ledger+'.reserved-test',ledger);}
  await stat(keep);
  await command(b,'disable');
  events.push({phase:'passed',protectedFile:keep});
} finally {
  await endOwnMonitor(a);await endOwnMonitor(b);
  await writeFile(path.join(root,'result.json'),JSON.stringify({root,events},null,2));
}
console.log(JSON.stringify({root,events:events.map(e=>e.phase)}));
