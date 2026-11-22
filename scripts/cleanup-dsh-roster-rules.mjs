import assert from 'node:assert/strict';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { RosterStore } from '../src/roster-store.mjs';
import { FutureAideClient } from '../src/futureaide-api.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

export async function verifyDshRosterRules({ root, home, work, config, client, waitFor, restart }) {
  const filename = path.join(root, 'config.json');
  const duration = 20000;
  await writeFile(filename, JSON.stringify({ dshDataRoot: home, workspace: work, agentAutoCleanup: true,
    hostBridgeFile: config.hostBridgeFile, agentCleanupIntervalMs: 1100, agentIdleRetentionMs: duration,
    onceTerminalRetentionMs: duration, cleanupGraceMs: 1000, idleSessionCleanup: false, reportPort: 0 }));
  const env = { ...process.env, DSH_HOME: home, DSH_CONTROL_CONFIG: filename, FUTUREAIDE_CONTROL_CONFIG: filename,
    FUTUREAIDE_REPORT_PORT: '0', CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
    TMP: path.join(root, 'temp'), TEMP: path.join(root, 'temp'), USERPROFILE: path.join(root, 'profile'),
    APPDATA: path.join(root, 'appdata'), LOCALAPPDATA: path.join(root, 'local') };
  for (const key of ['FUTUREAIDE_INSTANCE_FILE','FUTUREAIDE_LAUNCH_URL','FUTUREAIDE_DATA_ROOT','CODEX_THREAD_ID','FUTUREAIDE_CLAUDE_SESSION_ID']) delete env[key];
  for (const key of ['CODEX_HOME','CLAUDE_CONFIG_DIR','USERPROFILE','APPDATA','LOCALAPPDATA']) await mkdir(env[key], {recursive:true});
  const command = async (action, ...args) => JSON.parse((await exec(process.execPath, [cli,'--config',filename,'cleanup',action,...args], {windowsHide:true,env})).stdout);
  const ownerId = 'fixture-owner';
  const identities = [];
  for (const kind of ['once','persistent']) {
    const target = { ownerId, agentId: 'fixture-'+kind, sessionId: 'session-codex-'+randomUUID().replaceAll('-',''),
      workspace: work, treeProtocol: 1, reportProtocol: 1, taskId: kind+'-task' };
    await client.managedCreate({...target,taskId:undefined});
    await client.managedBeginTask(target);
    await client.managedSendMessage(target,'Record a short fixture reply.',{requestId:randomUUID()});
    await waitFor(async () => {
      const view=await client.managedCleanupInspect(target);
      return view.complete && view.history.some(r=>r.event?.type==='turn/end') && view.running===false;
    },'real fixture turn did not settle');
    identities.push({...target,kind});
  }
  await restart();
  const native = new FutureAideClient({dshDataHome:home,hostBridgeFile:config.hostBridgeFile});
  await mkdir(config.stateDirectory,{recursive:true});
  const store = new RosterStore(path.join(config.stateDirectory,'roster.sqlite'));
  const ended = new Date().toISOString();
  const summary = {retentionMs:duration, ended, ids:identities.map(({agentId,sessionId})=>({agentId,sessionId}))};
  try {
    store.saveOwner({ownerId,source:'fixture',workspace:work});
    for (const target of identities) {
      const state=target.kind==='once'?'failed':'completed';
      store.insert({agentId:target.agentId,ownerId,name:target.kind,sessionId:target.sessionId,workspace:work,target:'dsh',
        lifetime:target.kind,state:target.kind==='once'?'failed':'idle',task:{taskId:target.taskId,state,finishedAt:ended}});
    }
    const manifest=path.join(root,'rules-manifest.json'), choices=path.join(root,'rules-choices.json');
    await command('preview','--scopes','roster,dsh','--output',manifest);
    const snap=JSON.parse(await readFile(manifest,'utf8'));
    summary.before=snap.items.filter(i=>i.provider==='roster').map(({id,eligible,firstEligible,lastActivityAt,reason})=>({id,eligible,firstEligible,lastActivityAt,reason}));
    assert.equal(summary.before.length,2);
    assert.ok(summary.before.every(i=>i.firstEligible && !i.eligible),JSON.stringify(summary.before));
    const keep=snap.items.filter(i=>i.provider==='dsh' && i.ownership==='direct').map(i=>i.key);
    await writeFile(choices,JSON.stringify({snapshot:snap.hash,remaining:'B',first:[],keep}));
    summary.approval=await command('approve','--manifest',manifest,'--decisions',choices);
    summary.enabled=await command('enable');
    await waitFor(async()=>identities.every(i=>!store.get(i.agentId)),'monitor did not retire both expired roster entries',80000);
    summary.completedAt=new Date().toISOString();
    assert.ok(Date.parse(summary.completedAt)>=Date.parse(ended)+duration);
    summary.afterNative=(await native.listSessions()).items.map(i=>i.sessionId);
    assert.ok(identities.every(i=>!summary.afterNative.includes(i.sessionId)));
    summary.authority=await command('status');
    assert.equal(summary.authority.local.operations.filter(o=>o.state==='removed').length,2);
    return summary;
  } finally {
    await command('disable').catch(()=>{});
    store.close();
  }
}
