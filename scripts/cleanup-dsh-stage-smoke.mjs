import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  res.write('data: ' + JSON.stringify({ id: 'dsh-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'dsh native smoke passed' }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'dsh-smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\n');
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
        config: { dataRoot: home, credentialFile: config.hostBridgeFile, discoveryFile: path.join(home, '.runtime', 'dsh-control', 'instances', String(process.pid)+'.json') },
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

  const sessionId='session-'+(await import('node:crypto')).randomUUID();
  await client.createSession({sessionId,cwd:work,agentPreset:'standard'});
  result.sessionId=sessionId;

  await client.sendMessage(sessionId,'Reply with the fixture result.',{requestId:'stage-prompt'});
  await waitFor(async()=>{const row=(await client.listSessions()).items.find(x=>x.sessionId===sessionId); return row && row.running===false;},'session did not become idle');

  const logOffset=log.length; child.kill(); await ended; startHost();
  await waitFor(() => log.slice(logOffset).match(/dsh web:\s*(http:\/\/\S+)/)?.[1], 'restart failed');
  const cold = new FutureAideClient({target:'dsh', dshDataHome:home, hostBridgeFile:config.hostBridgeFile, timeoutMs:20000});
  const coldControl=createControl(config,{client:cold});
  result.beforeHistory=await coldControl.read({sessionId});
  assert.ok(result.beforeHistory.messages.some(m=>m.text?.includes('dsh native smoke passed')));
  result.before=await cold.cleanupInspect({sessionId});
  const operationToken=(await import('node:crypto')).randomUUID();
  result.stage=await cold.cleanupRemove({...result.before,ownership:'direct'},{operationToken});
  result.stageRetry=await cold.cleanupRemove({...result.before,ownership:'direct'},{operationToken});
  assert.equal(result.stageRetry.ticket,operationToken); assert.equal(result.stageRetry.staged,true);
  assert.equal(result.stage.staged,true);
  result.during=await cold.cleanupInspect({sessionId});
  const fs=await import('node:fs/promises'); const originalDir=path.dirname(result.before.nodes[0].log);
  await fs.mkdir(originalDir); await fs.writeFile(path.join(originalDir,'new-activity-marker'),'new');
  result.conflict=await cold.cleanupRestore(result.stage.ticket);
  assert.equal(result.conflict.restored,false); assert.equal(result.conflict.reason,'source-conflict');
  assert.equal(await fs.readFile(path.join(originalDir,'new-activity-marker'),'utf8'),'new');
  await fs.unlink(path.join(originalDir,'new-activity-marker')); await fs.rmdir(originalDir);
  result.restore=await cold.cleanupRestore(result.stage.ticket);
  assert.equal(result.restore.restored,true);
  result.after=await cold.cleanupInspect({sessionId});
  assert.equal(result.after.sessionId,sessionId);
  assert.deepEqual(result.after.nodes[0].workspaceIds,result.before.nodes[0].workspaceIds);
  assert.equal(result.after.nodes[0].pinned,result.before.nodes[0].pinned);
  assert.equal(result.after.nodes[0].archived,result.before.nodes[0].archived);
  result.afterHistory=await coldControl.read({sessionId});
  assert.deepEqual(result.afterHistory.messages,result.beforeHistory.messages);
  await cold.sendMessage(sessionId,'Reply to the second fixture request.',{requestId:'stage-after-restore'});
  await waitFor(async()=>{const row=(await cold.listSessions()).items.find(x=>x.sessionId===sessionId);return row && row.running===false;},'restored session did not finish');
  const secondOffset=log.length; child.kill(); await ended; startHost();
  await waitFor(()=>log.slice(secondOffset).match(/dsh web:\s*(http:\/\/\S+)/)?.[1],'second restart failed');
  const finalClient=new FutureAideClient({target:'dsh',dshDataHome:home,hostBridgeFile:config.hostBridgeFile,timeoutMs:20000});
  const finalControl=createControl(config,{client:finalClient});
  result.finalHistory=await finalControl.read({sessionId});
  assert.ok(result.finalHistory.messages.filter(m=>m.text?.includes('dsh native smoke passed')).length>=2);
  result.checks.push('cold ordinary direct session staged and restored using bridge, same session identity');
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
