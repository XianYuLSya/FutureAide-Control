import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { FutureAideClient } from '../src/futureaide-api.mjs';
import { createControl } from '../src/control.mjs';

const { values } = parseArgs({ options: { runtime: { type: 'string' }, workspace: { type: 'string' }, evidence: { type: 'string' }, 'workspace-only': { type: 'boolean' } } });
for (const name of ['runtime', 'workspace', 'evidence']) if (!values[name] || !path.isAbsolute(values[name])) throw new Error(`--${name} must be absolute.`);
const root = values.workspace;
const home = path.join(root, 'home');
const work = path.join(root, 'work');
await mkdir(home, { recursive: true });
await mkdir(work, { recursive: true });
const requests = [];
const modelServer = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  requests.push({ model: body.model, toolCount: body.tools?.length ?? 0, reasoningEffort: body.reasoning_effort });
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: 'control smoke passed' }, finish_reason: null }] }) + '\n\n');
  res.write('data: ' + JSON.stringify({ id: 'smoke', object: 'chat.completion.chunk', created: 1, model: body.model,
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
const config = { workspace: work, dataRoot: home, stateDirectory: path.join(root, 'state'), hostBridgeFile: path.join(root, 'host-bridge.json') };
let entry = path.join(values.runtime, 'apps/cli/lib/bin.js');
try { await access(entry); } catch { entry = path.join(values.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'); }
const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(KEY|SECRET|TOKEN|PASSWORD|^DSH_|^FUTUREAIDE_|^NODE_OPTIONS$|^NODE_PATH$)/i.test(name)));
let log = '';
let child;
let ended;
function startHost() {
  child = spawn(process.execPath, [entry, '--profile', 'web', '--no-open', '--port', '0'], {
    cwd: work, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...environment, DSH_HOME: home, DSH_AGENTS_HOME: path.join(root, '.agents'), DSH_TELEMETRY_DISABLED: '1', FUTUREAIDE_DATA_ROOT: home, CODEX_CONTROL_FIXTURE_KEY: 'local-fixture-only' },
  });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log += chunk.toString('utf8'); });
  ended = new Promise(resolve => child.once('exit', resolve));
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
const result = { startedAt: new Date().toISOString(), runtime: values.runtime, isolatedHome: home, checks: [], realProviderRequests: 0 };
try {
  const launchUrl = await waitFor(() => log.match(/dsh web:\s*(http:\/\/\S+)/)?.[1], 'No host launch URL.');
  const client = new FutureAideClient({ launchUrl, hostBridgeFile: config.hostBridgeFile, timeoutMs: 20000,
    fetchImpl: async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === 'POST' && response.headers.get('content-type')?.includes('json')) {
        const body = await response.clone().json();
        if (body.result?.ok === false) (result.rpcErrors ??= []).push({ path: new URL(url).pathname, error: body.result.error });
      }
      return response;
    },
  });
  const exchange = await fetch(launchUrl, { redirect: 'manual' });
  const cookie = exchange.headers.get('set-cookie').split(';')[0];
  async function command(sessionId, line) {
    const rpcId = 'smoke-command-' + line.replace(/\W/g, '');
    const response = await fetch(new URL('/api/commands/execute', launchUrl), { method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId, method: 'commands/execute', payload: { args: { agentId: sessionId, line, submittedAttachments: [] } } }),
    });
    const output = await response.json();
    if (!output.result?.ok || output.result.value?.result?.kind !== 'success') throw new Error('Native test command failed: ' + JSON.stringify(output.result));
  }
  const control = createControl(config, { client });
  assert.equal((await client.status()).connected, true);
  result.checks.push('real isolated web host authenticated');
  if (!values['workspace-only']) {
    const bootstrap = await control.connect({ requestId: 'host-bootstrap' });
    assert.equal(bootstrap.ready, true);
    assert.equal((await control.hostStatus()).version, 1);
    result.bootstrapSession = bootstrap.bootstrapSessionId;
    result.checks.push('bootstrap preset loaded the host bridge through native session creation');
  }
  const first = await control.createSession({ requestId: 'target-a', agentPreset: 'standard' });
  const second = await control.createSession({ requestId: 'target-b', agentPreset: 'standard' });
  const duplicate = await control.createSession({ requestId: 'target-a', agentPreset: 'standard' });
  assert.equal(duplicate.sessionId, first.sessionId);
  assert.equal(duplicate.duplicate, true);
  assert.equal(first.projectVisible, true);
  assert.equal(second.projectVisible, true);
  assert.equal(requests.length, 0);
  result.workspaceId = first.workspaceId;
  result.workspaceSessionIdsConfirmed = [first.sessionId, second.sessionId];
  result.checks.push('created sessions were confirmed in the official workspace session list without a model request');
  if (values['workspace-only']) {
    result.status = 'passed';
  } else {
  const beforeDefault = (await control.models()).default;
  assert.equal(requests.length, 0);
  const selected = await control.selectModel({ sessionId: first.sessionId, provider: 'control-fixture', model: 'model-b', reasoningEffort: 'max', requestId: 'select-b' });
  assert.equal(selected.source, 'native-session-selectModel');
  assert.equal((await control.models()).default.model, 'model-b');
  await control.selectModel({ sessionId: second.sessionId, provider: 'control-fixture', model: 'model-a', reasoningEffort: 'max', requestId: 'select-a' });
  const capabilities = await control.capabilities({ sessionId: first.sessionId });
  const snapshot = JSON.parse(await readFile(capabilities.snapshotFile, 'utf8'));
  assert.ok(snapshot.tools.length > 0);
  assert.ok(snapshot.tools.every(tool => tool.parameters && tool.outputSchema));
  assert.equal(snapshot.model.model, 'model-b');
  assert.equal(snapshot.model.reasoningEffort, 'max');
  assert.equal(snapshot.permissions.approval.policy, 'ask');
  assert.equal(requests.length, 0);
  assert.deepEqual((await control.models()).default, beforeDefault);
  result.checks.push('create, duplicate receipt, model selection and full capability read started no model requests');
  result.checks.push('native model selection updated the host default; both execution sessions were explicitly selected');
  result.sessionIds = [first.sessionId, second.sessionId];
  result.totalTools = snapshot.tools.length;
  result.permissions = snapshot.permissions;
  await command(first.sessionId, '/plan');
  const inPlan = await control.capabilities({ sessionId: first.sessionId });
  assert.equal(inPlan.permissions.plan.active, true);
  await command(first.sessionId, '/plan off');
  await command(first.sessionId, '/permission read-only');
  const readOnly = await control.capabilities({ sessionId: first.sessionId });
  assert.equal(readOnly.permissions.sandbox.mode, 'read-only');
  await command(first.sessionId, '/permission workspace-write');
  assert.equal(requests.length, 0);
  result.checks.push('live plan and filesystem permission changes were visible without inference');
  for (const [index, sessionId] of result.sessionIds.entries()) {
    await control.send({ sessionId, message: 'Reply with the smoke result.', requestId: `local-prompt-${index}` });
    await waitFor(async () => {
      const output = await control.read({ sessionId });
      return output.messages.some(message => message.role === 'assistant' && message.text.includes('control smoke passed'));
    }, 'The local fixture model reply did not finish.');
  }
  assert.deepEqual(requests.filter(request => request.toolCount > 0).map(request => request.model), ['model-b', 'model-a']);
  assert.ok(requests.filter(request => request.toolCount > 0).every(request => request.reasoningEffort === 'max'));
  result.checks.push('actual local provider calls used model-b for the selected session and model-a for the other session');
  await waitFor(async () => {
    const rows = (await client.listSessions()).items;
    return result.sessionIds.every(sessionId => rows.find(row => row.sessionId === sessionId)?.running === false);
  }, 'The local fixture sessions did not become idle before the restart.');
  const logOffset = log.length;
  child.kill();
  await Promise.race([ended, deadline(5000, 'Host restart shutdown timed out.')]);
  startHost();
  const restartedLaunchUrl = await waitFor(() => log.slice(logOffset).match(/dsh web:\s*(http:\/\/\S+)/)?.[1], 'No restarted host launch URL.');
  const restartedClient = new FutureAideClient({ launchUrl: restartedLaunchUrl, hostBridgeFile: config.hostBridgeFile, timeoutMs: 20000 });
  const restartedControl = createControl(config, { client: restartedClient });
  assert.equal((await restartedControl.connect({ requestId: 'host-bootstrap-after-restart' })).ready, true);
  const requestsBeforeColdRead = requests.length;
  const coldHistory = await restartedControl.read({ sessionId: first.sessionId });
  assert.ok(coldHistory.messages.some(message => message.role === 'assistant' && message.text.includes('control smoke passed')));
  assert.equal(requests.length, requestsBeforeColdRead);
  result.checks.push('restarted host read persisted cold-session history through the authenticated cursor bridge without a model request');
  result.localFixtureRequests = requests;
  result.status = 'passed';
  }
} catch (error) {
  result.status = 'failed';
  result.error = error.message;
  result.logTail = log.slice(-10000).replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[redacted]');
  process.exitCode = 1;
} finally {
  if (child.exitCode === null) child.kill();
  await Promise.race([ended, deadline(5000, 'Host shutdown timed out.')]);
  result.hostClosed = true;
  modelServer.closeAllConnections();
  await new Promise(resolve => modelServer.close(resolve));
  result.finishedAt = new Date().toISOString();
  await mkdir(path.dirname(values.evidence), { recursive: true });
  await writeFile(values.evidence, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ status: result.status, checks: result.checks, error: result.error, evidence: values.evidence, hostClosed: result.hostClosed }, null, 2));
}
