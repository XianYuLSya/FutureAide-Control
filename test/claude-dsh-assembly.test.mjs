import test from 'node:test';
import assert from 'node:assert/strict';
import { startDshFixture } from './assembly/dsh.mjs';
import {
  makeFixtureRoot, freePort, writeControlConfig, writeClaudeSession,
  assemblyEnv, startWorker, waitForHealth, connectHttpMcp, callTool, claudeSessionId, until,
} from './assembly/fixture.mjs';

const TOOL_NAMES = ['futureaide_run_agent', 'futureaide_create_agent', 'futureaide_send_agent'];
const methods = calls => calls.map(call => call.method);

test('Claude caller reaches DSH through the real worker surface with model and effort', async t => {
  const { root, workspace } = await makeFixtureRoot(t, 'claude-dsh');
  const dsh = await startDshFixture({ root, workspace });
  const reportPort = await freePort();
  const configPath = await writeControlConfig({ root, workspace, dsh, reportPort });
  const claudeHome = await writeClaudeSession({ root, workspace });
  const env = assemblyEnv({ claudeHome, fakeClaude: true, extra: { FUTUREAIDE_MONITOR_TRACE: '1' } });
  env.FUTUREAIDE_ASSEMBLY_CLAUDE_WORKSPACE = workspace;

  const worker = await startWorker({ configPath, env });
  t.after(async () => {
    // Only the worker this test spawned is closed; no system-wide process query.
    await worker.close();
    await dsh.close();
  });

  try {
    await waitForHealth(reportPort, { timeoutMs: 20000 });
  } catch (error) {
    throw new Error(`${error.message}\nworker output:\n${JSON.stringify(worker.output(), null, 2)}`);
  }
  const mcp = await connectHttpMcp(reportPort);
  t.after(() => mcp.close());

  // The worker owns the report service. If it forgot to install
  // scopedManagement, this list is empty (or an empty handler error appears on
  // the first call); either failure is exactly the assembly miss this test owns.
  const catalog = await mcp.client.listTools();
  // The Claude worker mounts the 11 name-addressed management tools; ask_parent /
  // report_parent belong to the Codex stdio surface. Assert the three entry points
  // that this regression owns instead of pinning an unrelated total.
  for (const name of TOOL_NAMES) {
    const tool = catalog.tools.find(item => item.name === name);
    assert.ok(tool, `${name} is registered`);
    assert.ok(tool.inputSchema.properties.model, `${name} advertises model`);
    assert.ok(tool.inputSchema.properties.effort, `${name} advertises effort`);
    assert.ok(!tool.inputSchema.required?.includes('model'), `${name} keeps model optional`);
    assert.ok(!tool.inputSchema.required?.includes('effort'), `${name} keeps effort optional`);
  }

  // A name with no explicit choice stays on the host default path and reports
  // null until the target has actually reported a model.
  const plain = await callTool(mcp.client, 'futureaide_create_agent',
    { name: '默认名称', lifetime: 'persistent' });
  assert.notEqual(plain.isError, true, JSON.stringify(plain.value));
  assert.equal(plain.value.created, true);
  assert.equal(plain.value.actualModel, null);
  const plainList = await callTool(mcp.client, 'futureaide_list_agents', {});
  const plainEntry = plainList.value.items.find(item => item.name === '默认名称');
  assert.equal(plainEntry.actualModel, null);

  // create + send: an explicit pin is stored before the first input and resolved
  // against the live DSH catalog. The send must use the managed session-only
  // selection wire, not the native session/selectModel that changes the app default.
  const created = await callTool(mcp.client, 'futureaide_create_agent',
    { name: '戴维', lifetime: 'persistent', model: 'ASTRA', effort: 'max' });
  assert.notEqual(created.isError, true, JSON.stringify(created.value));
  assert.equal(created.value.created, true);
  assert.equal(created.value.actualModel, 'astra-3.5', 'the receipt returns the full resolved ID');

  const sent = await callTool(mcp.client, 'futureaide_send_agent',
    { name: '戴维', message: 'do the work', model: 'astra-4', effort: 'max' });
  assert.notEqual(sent.isError, true, JSON.stringify(sent.value));
  assert.equal(sent.value.actualModel, 'astra-4');

  const selectedCalls = dsh.calls().filter(call => call.method === 'managedSelectModel');
  assert.equal(selectedCalls.length, 2, `create and send each apply the explicit pin; calls=${JSON.stringify(methods(dsh.calls()))} native=${dsh.state.nativeSelectCalls}`);
  assert.equal(selectedCalls[0].path, '/futureaide-control/managedSelectModel',
    'the explicit pin uses the plugin-managed wire, not /api/session/selectModel');
  assert.equal(selectedCalls[1].path, '/futureaide-control/managedSelectModel');
  const createSelection = selectedCalls[0].args;
  assert.equal(createSelection.ownerId.startsWith('owner-'), true);
  assert.equal(typeof createSelection.agentId, 'string');
  assert.equal(typeof createSelection.sessionId, 'string');
  assert.equal(createSelection.workspace, workspace);
  assert.deepEqual(createSelection.selection,
    { provider: 'dsh-fixture', model: 'astra-3.5', reasoningEffort: 'max' });

  const sendSelection = selectedCalls[1].args;
  assert.equal(typeof sendSelection.taskId, 'string');
  assert.equal(sendSelection.workspace, workspace);
  assert.deepEqual(sendSelection.selection,
    { provider: 'dsh-fixture', model: 'astra-4', reasoningEffort: 'max' });
  assert.equal(dsh.state.nativeSelectCalls, 0,
    'an explicit pin must never call the native session/selectModel that changes the application default');
  assert.deepEqual(dsh.state.currentModel,
    { provider: 'dsh-fixture', model: 'astra-4', reasoningEffort: 'max' },
    'the target session actually holds the selected full model and effort');

  const promptCalls = dsh.calls().filter(call => call.method === 'session/prompt');
  assert.equal(promptCalls.length, 1);
  assert.ok(methods(dsh.calls()).indexOf('managedSelectModel') < methods(dsh.calls()).indexOf('session/prompt'),
    'the session is selected before the first prompt');

  const listed = await callTool(mcp.client, 'futureaide_list_agents', {});
  assert.equal(listed.value.items.find(item => item.name === '戴维').actualModel, 'astra-4');
  const waited = await callTool(mcp.client, 'futureaide_wait_agents',
    { names: ['戴维'], timeout_seconds: 0 });
  assert.equal(waited.value.items[0].actualModel, 'astra-4');

  // A later send without a model must reuse the name's frozen selection; it must
  // not fall back to the default, and it must not write a new selection.
  const followup = await callTool(mcp.client, 'futureaide_send_agent',
    { name: '戴维', message: 'continue' });
  assert.notEqual(followup.isError, true, JSON.stringify(followup.value));
  assert.equal(followup.value.actualModel, 'astra-4');
  assert.equal(dsh.calls().filter(call => call.method === 'managedSelectModel').length, 2,
    'a later send without model/effort reuses the pin');
  await until(() => dsh.calls().filter(call => call.method === 'session/prompt').length === 2,
    { timeoutMs: 5000, message: 'the second DSH prompt' });

  // run is the one-call entry. A substring resolves in catalog order and the
  // receipt carries the full ID.
  const ran = await callTool(mcp.client, 'futureaide_run_agent',
    { name: '运行助手', message: 'run', model: 'astra-4', effort: 'max' });
  assert.notEqual(ran.isError, true, JSON.stringify(ran.value));
  assert.equal(ran.value.created, true);
  assert.equal(ran.value.actualModel, 'astra-4');

  const status = await callTool(mcp.client, 'futureaide_status', { detail: true });
  assert.notEqual(status.isError, true, JSON.stringify(status.value));
  assert.equal(status.value.contextVerified, true);
  assert.equal(status.value.returnChannel, 'chat-verified');
  assert.equal(status.value.ready, true);
  // The model catalog is the other half of the status contract.
  assert.deepEqual(status.value.backends.dsh.models, ['dsh-default', 'astra-3.5', 'astra-4']);
  assert.equal(status.value.backends.dsh.defaultModel, 'dsh-default');
});
