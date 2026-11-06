// Production assembly test: a Codex chat caller reaches the real stdio MCP
// server, creates a Codex Desktop subagent, and the model/effort the caller
// selected is carried through the live model catalog into turn/start.
//
// Only the lowest native I/O boundary is replaced: test/assembly/hooks.mjs swaps
// the renderer transport used by src/codex-ipc.mjs. The MCP server, the scoped
// state machine, the Codex adapter and the shared monitor are all production code.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startRendererFixture } from './assembly/renderer.mjs';
import {
  assemblyEnv, callTool, callerThreadId, devRoot, freePort, makeFixtureRoot,
  startWorker, until, waitForHealth, writeCodexHome, writeControlConfig,
} from './assembly/fixture.mjs';

async function startMcpServer({ configPath, env, workspace }) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(devRoot, 'src', 'mcp-server.mjs')],
    cwd: workspace,
    env: { ...env, DSH_CONTROL_CONFIG: configPath, FUTUREAIDE_CONTROL_CONFIG: configPath },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', chunk => { stderr += chunk; });
  const client = new Client({ name: 'codex-caller-assembly', version: '1.0.0' });
  await client.connect(transport);
  return {
    client, stderr: () => stderr,
    close: async () => { await client.close(); },
  };
}

test('Codex caller carries model and effort from the catalog into turn/start', async t => {
  const { root, workspace } = await makeFixtureRoot(t, 'codex-caller');
  const temp = path.join(root, 'tmp');
  await mkdir(temp, { recursive: true });
  const renderer = await startRendererFixture({ workspace, callerThreadId });
  const reportPort = await freePort();
  const configPath = await writeControlConfig({
    root, workspace,
    dsh: { instanceFile: path.join(root, 'dsh-instance.json'),
      hostBridgeFile: path.join(root, 'host-bridge.json') },
    reportPort,
  });
  const codexHome = await writeCodexHome({ root, configPath });
  const env = assemblyEnv({ codexHome, rendererUrl: renderer.url,
    extra: { TEMP: temp, TMP: temp, FUTUREAIDE_MONITOR_TRACE: '1' } });

  let worker;
  let mcp;
  t.after(async () => {
    await mcp?.close().catch(() => {});
    await worker?.close().catch(() => {});
    await renderer.close().catch(() => {});
  });

  // The production scoped-worker is spawned through the fixture's
  // ensureSharedMonitor with this temp roster/config; the test holds its child
  // handle and closes only that process. No real installation monitor is touched.
  worker = await startWorker({ configPath, env, label: 'codex-caller' });
  await waitForHealth(reportPort, { timeoutMs: 20000 });
  mcp = await startMcpServer({ configPath, env, workspace });

  const meta = { threadId: callerThreadId };
  const created = await callTool(mcp.client, 'futureaide_create_agent', {
    name: 'Luna助手', lifetime: 'persistent', target: 'codex-desktop', model: 'luna', effort: 'low',
  }, meta);
  assert.notEqual(created.isError, true, JSON.stringify(created.value));
  assert.equal(created.value.created, true);
  assert.equal(created.value.target, 'codex-desktop');
  assert.equal(created.value.modelRequestsStarted, 0,
    'creating a named Codex subagent starts no model turn');
  assert.equal(created.value.actualModel, 'gpt-6-luna');

  const sent = await callTool(mcp.client, 'futureaide_send_agent', {
    name: 'Luna助手', message: 'assembly task',
  }, meta);
  assert.notEqual(sent.isError, true, JSON.stringify(sent.value));
  assert.equal(sent.value.actualModel, 'gpt-6-luna');

  // A name with no model receives the ordinary native-inheritance delivery: no
  // model or effort field may be written to thread/start or turn/start.
  const plainCreated = await callTool(mcp.client, 'futureaide_create_agent', {
    name: '默认投递', lifetime: 'persistent', target: 'codex-desktop',
  }, meta);
  assert.notEqual(plainCreated.isError, true, JSON.stringify(plainCreated.value));
  assert.equal(plainCreated.value.created, true);
  assert.equal(plainCreated.value.actualModel, null);
  const plainSent = await callTool(mcp.client, 'futureaide_send_agent', {
    name: '默认投递', message: 'plain default task',
  }, meta);
  assert.notEqual(plainSent.isError, true, JSON.stringify(plainSent.value));
  assert.equal(plainSent.value.actualModel, null);

  // The send call can also carry the first explicit selection for a name created
  // without one. The receipt must report the full catalog id, not the substring.
  const selectedCreated = await callTool(mcp.client, 'futureaide_create_agent', {
    name: 'Astra助手', lifetime: 'persistent', target: 'codex-desktop',
  }, meta);
  assert.notEqual(selectedCreated.isError, true, JSON.stringify(selectedCreated.value));
  assert.equal(selectedCreated.value.actualModel, null);
  const selectedSent = await callTool(mcp.client, 'futureaide_send_agent', {
    name: 'Astra助手', message: 'selected task', model: 'ASTRA', effort: 'max',
  }, meta);
  assert.notEqual(selectedSent.isError, true, JSON.stringify(selectedSent.value));
  assert.equal(selectedSent.value.actualModel, 'gpt-6-astra');

  const turns = await until(() => {
    const calls = renderer.calls().filter(call => call.method === 'turn/start');
    return calls.length >= 3 ? calls : undefined;
  }, { timeoutMs: 20000, message: 'the three production dispatches to reach turn/start' });
  const textOf = call => (call.params.input ?? []).map(item => item.text ?? '').join('');
  const lunaTurn = turns.find(call => textOf(call).includes('assembly task'));
  const plainTurn = turns.find(call => textOf(call).includes('plain default task'));
  const selectedTurn = turns.find(call => textOf(call).includes('selected task'));
  assert.ok(lunaTurn && plainTurn && selectedTurn, 'each queued task reached its own turn/start');

  // The pin created before the first input is applied to that turn.
  assert.equal(lunaTurn.params.model, 'gpt-6-luna');
  assert.equal(lunaTurn.params.effort, 'low');
  assert.equal(renderer.thread(lunaTurn.params.threadId)?.model, 'gpt-6-luna');
  assert.equal(renderer.thread(lunaTurn.params.threadId)?.reasoningEffort, 'low');

  // The selection supplied with send is resolved against the live catalog and
  // applied to the first turn of a name that had no pin.
  assert.equal(selectedTurn.params.model, 'gpt-6-astra');
  assert.equal(selectedTurn.params.effort, 'max');
  assert.equal(renderer.thread(selectedTurn.params.threadId)?.model, 'gpt-6-astra');
  assert.equal(renderer.thread(selectedTurn.params.threadId)?.reasoningEffort, 'max');

  // Ordinary delivery keeps native inheritance: neither field is present at all.
  assert.equal('model' in plainTurn.params, false);
  assert.equal('effort' in plainTurn.params, false);
  assert.equal(renderer.thread(plainTurn.params.threadId)?.model, 'gpt-6-astra');
  assert.equal(renderer.thread(plainTurn.params.threadId)?.reasoningEffort, 'high');
  const started = renderer.calls().filter(call => call.method === 'thread/start');
  assert.ok(started.length >= 3, 'each named task has its own real thread');
  for (const call of started) {
    assert.equal('model' in call.params, false, 'thread/start must keep native inheritance');
    assert.equal('effort' in call.params, false, 'thread/start must keep native inheritance');
  }

  // The catalog was really consulted for the two explicit selections, and each
  // resolution happened before its turn/start.
  const methods = renderer.calls().map(call => call.method);
  assert.ok(methods.filter(method => method === 'model/list').length >= 2);
  assert.ok(methods.indexOf('model/list') < methods.indexOf('turn/start'));
});
