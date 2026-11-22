import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FutureAideClient } from '../src/futureaide-api.mjs';
import { createControl } from '../src/control.mjs';

const { values } = parseArgs({ options: { runtime: { type: 'string' }, workspace: { type: 'string' }, evidence: { type: 'string' }, plugin: { type: 'string' } } });
for (const name of ['runtime', 'workspace', 'evidence', 'plugin']) if (!values[name] || !path.isAbsolute(values[name])) throw new Error(`--${name} must be absolute.`);
const root = values.workspace;
const home = path.join(root, 'home');
const agentsHome = path.join(root, 'home', '.agents');
const work = path.join(root, 'work');
await mkdir(home, { recursive: true });
await mkdir(agentsHome, { recursive: true });
await mkdir(work, { recursive: true }); await mkdir(path.join(root, 'temp'), { recursive: true });

const requests = [];
const modelServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ model: body.model, toolCount: body.tools?.length ?? 0, reasoningEffort: body.reasoning_effort });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const count=body.messages.filter(m=>m.role==='tool').length;
  let readPath;
  if(count===2){
    const base=path.join(root,'temp');for(const name of await readdir(base))if(name.startsWith('dsh-spill-')){
      for(const session of await readdir(path.join(base,name)))for(const file of await readdir(path.join(base,name,session)))if(file.endsWith('-grep-results.txt'))readPath=path.join(base,name,session,file);
    }
  }
  const call=count===0?{name:'grep',arguments:JSON.stringify({pattern:'FINDME',path:'fixture.txt'})}
    :count===1?{name:'pwsh',arguments:JSON.stringify({description:'Generate bounded isolated test output',command:"Start-Sleep -Seconds 4; 'X' * 2000000"})}
    :count===2&&readPath?{name:'read',arguments:JSON.stringify({file_path:readPath,limit:1})}:null;
  const delta=call?{role:'assistant',tool_calls:[{index:0,id:'test-'+count,type:'function',function:call}]}:{role:'assistant',content:'dsh native smoke passed'};
  res.write('data: '+JSON.stringify({id:'dsh-smoke',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'dsh-smoke',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:call?'tool_calls':'stop'}]})+'\n\n');
  res.end('data: [DONE]\n\n');});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${modelServer.address().port}/v1`;
await writeFile(path.join(home, 'settings.yaml'), JSON.stringify({
  'agent-default-model': { provider: 'control-fixture', model: 'model-a', reasoningEffort: 'max' },
  'llm-pi-ai': { providers: { 'control-fixture': { displayName: 'Local fixture', api: 'openai-completions',
    baseURL, apiKeyEnv: 'CODEX_CONTROL_FIXTURE_KEY', models: ['model-a', 'model-b'].map(id => ({ id, name: id, contextWindow: 32768, maxTokens: 1024, reasoningEfforts: { off: 'off', max: 'max' } })) } } },
  'llm-retry': { maxRetries: 0 },
}, null, 2));

const config = {
  workspace: work,
  dataRoot: home,
  stateDirectory: path.join(root, 'state'),
  hostBridgeFile: path.join(root, 'host-bridge.json'),
};

await writeFile(config.hostBridgeFile, JSON.stringify({version:1,token:'a'.repeat(64)}));
const plugin = path.join(root, 'test-observation-bridge.mjs');
const bridge = await readFile(values.plugin, 'utf8');
const anchor = "      if (/^(?:cleanup|managedCleanup)/.test(endpoint)) {";
if (!bridge.includes(anchor)) throw new Error('Pass the current production host-plugin.mjs.');
const observation = `      if (endpoint === 'fixtureRequestShutdown') {
        setTimeout(()=>process.emit('SIGINT'),100);
        return {ok:true,value:{requested:true}};
      }
      if (endpoint === 'fixtureToolHistory') {
        const persistence=owner.get('sessionPersistence');
        const log=await persistence.resolveCurrentLog(input.sessionId);
        const saved=await persistence.readStoredLog(log,input.sessionId);
        return {ok:true,value:{events:(saved.events??[]).filter(e=>['tool/call','tool/result'].includes(e.type))}};
      }
`;
await writeFile(plugin, bridge.replace(anchor, observation + anchor), {flag:'wx'});
const argumentsByRuntime = [
  [values.runtime, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'],
  [values.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'],
];
let entry = null;
for (const [runtime, relative] of argumentsByRuntime) {
  try { await access(path.join(runtime, relative)); entry = { runtime, relative }; break; }
  catch { /* Try the documented fallback. */ }
}
if (!entry) entry = { runtime: values.runtime, relative: 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js' };
if (!entry) throw new Error(`Neither ${argumentsByRuntime.map(([runtime, relative]) => path.join(runtime, relative)).join(' nor ')} exists.`);

const patch = [
  {
    insert: [
      {
        id: 'dsh-control-discovery',
        name: pathToFileURL(plugin).href,
        config: { cleanupProbe: true, dataRoot: home, credentialFile: config.hostBridgeFile, discoveryFile: path.join(home, '.runtime', 'dsh-control', 'instances', String(process.pid)+'.json') },
      },
    ],
  },
];
const patchFile = path.join(root, 'discovery-patch.json');
await writeFile(patchFile, JSON.stringify(patch, null, 2) + '\n');

const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(KEY|SECRET|TOKEN|PASSWORD|^DSH_|^FUTUREAIDE_|^NODE_OPTIONS$|^NODE_PATH$|^FUTUREAIDE_DATA_ROOT$)/i.test(name)));

let log = '';
let child;
let ended;
function startHost() {
  child = spawn('C:/Users/汝皇/AppData/Local/Programs/DeepSeek Harness/DeepSeek Harness.exe', ['--expose-internals',
    path.join(entry.runtime, entry.relative),
    '--profile', 'web',
    '--patch', patchFile,
    '--no-open',
    '--port', '0',
  ], {
    cwd: work,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...environment,
      ELECTRON_RUN_AS_NODE: '1', TEMP: path.join(root, 'temp'), TMP: path.join(root, 'temp'),
      DSH_HOME: home,
      DSH_AGENTS_HOME: path.join(home, '.agents'),
      DSH_TELEMETRY_DISABLED: '1',
      CODEX_CONTROL_FIXTURE_KEY: 'local-fixture-only',
    },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString('utf8'); });
  ended = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}
startHost();

const deadline = (ms, description) => new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(description)), ms); timer.unref(); });
async function waitFor(check, description, timeout = 30000) {
  const started = Date.now();
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() - started > timeout) throw new Error(description);
    if (child.exitCode !== null) throw new Error('The isolated host exited.');
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

const result = {
  startedAt: new Date().toISOString(),
  runtime: entry.runtime,
  entry: { absolute: path.join(entry.runtime, entry.relative), relative: entry.relative },
  isolatedHome: home,
  isolatedAgentsHome: agentsHome,
  checks: [],
  realProviderRequests: 0,
};

try {
  const launchUrl = await waitFor(() => log.match(/dsh web:\s*(http:\/\/\S+)/)?.[1], 'No host launch URL.');
  result.launchUrlRecorded = true;
  async function fixtureProbe(url, method, args={}) {
    const exchange=await fetch(url,{redirect:'manual'}), cookie=exchange.headers.get('set-cookie').split(';')[0];
    const token=JSON.parse(await readFile(config.hostBridgeFile,'utf8')).token;
    const rootStat=await stat(home,{bigint:true});args={...args,cleanupRoot:{path:home,dev:String(rootStat.dev),ino:String(rootStat.ino)}};
    const rpcId='fixture-'+method; const response=await fetch(new URL('/futureaide-control/'+method,url),{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId,method,payload:{args:{...args,token}}})});
    const body=await response.json(); if (!body.result?.ok) throw new Error(body.result?.error?.code ?? 'fixture-probe-failed'); return body.result.value;
  }
  const client = new FutureAideClient({
    target: 'dsh',
    dshDataHome: home,
    hostBridgeFile: config.hostBridgeFile,
    timeoutMs: 20000,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === 'POST' && response.headers.get('content-type')?.includes('json')) {
        const body = await response.clone().json();
        if (body.result?.ok === false) (result.rpcErrors ??= []).push({ path: new URL(url).pathname, error: body.result.error });
      }
      return response;
    },
  });
  const discovered = await client.status();
  result.discovery = discovered;
  result.checks.push('auto discovery reported native DSH host status through the plugin registry');
  assert.equal(discovered.connected, true);
  assert.equal(discovered.application, 'dsh');
  assert.equal(discovered.source, 'dsh-plugin-registry');
  assert.equal(discovered.dataRoot, home);
  result.checks.push('DSH discovery found the native DSH host via source=dsh-plugin-registry, application=dsh, matched isolated dataRoot');

  const control = createControl(config, { client });
  const bootstrap = await control.connect({ requestId: 'dsh-native-bootstrap' });
  assert.equal(bootstrap.ready, true);
  assert.equal((await control.hostStatus()).version, 1);
  result.bootstrapSession = bootstrap.bootstrapSessionId;
  result.checks.push('bootstrap preset loaded the host bridge through native session creation');

  const first = await control.createSession({ requestId: 'native-target-a', agentPreset: 'standard' });
  const second = await control.createSession({ requestId: 'native-target-b', agentPreset: 'standard' });
  const capabilities = await control.capabilities({ sessionId:first.sessionId });
  const snapshot=JSON.parse(await readFile(capabilities.snapshotFile,'utf8'));
  result.tools=snapshot.tools.map(t=>t.name);
  await writeFile(path.join(work,'fixture.txt'), ('FINDME '+ '0123456789'.repeat(40)+String.fromCharCode(10)).repeat(2000));
  const cmdExchange=await fetch(launchUrl,{redirect:'manual'}),cmdCookie=cmdExchange.headers.get('set-cookie').split(';')[0];
  async function permit(id,tag){const r=await fetch(new URL('/api/commands/execute',launchUrl),{method:'POST',headers:{cookie:cmdCookie,'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:tag,method:'commands/execute',payload:{args:{agentId:id,line:'/permission danger-full-access',submittedAttachments:[]}}})});return r.json()}
  result.offPermission=await permit(second.sessionId,'off-permission');
  await control.send({sessionId:second.sessionId,message:'Run fixture with cleanup disabled.',requestId:'temp-off'});
  await waitFor(async()=>{const x=await control.read({sessionId:second.sessionId});return x.messages.some(m=>m.role==='assistant'&&m.text.includes('dsh native smoke passed'));},'disabled fixture not finished',60000);
  await waitFor(async()=>(await client.listSessions()).items.find(x=>x.sessionId===second.sessionId)?.running===false,'disabled fixture still active');
  await new Promise(resolve=>setTimeout(resolve,1800));
  const evidenceDir=path.join(home,'.futureaide-control','temp-evidence');
  result.beforeEnableProofs=await readdir(evidenceDir).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error));
  if(result.beforeEnableProofs.length)throw Error('disabled-collection-wrote-proof');
  const configFile=path.join(root,'config.json');await writeFile(configFile,JSON.stringify({dshDataRoot:home,workspace:work,agentAutoCleanup:true,agentCleanupIntervalMs:1000}));
  const exec=promisify(execFile),manifest=path.join(root,'cli-preview.json'),decisions=path.join(root,'cli-decisions.json');
  const cli=async(...args)=>(await exec(process.execPath,[path.resolve('src/cli.mjs'),'cleanup',...args,'--config',configFile],{cwd:work,windowsHide:true,env:{...process.env,CODEX_HOME:path.join(root,'codex'),DSH_HOME:home,DSH_CONTROL_CONFIG:configFile,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp')},timeout:30000,maxBuffer:1024*1024})).stdout;
  result.cliPreview=JSON.parse(await cli('preview','--scopes','files','--output',manifest));
  const previewSnapshot=JSON.parse(await readFile(manifest,'utf8'));await writeFile(decisions,JSON.stringify({snapshot:previewSnapshot.hash,remaining:'B',first:[],keep:[]}));
  result.cliApprove=JSON.parse(await cli('approve','--manifest',manifest,'--decisions',decisions));
  result.cliEnable=JSON.parse(await cli('enable'));
  result.permission=await permit(first.sessionId,'on-permission');
  await control.send({sessionId:first.sessionId,message:'Execute the authorized fixture.',requestId:'temp-on'});
  const liveDir=await waitFor(async()=>{const names=await readdir(path.join(root,'temp'));return names.find(name=>name.startsWith('dsh-subprocess-'));},'no subprocess temporary directory');
  result.during={path:path.join(root,'temp',liveDir),usage:await client.cleanupTempUsage(path.join(root,'temp',liveDir))};
  const liveSpill=(await readdir(path.join(root,'temp'))).find(name=>name.startsWith('dsh-spill-'));if(liveSpill)result.during.spill={path:path.join(root,'temp',liveSpill),usage:await client.cleanupTempUsage(path.join(root,'temp',liveSpill))};
  await waitFor(async()=>{const output=await control.read({sessionId:first.sessionId});return output.messages.some(m=>m.role==='assistant' && m.text.includes('dsh native smoke passed'));},'fixture did not finish',60000);
  await waitFor(async()=>(await client.listSessions()).items.find(x=>x.sessionId===first.sessionId)?.running===false,'fixture still active');
  await new Promise(resolve=>setTimeout(resolve,1800));
  result.toolEvents=await fixtureProbe(launchUrl,'fixtureToolHistory',{sessionId:first.sessionId});
  result.afterEnableProofs=await readdir(evidenceDir).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error));
  result.temps=[];for(const name of await readdir(path.join(root,'temp')))if(/^dsh-(spill|subprocess)-/.test(name)){const dir=path.join(root,'temp',name);result.temps.push({path:dir,files:await readdir(dir),usage:await client.cleanupTempUsage(dir)});}
  const historical=result.temps.find(value=>path.basename(value.path).startsWith('dsh-subprocess-'));
  if(!historical || historical.usage?.owned!==true || historical.usage?.inUse!==true)throw Error('live-provenance-not-recorded');
  const producerPid=child.pid,producerUrl=launchUrl,offset=log.length;
  result.gracefulStop=await fixtureProbe(producerUrl,'fixtureRequestShutdown');result.producerExit=await Promise.race([ended,deadline(10000,'normal-host-stop-timeout')]);result.producerPid=producerPid;
  if(![0,130].includes(result.producerExit.code))throw Error('producer-not-cleanly-exited');
  startHost();await waitFor(()=>log.slice(offset).match(/dsh web:\s*(http:\/\/\S+)/)?.[1],'second-host-start-failed');
  const later=new FutureAideClient({target:'dsh',dshDataHome:home,hostBridgeFile:config.hostBridgeFile,timeoutMs:20000});
  result.nonemptyAfterExit=await later.cleanupTempUsage(historical.path);
  const spillHistory=result.temps.find(value=>path.basename(value.path).startsWith('dsh-spill-'));if(spillHistory)result.spillAfterExit=await later.cleanupTempUsage(spillHistory.path);
  const names=await readdir(historical.path);if(!names.length||names.some(name=>!new RegExp('^dsh-subprocess-'+producerPid+'-').test(name)))throw Error('unexpected-fixture-contents');
  result.fixtureOutputs=[];for(const name of names){const file=path.join(historical.path,name),content=await readFile(file);result.fixtureOutputs.push({path:file,bytes:content.length,sha256:createHash('sha256').update(content).digest('hex'),removedForEmptyFixture:true});await unlink(file)}
  result.afterExit=await later.cleanupTempUsage(historical.path);
  await waitFor(async()=>{try{await stat(historical.path);return false}catch(e){if(e.code==='ENOENT')return true;throw e}},'monitor-did-not-remove-empty-root',30000);
  result.cliStatus=JSON.parse(await cli('status'));result.cliDisable=JSON.parse(await cli('disable'));result.remains=false;  throw new Error('inspection-probe-complete');} catch (error) {
  result.status = error.message === 'inspection-probe-complete' ? 'probe-complete' : 'failed';
  if (result.status === 'failed') result.error = error.message;
  result.logTail = log.slice(-10000).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]');
  if (result.status === 'failed') process.exitCode = 1;
} finally {
  if (child && child.exitCode === null) child.kill();
  if (ended) await Promise.race([ended, deadline(5000, 'Host shutdown timed out.')]);
  result.hostClosed = true;
  modelServer.closeAllConnections();
  await new Promise(resolve => modelServer.close(resolve));
  result.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(values.evidence), { recursive: true });
  await writeFile(values.evidence, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, checks: result.checks, error: result.error, evidence: values.evidence, hostClosed: result.hostClosed, runtime: entry.runtime, entry: entry.relative }, null, 2));
}
