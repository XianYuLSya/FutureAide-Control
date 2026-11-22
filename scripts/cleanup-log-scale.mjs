// Run only with a new, generated fixture. It never opens the installed plugin's paths.
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir,mkdtemp,realpath,writeFile,rm,stat} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createFileCleanup} from '../src/cleanup-files.mjs';
import {RosterStore} from '../src/roster-store.mjs';

const count=Number(process.argv[2]??390000),container=process.argv[3];
if(!Number.isSafeInteger(count) || count<128 || count>390000 || !path.isAbsolute(container??''))throw new Error('Specify count 128..390000 and an absolute fixture parent.');
await mkdir(container,{recursive:true});
const area=await realpath(container);
const root=await mkdtemp(path.join(area,'diagnostic-scale-'));
const diagnostic=path.join(root,'diagnostics'),temp=path.join(root,'tmp'),state=path.join(root,'state'),dsh=path.join(root,'dsh');
for(const dir of [diagnostic,temp,state,dsh])await mkdir(dir);
const configFile=path.join(root,'config.json'),config={configFile,stateDirectory:state,dshDataRoot:dsh,diagnosticRetentionMs:86400000,agentAutoCleanup:false};
await writeFile(configFile,JSON.stringify(config));process.env.TEMP=temp;process.env.TMP=temp;
const result={root,count,node:process.version,started:new Date().toISOString()};
try{
  const started=performance.now();let sequence=0;
  await Promise.all(Array.from({length:16},async()=>{
    for(;;){const n=sequence++;if(n>=count)break;
      await writeFile(path.join(diagnostic,'mcp-2147483646-'+(1600000000000+n)+'.jsonl'),'{"pid":2147483646,"event":"start"}\n',{flag:'wx'});
    }
  }));
  result.createMs=performance.now()-started;
  const engine=createFileCleanup(config),store=new RosterStore(path.join(state,'roster.sqlite'));
  const ticks=[],loop=async i=>{
    const start=performance.now();const r=await engine.inventory({maintenance:false});assert.equal(r.items.length,128);
    ticks.push({i,pageItems:r.items.length,ms:performance.now()-start});
  };
  try{
    const batch=loop(1),begin=performance.now();
    store.insert({agentId:'dispatch-control',ownerId:'owner-fixture',name:'dispatch-control',target:'codex-desktop',state:'running',workspace:root,task:{taskId:'new-dispatch'}});
    assert.equal(store.get('dispatch-control').task.taskId,'new-dispatch');
    result.concurrentRosterDispatchMs=performance.now()-begin;await batch;await loop(2);
    result.pages=ticks;
  }finally{store.close();}
  const out=path.join(root,'manifest.json'),cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  const begin=performance.now();const {stdout}=await promisify(execFile)(process.execPath,[cli,'cleanup','preview','--scopes','files','--config',configFile,'--output',out],
    {windowsHide:true,env:{...process.env,DSH_CONTROL_CONFIG:configFile,FUTUREAIDE_CONTROL_CONFIG:configFile,DSH_HOME:dsh,CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude')}});
  result.previewMs=performance.now()-begin;
  const preview=JSON.parse(stdout);result.summary=preview.summary;result.coverage=preview.coverage;
  result.manifestBytes=(await stat(out)).size;assert.equal(Object.values(preview.summary).reduce((n,r)=>n+r.count,0),count);
  result.status='passed';
}catch(e){result.status='failed';result.reason=e.message;process.exitCode=1;}
finally{
  await writeFile(path.join(root,'metrics.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
  // Only remove the generated fixture's diagnostic directory. Retain the report and metrics.
  const resolved=await realpath(diagnostic);
  if(path.dirname(root)===area && path.basename(root).startsWith('diagnostic-scale-') && resolved===path.join(root,'diagnostics'))await rm(resolved,{recursive:true});
}
