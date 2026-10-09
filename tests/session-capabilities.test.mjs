import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createControl } from '../src/control.mjs';
import { capabilitySnapshot, createHostHandler } from '../src/host-plugin.mjs';
import { installHostBridge } from '../src/host-install.mjs';

async function setup(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-control-capabilities-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'work');
  await mkdir(workspace);
  return { root, config: { workspace, stateDirectory: path.join(root, 'state'), dataRoot: path.join(root, 'data'), hostBridgeFile: path.join(root, 'bridge.json') } };
}

test('create uses a stable generated identity, caches its result and never submits a prompt', async t => {
  const { config } = await setup(t);
  let creates = 0;
  const client = { createSession: async input => { creates++; return { ...input, accepted: true }; } };
  const control = createControl(config, { client });
  const created = await control.createSession({ requestId: 'a', agentPreset: 'boss' });
  const duplicate = await control.createSession({ requestId: 'a', agentPreset: 'boss' });
  assert.equal(creates, 1);
  assert.equal(created.sessionId, duplicate.sessionId);
  assert.equal(duplicate.agentPreset, 'boss');
  assert.equal(duplicate.duplicate, true);
  assert.equal(created.cwd, config.workspace);
  await assert.rejects(control.createSession({ requestId: 'a', agentPreset: 'other' }), /different content/);
});

test('unknown creation preserves the identity and never creates again on the same request', async t => {
  const { config } = await setup(t);
  let creates = 0;
  const control = createControl(config, { client: { createSession: async () => { creates++; throw Object.assign(new Error('timeout'), { uncertain: true }); } } });
  await assert.rejects(control.createSession({ requestId: 'uncertain' }), /timeout/);
  const result = await control.createSession({ requestId: 'uncertain' });
  assert.equal(result.status, 'unknown');
  assert.match(result.sessionId, /^session-codex-/);
  assert.equal(creates, 1);
});

test('model changes and capability reads reject another project before invoking the host', async t => {
  const { config, root } = await setup(t);
  const control = createControl(config, { client: { listSessions: async () => ({ items: [{ sessionId: 'foreign', cwd: root }] }) } });
  await assert.rejects(control.selectModel({ sessionId: 'foreign', provider: 'p', model: 'm', requestId: 'x' }), /configured project/);
  await assert.rejects(control.capabilities({ sessionId: 'foreign' }), /configured project/);
});

test('large capabilities retain every full schema in the referenced snapshot', async t => {
  const { config } = await setup(t);
  const tools = Array.from({ length: 80 }, (_, i) => ({ name: 'tool_' + i, parameters: { description: 'x'.repeat(22000) } }));
  const control = createControl(config, { client: {
    listSessions: async () => ({ items: [{ sessionId: 'parent', cwd: config.workspace }] }),
    capabilities: async () => ({ tools, totalTools: tools.length, complete: true, permissions: { plan: { active: true } } }),
  } });
  const result = await control.capabilities({ sessionId: 'parent', toolName: 'tool_1' });
  assert.equal(result.toolNames.length, 80);
  assert.equal(result.toolDetailInSnapshot, 'tool_1');
  const snapshot = JSON.parse(await readFile(result.snapshotFile, 'utf8'));
  assert.deepEqual(snapshot.tools, tools);
  assert.ok(result.snapshotFile.startsWith(config.stateDirectory + path.sep));
});

function agentFixture(workspace) {
  const events = [];
  const callbacks = new Map();
  let calls = 0;
  const schema = { name: 'read', description: 'Read a file', parameters: { path: { type: 'string' } } };
  const services = {
    tools: { schemas: () => [schema], get: () => ({ ...schema, output: { schema: { type: 'string' } } }) },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: workspace }) },
    approval: { overrideOf: () => undefined, config: { policy: 'never', privateKey: 'secret-not-exported' } },
    planMode: {}, sessionProjections: { snapshot: () => ({ values: { plan: { active: true, pending: false } } }) },
    llm: { resolveCallConfig: async input => {
      if (input.model === 'bad') throw new Error('private credential');
      return input;
    } },
  };
  const agent = { id: 'parent', status: 'idle', options: { provider: 'old', model: 'old', privateKey: 'secret-not-exported' },
    inbox: { nextTurn: [], nextStep: [] },
    session: { header: { cwd: workspace }, events, append: (type, data) => events.push({ type, data }) },
    ctx: { ...services, get: key => services[key], on: (event, fn, options) => { callbacks.set(event, { fn, options }); } },
    prompt: () => { calls++; },
  };
  return { agent, events, callbacks, calls: () => calls };
}

test('live host returns schemas and policy without exposing config secrets or executing anything', async t => {
  const { config } = await setup(t);
  const f = agentFixture(config.workspace);
  const handler = createHostHandler({ agents: { get: () => f.agent } }, 'a'.repeat(64));
  const denied = await handler('capabilities', { args: { token: 'b'.repeat(64), sessionId: 'parent', workspace: config.workspace } });
  assert.equal(denied.error.code, 'bridge-auth-required');
  const result = await handler('capabilities', { args: { token: 'a'.repeat(64), sessionId: 'parent', workspace: config.workspace } });
  assert.equal(result.value.totalTools, 1);
  assert.equal(result.value.permissions.approval.policy, 'never');
  assert.equal(result.value.permissions.plan.active, true);
  assert.equal(JSON.stringify(result).includes('secret-not-exported'), false);
  assert.equal(f.calls(), 0);
  assert.equal(f.events.length, 0);
});

test('capability host rejects mutating methods and mismatched workspaces', async t => {
  const { config, root } = await setup(t);
  const foreign = path.join(root, 'foreign');
  await mkdir(foreign);
  const f = agentFixture(config.workspace);
  const handler = createHostHandler({ agents: { get: () => f.agent } }, 'a'.repeat(64));
  const args = { token: 'a'.repeat(64), sessionId: 'parent', workspace: foreign, selection: { provider: 'p', model: 'bad' } };
  assert.equal((await handler('capabilities', { args })).error.code, 'workspace-mismatch');
  assert.equal((await handler('selectModel', { args })).error.code, 'unknown-method');
  assert.equal(f.events.length, 0);
  assert.equal(f.callbacks.size, 0);
});

test('history cursor reads a cold ordinary session without resolving its Agent', async t => {
  const { config } = await setup(t);
  let inspected = 0;
  let resolved = 0;
  const controller = { inspect: async () => {
    inspected++;
    return { meta: { cwd: config.workspace }, events: [{ seq: 4 }, { seq: 8 }] };
  }, resolveAgent: async () => { resolved++; throw new Error('must not activate'); } };
  const handler = createHostHandler({ agents: { get: () => undefined }, get: key => key === 'sessionController' ? controller : undefined }, 'a'.repeat(64));
  const result = await handler('historyCursor', { args: { token: 'a'.repeat(64), sessionId: 'parent', workspace: config.workspace } });
  assert.deepEqual(result, { ok: true, value: { sessionId: 'parent', throughSeq: 8 } });
  assert.equal(inspected, 1);
  assert.equal(resolved, 0);
});

test('history cursor rejects another workspace and reports a genuinely empty session', async t => {
  const { config, root } = await setup(t);
  const foreign = path.join(root, 'foreign');
  await mkdir(foreign);
  const controller = { inspect: async () => ({ meta: { cwd: config.workspace }, events: [] }) };
  const handler = createHostHandler({ agents: { get: () => undefined }, get: key => key === 'sessionController' ? controller : undefined }, 'a'.repeat(64));
  assert.deepEqual(await handler('historyCursor', { args: { token: 'a'.repeat(64), sessionId: 'parent', workspace: config.workspace } }),
    { ok: true, value: { sessionId: 'parent', throughSeq: -1 } });
  assert.equal((await handler('historyCursor', { args: { token: 'a'.repeat(64), sessionId: 'parent', workspace: foreign } })).error.code, 'workspace-mismatch');
});

test('host installation preserves its token and refuses an unowned preset', async t => {
  const { config } = await setup(t);
  await installHostBridge(config);
  const before = await readFile(config.hostBridgeFile, 'utf8');
  await installHostBridge(config);
  assert.equal(await readFile(config.hostBridgeFile, 'utf8'), before);
  const other = { ...config, dataRoot: path.join(config.dataRoot, 'other') };
  await mkdir(path.join(other.dataRoot, '.agent-presets', 'codex-control-bridge'), { recursive: true });
  await assert.rejects(installHostBridge(other), /Unowned/);
});

test('new hosts use the published permission projection instead of the retired events argument', async t => {
  const { config } = await setup(t);
  const { agent } = agentFixture(config.workspace);
  const originalGet = agent.ctx.get;
  agent.ctx.get = key => key === 'permissionPresets'
    ? { names: ['read-only', 'workspace-write'], current: () => { throw new Error('new hosts require a Session'); } }
    : key === 'sessionProjections' ? { snapshot: () => ({ values: { permissions: { currentValue: 'read-only' } } }) }
      : originalGet(key);
  assert.deepEqual(capabilitySnapshot(agent).permissions.preset, { current: 'read-only', options: ['read-only', 'workspace-write'] });
});

test('legacy hosts without a permission projection retain the events-based API', async t => {
  const { config } = await setup(t);
  const { agent } = agentFixture(config.workspace);
  const originalGet = agent.ctx.get;
  agent.ctx.get = key => key === 'permissionPresets'
    ? { names: ['workspace-write'], current: events => { assert.equal(events, agent.session.events); return 'workspace-write'; } }
    : originalGet(key);
  assert.equal(capabilitySnapshot(agent).permissions.preset.current, 'workspace-write');
});

test('current Session objects need no public events array for selected model and plan state', async t => {
  const { config } = await setup(t);
  const { agent } = agentFixture(config.workspace);
  delete agent.session.events;
  const originalGet = agent.ctx.get;
  agent.ctx.get = key => key === 'sessionProjections' ? { snapshot: () => ({ values: {
    modelSelection: { next: { provider: 'fixture', model: 'flash', reasoningEffort: 'max' } },
    plan: { active: true, pending: false },
  } }) } : originalGet(key);
  const snapshot = capabilitySnapshot(agent);
  assert.deepEqual(snapshot.model, { provider: 'fixture', model: 'flash', reasoningEffort: 'max' });
  assert.equal(snapshot.permissions.plan.active, true);
});
