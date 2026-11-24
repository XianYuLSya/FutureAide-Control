import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { FutureAideClient } from '../src/futureaide-api.mjs';
import { createControl } from '../src/control.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createRosterCleanup } from '../src/cleanup-roster.mjs';
import { createDshCleanup } from '../src/cleanup-dsh.mjs';
import { openAuthority } from '../src/cleanup-authority.mjs';
import { loadConfig } from '../src/config.mjs';

const { values } = parseArgs({ options: { runtime: { type: 'string' }, workspace: { type: 'string' }, evidence: { type: 'string' }, plugin: { type: 'string' }, 'codex-fixture':{type:'string'} } });
for (const name of ['runtime', 'workspace', 'evidence', 'plugin']) if (!values[name] || !path.isAbsolute(values[name])) throw new Error(`--${name} must be absolute.`);
const root = values.workspace;
const home = path.join(root, 'home');
const agentsHome = path.join(root, 'home', '.agents');
if (!values['codex-fixture']) throw new Error('--codex-fixture required');
const codexInfo=await (await fetch(new URL('/info',values['codex-fixture']))).json();
const work = codexInfo.owner.workspace;
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
  const ask=(body.tools??[]).some(t=>t.function?.name==='ask_parent');
  const delta=ask ? {role:'assistant',tool_calls:[{index:0,id:'ask-fixture',type:'function',function:{name:'ask_parent',arguments:JSON.stringify({message:'请确认这个测试问题？'})}}]} : {role:'assistant',content:'fixture'};
  res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta,finish_reason:null}]})+'\n\n');
  res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:body.model,choices:[{index:0,delta:{},finish_reason:ask?'tool_calls':'stop'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}})+'\n\n');
  res.end('data: [DONE]\n\n');
});
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
const plugin = values.plugin;
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
        config: { cleanupGraceMs: 1000, dataRoot: home, credentialFile: config.hostBridgeFile, discoveryFile: path.join(home, '.runtime', 'dsh-control', 'instances', String(process.pid)+'.json') },
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
  child = spawn((process.env.LOCALAPPDATA || process.env.USERPROFILE + '/AppData/Local') + '/Programs/DeepSeek Harness/DeepSeek Harness.exe', ['--expose-internals',
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

  const managed={ownerId:codexInfo.owner.ownerId,agentId:'fixture-agent',sessionId:'session-codex-'+(await import('node:crypto')).randomUUID().replaceAll('-',''),workspace:work,treeProtocol:1,reportProtocol:1,taskId:'fixture-task'};
  result.created=await client.managedCreate({...managed,taskId:undefined});
  result.started=await client.managedBeginTask(managed);
  result.sent=await client.managedSendMessage(managed,'Reply to the fixture.',{requestId:'managed-fixture-prompt'});
  result.inspect=await waitFor(async()=>{const r=await client.managedCleanupInspect(managed); return r.complete?r:null;},'managed cleanup inspection did not become complete',30000);
  assert.equal(result.inspect.running,false); assert.equal(result.inspect.historyComplete,true); assert.equal(result.inspect.ownership,'managed');
  assert.ok(result.inspect.history.some(x=>x.event?.type==='turn/end'));
  assert.ok(result.inspect.questions.some(q=>q.state==='pending' && q.message==='请确认这个测试问题？'));
  const operationToken=(await import('node:crypto')).randomUUID();
  result.refusal=await client.managedCleanupStage({...managed,expected:result.inspect,operationToken});
  assert.ok(['managed-question-pending','managed-question-disposition-unverified'].includes(result.refusal.reason),JSON.stringify(result.refusal));
  const offset=log.length; child.kill(); await ended; startHost();
  await waitFor(()=>log.slice(offset).match(/dsh web:\s*(http:\/\/\S+)/)?.[1],'restart failed');
  const cold=new FutureAideClient({target:'dsh',dshDataHome:home,hostBridgeFile:config.hostBridgeFile,timeoutMs:20000});
  result.coldInspect=await cold.managedCleanupInspect(managed);
  assert.equal(result.coldInspect.complete,true); assert.equal(result.coldInspect.running,false);
  assert.ok(result.coldInspect.questions.some(q=>q.state==='pending' && q.message==='请确认这个测试问题？'));
  result.checks.push('ask_parent pending after turn retained and readable from cold host; ordinary cleanup refuses');
  const isolatedConfig=path.join(root,'config.json'), previewFile=path.join(root,'cli-preview.json'), decisionsFile=path.join(root,'cli-decisions.json');
  await writeFile(isolatedConfig,JSON.stringify({dshDataRoot:home,hostBridgeFile:config.hostBridgeFile,workspace:work,agentAutoCleanup:true,cleanupGraceMs:1000}));
  await mkdir(config.stateDirectory,{recursive:true});
  await copyFile(path.join(codexInfo.stateDirectory,'cleanup-native-receipts.sqlite'),path.join(config.stateDirectory,'cleanup-native-receipts.sqlite'));
  const store=new RosterStore(path.join(config.stateDirectory,'roster.sqlite'));
  store.saveOwner(codexInfo.owner);
  store.insert({agentId:managed.agentId,ownerId:managed.ownerId,name:'fixture-helper',sessionId:managed.sessionId,
    workspace:work,target:'dsh',lifetime:'persistent',state:'idle',task:{taskId:managed.taskId,state:'completed',finishedAt:new Date().toISOString()}});
  store.close();
  const loader=path.join(root,'isolated-codex-loader.mjs');
  const target=pathToFileURL(path.resolve('src/cleanup-desktop.mjs')).href, actual=target+'?isolated-original';
  const replacement=`import {createDesktopCleanup as original} from ${JSON.stringify(actual)};
    export function createDesktopCleanup(config) { return original({...config,nativeRequest:async(method,params)=>{
      const response=await fetch(${JSON.stringify(new URL('/rpc',values['codex-fixture']).href)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({method,params})});
      const body=await response.json();if(body.error)throw Object.assign(new Error(body.error.message),{code:body.error.code});return body.result;
    }}); }`;
  await writeFile(loader,`import {registerHooks} from 'node:module';\nregisterHooks({load(url,context,next){if(url===${JSON.stringify(target)})return {format:'module',shortCircuit:true,source:${JSON.stringify(replacement)}};return next(url,context);}});\n`);
  const cli=async args=>new Promise((resolve,reject)=>{
    const processChild=spawn(process.execPath,['--import',pathToFileURL(loader).href,path.resolve('src/cli.mjs'),'--config',isolatedConfig,...args],{cwd:process.cwd(),windowsHide:true,
      env:{...environment,CODEX_HOME:path.join(root,'isolated-codex-home'),DSH_HOME:home,TEMP:path.join(root,'temp'),TMP:path.join(root,'temp')},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';processChild.stdout.on('data',chunk=>stdout+=chunk);processChild.stderr.on('data',chunk=>stderr+=chunk);
    processChild.once('error',reject);processChild.once('exit',code=>resolve({code,stdout,stderr}));
  });
  result.cliPreview=await cli(['cleanup','preview','--scopes','roster,dsh','--output',previewFile]);
  assert.equal(result.cliPreview.code,0,JSON.stringify(result.cliPreview));
  const preview=JSON.parse(await readFile(previewFile,'utf8'));
  assert.equal(preview.coverage.dsh.complete,true,JSON.stringify(preview.coverage));
  const candidate=preview.items.find(item=>item.provider==='roster' && item.agentId===managed.agentId);
  assert.ok(candidate);assert.equal(candidate.firstEligible,true,JSON.stringify(candidate));
  await writeFile(decisionsFile,JSON.stringify({snapshot:preview.hash,remaining:'B',first:[candidate.key],keep:[]}));
  result.cliApproval=await cli(['cleanup','approve','--manifest',previewFile,'--decisions',decisionsFile]);
  assert.equal(result.cliApproval.code,0,JSON.stringify(result.cliApproval));
  const approval=JSON.parse(result.cliApproval.stdout).approval;
  // Use the normal authority toggle in-process to avoid spawning an unattended monitor.
  const loaded=await loadConfig(isolatedConfig), binding=JSON.parse(await readFile(path.join(config.stateDirectory,'cleanup-binding.json'),'utf8'));
  for(const [scope,id] of Object.entries(binding.ids)) {const ledger=await openAuthority(loaded,scope==='shared',{write:true,binding:id});try{ledger.toggle(true);}finally{ledger.close();}}
  const firstOut=path.join(root,'cli-first.json');
  result.cliFirst=await cli(['cleanup','apply','--manifest',previewFile,'--approval',approval,'--output',firstOut]);
  assert.equal(result.cliFirst.code,0,JSON.stringify(result.cliFirst));
  const first=JSON.parse(await readFile(firstOut,'utf8'));
  assert.ok(first.items.some(item=>item.staged===true),JSON.stringify(first));
  const q=result.coldInspect.questions.find(item=>item.state==='pending');
  const archivesOut=path.join(root,'cli-archives.json');
  result.cliArchive=await cli(['cleanup','archive','--original-id',q.id,'--output',archivesOut]);
  assert.equal(result.cliArchive.code,0,JSON.stringify(result.cliArchive));
  const archived=JSON.parse(await readFile(archivesOut,'utf8'));
  assert.ok(archived.some(row=>row.source==='dsh-question' && row.payload.event.message===q.message));
  await new Promise(resolve=>setTimeout(resolve,1200));
  const finalOut=path.join(root,'cli-final.json');
  result.cliFinal=await cli(['cleanup','apply','--manifest',previewFile,'--approval',approval,'--output',finalOut]);
  assert.equal(result.cliFinal.code,0,JSON.stringify(result.cliFinal));
  const final=JSON.parse(await readFile(finalOut,'utf8'));
  assert.ok(final.items.some(item=>item.removed===true),JSON.stringify(final));
  const readback=new RosterStore(path.join(config.stateDirectory,'roster.sqlite'));
  try{assert.equal(readback.get(managed.agentId),undefined);}finally{readback.close();}
  result.ownerProofSource='real isolated Codex deletion + durable receipt; RPC access proxied to isolated app-server through test loader';
  result.checks.push('normal CLI preview/approve/apply/archive + recovery used real isolated Codex deletion receipt and cold DSH; authority toggle was in-process to avoid unattended monitor');
  result.status = 'passed';
} catch (error) {
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
