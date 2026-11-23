import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apply, createHostHandler, createManagedHost, CHILD_QUESTION_REFUSAL, ROOT_QUESTION_REFUSAL } from '../src/host-plugin.mjs';
import { pendingFeedback } from '../src/feedback-inbox.mjs';
import { installDesktopHostBridge, installHostBridge } from '../src/host-install.mjs';
import manifest from '../package.json' with { type: 'json' };

// Fixtures remain in the project's clean directory. No test deletes or moves files.
async function fixture() {
  const root = path.resolve('clean', '20261030-managed-host-tests', randomUUID());
  const workspace = path.join(root, 'project');
  const sessionRoot = path.join(root, 'sessions');
  await mkdir(workspace, { recursive: true });
  const stored = new Map(), live = new Map(), sessions = new Map(), records = new Map();
  const checkpoints = new Map(), indexed = new Set(), observed = new Map();
  const removed = [], disposed = [], cancelled = [], creations = [];
  const modelSelections = [], defaultSaves = [], imageAdmissions = [];
  const project = { id: 'project-1', path: workspace, sessionIds: [],
    async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id); },
    async detachSession(id) { this.sessionIds = this.sessionIds.filter(value => value !== id); } };
  const registry = { get: id => id === project.id ? project : undefined, list: () => [project],
    resolveByPath: async () => project, create: async () => project,
    unpinSession: async () => {}, unarchiveSession: async () => {}, headers: new Map(), sessionPaths: new Map() };
  const persistence = { name: 'session-persistence-jsonl', config: { root: sessionRoot }, coldLogMemo: new Map(),
    stat: async id => stored.has(id) ? { header: stored.get(id) } : undefined,
    resolveCurrentLog: async id => stored.has(id) ? path.join(sessionRoot, 'project', id, 'v4.jsonl') : undefined };
  const query = { _observations: { cache: observed }, _serialized: async (_signal, operation) => operation(), _ensureReady: async () => {},
    _reconcile: async () => { for (const id of indexed) if (!stored.has(id)) indexed.delete(id); },
    _requireDb: () => ({ prepare: () => ({ get: id => indexed.has(id) ? { id } : undefined }) }) };
  const services = {
    subagents: { listDescendants: async () => [], waitForChildren: async () => false, interrupt: () => {}, drainDescendants: async () => {} },
    sessionPersistence: persistence, workspaceRegistry: registry, sessionQuery: query,
    agentDefaultModel: { currentSelection: () => ({ provider: 'provider', model: 'model' }),
      saveSelection: async value => { defaultSaves.push(structuredClone(value)); } },
    llm: { listProviders: () => [{ id: 'provider' }, { id: 'other' }],
      listModels: async provider => provider === 'provider' ? [{ id: 'model' }, { id: 'second' }]
        : provider === 'other' ? [{ id: 'alpha' }] : [],
      resolveCallConfig: async value => value },
    sessionProjectionCache: { requireTable: () => ({ delete: async id => checkpoints.delete(id), get: id => checkpoints.get(id) }),
      flushSoft: async session => checkpoints.set(session.header.id, { oldContext: true }) },
    sessionController: { agents: { composeAgent: async preset => ({ agentPreset: preset ?? 'default', setup: async () => {} }),
        serializeImageAdmission: async (agent, operation) => { imageAdmissions.push(agent.id); return operation(); } },
      inspect: async id => ({ meta: stored.get(id), events: sessions.get(id)?.events ?? [] }) },
  };
  async function makeAgent(options, resume = false) {
    const id = options.sessionId ?? options.resumeSessionId;
    creations.push({ id, resume });
    const header = resume ? stored.get(id) : { id, cwd: options.meta.cwd };
    const callbacks = new Map();
    const definitions = new Map([
      ['subagent', { name: 'subagent', description: 'This tool starts an independently managed subagent' }],
      ['write_file', { name: 'write_file', description: 'Write a file' }],
    ]);
    const guards = [];
    const tools = { register: definition => definitions.set(definition.name, definition),
      get: name => definitions.get(name), guard: guard => guards.push(guard), schemas: () => [],
      view: () => ({ restrictableNames: new Set(definitions.keys()) }),
      restrict: ({ deny }) => deny.forEach(name => definitions.delete(name)) };
    const agent = { id, status: 'idle', options: options.agentOptions,
      session: { id, header, events: [] }, inbox: { nextTurn: [], nextStep: [] },
      cancel(cause) { cancelled.push({ id, cause }); this.inbox.nextTurn = []; this.inbox.nextStep = []; this.status = 'idle'; },
      async whenIdle() {},
      ctx: { get: name => name === 'tools' ? tools : services[name],
        on: (event, listener) => { const rows = callbacks.get(event) ?? []; rows.push(listener); callbacks.set(event, rows); } },
      definitions, guards, callbacks,
    };
    let modelState = options.agentOptions ? { ...options.agentOptions } : undefined;
    agent.model = { current: () => modelState ? { ...modelState } : undefined,
      select(selection) {
        modelState = { ...selection };
        modelSelections.push({ sessionId: id, selection: { ...selection } });
        agent.session.events.push({ type: 'model/selection', data: { ...selection } });
      } };
    await options.setup(agent.ctx, agent);
    live.set(id, agent); sessions.set(id, agent.session); stored.set(id, header);
    indexed.add(id); checkpoints.set(id, { context: 'private' });
    observed.set(id, { context: 'private' });
    await mkdir(path.join(sessionRoot, 'project', id), { recursive: true });
    return { agent, async dispose() { disposed.push(id); live.delete(id); sessions.delete(id); } };
  }
  const ownedBy = new Map();
  const ctx = { get: name => services[name], agents: { get: id => live.get(id), create: makeAgent,
    resume: options => makeAgent(options, true), isOwnedBy: (childId, parent) => ownedBy.get(childId) === parent },
    sessions: { get: id => sessions.get(id), flush: async () => {} } };
  const store = { read: async key => records.has(key) ? structuredClone(records.get(key)) : undefined,
    write: async (key, value) => records.set(key, structuredClone(value)), remove: async key => records.delete(key) };
  let failRemoval = false;
  const removeDirectory = async target => {
    if (failRemoval) { failRemoval = false; throw new Error('fixture cleanup failure'); }
    removed.push(target);
    stored.delete(path.basename(target));
  };
  return { root, workspace, ctx, services, store, removeDirectory, live, sessions, stored, records, project, checkpoints, indexed, observed, removed, disposed, cancelled, creations,
    modelSelections, defaultSaves, imageAdmissions,
    failNextRemoval: () => { failRemoval = true; },
    own: (childId, parent) => ownedBy.set(childId, parent),
    create: (context = ctx, options = {}) => createManagedHost(context, { stateDirectory: path.join(root, 'managed'), store, removeDirectory,
      installDelegation: async agentCtx => { agentCtx.get('tools').register({name:'managed_subagent'}); }, ...options }) };
}

const identity = workspace => ({ ownerId: 'owner-a', agentId: 'agent-a', sessionId: 'session-managed-a', workspace, treeProtocol: 1, reportProtocol: 1 });

test('managed status exposes the live selection instead of its creation snapshot', async () => {
  const f = await fixture(), input = identity(f.workspace), host = f.create();
  await host.managedCreate(input);
  let selection = { provider: 'new-provider', model: 'new-model', reasoningEffort: 'max' };
  f.services.sessionProjections = { snapshot: () => ({ values: { modelSelection: { next: selection } } }) };
  const started = await host.managedBeginTask({ ...input, taskId: 'task-model' });
  assert.deepEqual(started.currentModel, selection);
  assert.equal(started.model.provider, 'provider', 'creation snapshot remains distinct');
  selection = { provider: 'third-provider', model: 'third-model' };
  assert.deepEqual((await host.managedStatus({ ...input, taskId: 'task-model' })).currentModel, selection);
});

test('managed explicit model selection changes only the named session and never the app default', async () => {
  const f = await fixture(), host = f.create();
  const a = identity(f.workspace);
  const b = { ...identity(f.workspace), agentId: 'agent-b', sessionId: 'session-managed-b' };
  await host.managedCreate(a);
  await host.managedCreate(b);
  const selection = { provider: 'other', model: 'alpha', reasoningEffort: 'high' };
  const result = await host.managedSelectModel({ ...a, selection });
  assert.equal(result.accepted, true);
  assert.deepEqual(result.selected, selection);
  assert.equal(result.source, 'managed-session-selectModel');
  assert.match(result.defaultModelBehavior, /unchanged/);
  assert.deepEqual(f.modelSelections, [{ sessionId: a.sessionId, selection }], 'the real Agent model primitive was called');
  assert.deepEqual(f.defaultSaves, [], 'the app-wide default is never saved');
  assert.deepEqual(f.services.agentDefaultModel.currentSelection(), { provider: 'provider', model: 'model' });
  assert.deepEqual(f.live.get(a.sessionId).model.current(), selection);
  assert.deepEqual(f.live.get(b.sessionId).model.current(), { provider: 'provider', model: 'model' },
    'another managed name keeps its own selection');
  assert.deepEqual((await host.managedStatus(a)).currentModel, selection);
  assert.deepEqual(f.imageAdmissions, [a.sessionId], 'selection runs through DSH image-admission serialization');

  await assert.rejects(host.managedSelectModel({ ...a, selection: { provider: 'other', model: 'missing' } }),
    error => error.controlCode === 'managed-model-unavailable');
  await assert.rejects(host.managedSelectModel({ ...a, sessionId: 'session-other', selection }),
    error => error.controlCode === 'managed-session-mismatch');
  assert.equal(f.defaultSaves.length, 0);
});

test('a bridge locked to the default model refuses every other session selection', async () => {
  const f = await fixture(), host = f.create(undefined, { defaultModelOnly: true }), input = identity(f.workspace);
  await host.managedCreate(input);
  await assert.rejects(host.managedSelectModel({ ...input, selection: { provider: 'other', model: 'alpha' } }),
    error => error.controlCode === 'managed-model-locked');
  await assert.rejects(host.managedSelectModel({ ...input, selection: { provider: 'provider', model: 'model', reasoningEffort: 'max' } }),
    error => error.controlCode === 'managed-model-locked', 'the default model with another effort is another choice');
  assert.deepEqual(f.modelSelections, [], 'no refused choice reached the Agent');
  const same = await host.managedSelectModel({ ...input, selection: { provider: 'provider', model: 'model' } });
  assert.equal(same.accepted, true, 'the default itself stays selectable');

  // A default with an effort: that effort and an older pin that names none both pass.
  f.services.agentDefaultModel.currentSelection = () => ({ provider: 'provider', model: 'model', reasoningEffort: 'high' });
  assert.equal((await host.managedSelectModel({ ...input, selection: { provider: 'provider', model: 'model', reasoningEffort: 'high' } })).accepted, true);
  assert.equal((await host.managedSelectModel({ ...input, selection: { provider: 'provider', model: 'model' } })).accepted, true,
    'a pin saved without an effort is still the default model');
  await assert.rejects(host.managedSelectModel({ ...input, selection: { provider: 'provider', model: 'model', reasoningEffort: 'max' } }),
    error => error.controlCode === 'managed-model-locked');
  assert.equal(f.defaultSaves.length, 0);
});

test('managed explicit model selection refuses a host that did not record the requested route', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  f.live.get(input.sessionId).model.select = () => {};
  await assert.rejects(host.managedSelectModel({ ...input,
    selection: { provider: 'other', model: 'alpha' } }),
  error => error.controlCode === 'managed-model-selection-unconfirmed');
  assert.equal(f.defaultSaves.length, 0, 'a failed read-back never writes the global default');
});

test('explicit reports persist across reload and final seals reporting', async () => {
  const f = await fixture(), input = identity(f.workspace), host = f.create();
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  const agent = f.live.get(input.sessionId), report = agent.definitions.get('report_parent');
  let ended = 0;
  const exec = { agent, concludeTurn: () => { ended++; } };
  await report.execute({ message: 'progress' }, exec);
  await report.execute({ message: 'delivery', final: true }, exec);
  await assert.rejects(report.execute({ message: 'extra' }, exec), error => error.controlCode === 'managed-report-finalized');
  await assert.rejects(agent.definitions.get('ask_parent').execute({ message: 'late question' }, exec), error => error.controlCode === 'managed-report-finalized');
  await assert.rejects(report.execute({ message: 'other' }, { ...exec, agent: { id: 'child' } }), error => error.controlCode === 'managed-task-closed');
  assert.equal(ended, 1);
  const reloaded = f.create();
  const reports = (await reloaded.managedStatus({ ...input, taskId: 'task-a' })).reports;
  assert.deepEqual(reports.map(({ message, final }) => ({ message, final })), [{ message: 'progress', final: false }, { message: 'delivery', final: true }]);
  assert.equal(new Set(reports.map(item => item.id)).size, 2);
  await assert.rejects(reloaded.managedStatus({ ...input, reportProtocol: undefined }), error => error.controlCode === 'managed-report-protocol-required');
  await assert.rejects(reloaded.managedDestroy({ ...input, reportProtocol: undefined }), error => error.controlCode === 'managed-report-protocol-required');
});

test('managed feedback records bound task context and recent report failure while waiting', async () => {
  const f = await fixture(), input = identity(f.workspace), configFile = path.join(f.root, 'config.json');
  await writeFile(configFile, '{}');
  const host = f.create(f.ctx, { feedbackNode: process.execPath, feedbackConfigFile: configFile });
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a', feedbackAgentName: '测试助手', feedbackCallerHost: 'codex' });
  const agent = f.live.get(input.sessionId), exec = { agent, concludeTurn() {} };
  await assert.rejects(agent.definitions.get('report_parent').execute({ message: '  ' }, exec), e => e.controlCode === 'invalid-report');
  await agent.definitions.get('ask_parent').execute({ message: '需要决定' }, exec);
  assert.equal(agent.guards.map(guard => guard({ agent, name: 'feedback' })).find(Boolean), undefined);
  const receipt = await agent.definitions.get('feedback').execute({ kind: 'problem', message: '报告空白未通过' }, exec);
  assert.equal(receipt.saved, true);
  const [row] = pendingFeedback(configFile);
  assert.deepEqual({ source: row.occurrences[0].source, caller: row.occurrences[0].caller, target: row.occurrences[0].target, name: row.occurrences[0].name, version: row.occurrences[0].version },
    { source: 'dsh', caller: 'codex', target: 'dsh', name: '测试助手', version: manifest.version });
  assert.equal(row.occurrences[0].error.tool, 'report_parent');
  assert.equal(row.occurrences[0].error.code, 'invalid-report');
  await assert.rejects(agent.definitions.get('feedback').execute({ kind: 'problem', message: 'x' }, { agent: {} }), e => e.controlCode === 'managed-task-closed');
});

test('feedback native hooks preserve awaiting-answer and never persist feedback arguments or result', async () => {
  const f = await fixture(), input = identity(f.workspace), configFile = path.join(f.root, 'config.json');
  await writeFile(configFile, '{}');
  const host = f.create(f.ctx, { feedbackNode: process.execPath, feedbackConfigFile: configFile });
  await host.managedCreate(input); await host.managedBeginTask({ ...input, taskId: 'task-hooks' });
  const agent = f.live.get(input.sessionId), exec = { agent, name: 'feedback', concludeTurn() {} };
  await agent.definitions.get('ask_parent').execute({ message: '需要决定' }, exec);
  const before = await host.managedStatus(input);
  assert.equal(before.activity, 'awaiting-answer');
  const secret = 'e9'.repeat(32), feedbackInput = { kind: 'problem', message: `普通文字 token=${secret}` };
  const pre = agent.callbacks.get('tools/pre-execute')[0], resultHook = agent.callbacks.get('tools/result')[0];
  const receipt = await pre({ ...exec, args: feedbackInput }, () => agent.definitions.get('feedback').execute(feedbackInput, exec));
  assert.equal(receipt.saved, true);
  resultHook({ ...exec, args: feedbackInput }, { value: { ...receipt, path: path.join(f.workspace, 'should-not-be-change'), operation: 'update', after: secret } });
  // DSH may emit a generic session event too; that observer may persist only the cursor.
  agent.callbacks.get('session/event')[0](agent.session, { type: 'tool/call', seq: 42, data: { args: feedbackInput, result: secret } });
  const after = await host.managedStatus(input);
  assert.equal(after.activity, 'awaiting-answer');
  assert.deepEqual(after.questions, before.questions); assert.deepEqual(after.reports, before.reports);
  assert.deepEqual(after.changes, before.changes);
  const persisted = JSON.stringify([...f.records.values()]);
  assert.equal(persisted.includes(secret), false); assert.equal(persisted.includes('普通文字'), false);
  assert.equal(persisted.includes(receipt.id), false); assert.equal(persisted.includes('should-not-be-change'), false);
});

test('legacy managed bridge returns feedback unavailable without affecting reports', async () => {
  const f = await fixture(), input = identity(f.workspace), host = f.create();
  await host.managedCreate(input); await host.managedBeginTask({ ...input, taskId: 'task-a' });
  const agent = f.live.get(input.sessionId), exec = { agent, concludeTurn() {} };
  assert.deepEqual(await agent.definitions.get('feedback').execute({ kind: 'problem', message: '问题' }, exec), { saved: false, code: 'feedback-unavailable' });
  assert.equal((await agent.definitions.get('report_parent').execute({ message: '正常报告' }, exec)).accepted, true);
});

test('installed Desktop and preset bridge configurations actually load and write feedback through the host route', async () => {
  for (const mode of ['desktop', 'preset']) {
    const f = await fixture(), configFile = path.join(f.root, 'config.json');
    const config = { hostBridgeFile: path.join(f.root, 'private', 'bridge.json'), configFile, dataRoot: path.join(f.root, 'dsh') };
    await writeFile(configFile, '{}');
    let entry;
    if (mode === 'desktop') {
      const profile = path.join(f.root, 'desktop'); await mkdir(profile);
      await writeFile(path.join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-web-app'] } } }));
      await writeFile(path.join(profile, 'cordis.patch.yml'), '[]\n');
      await installDesktopHostBridge(config, profile);
      const patch = await readFile(path.join(profile, 'cordis.patch.yml'), 'utf8');
      const scalar = key => JSON.parse(patch.match(new RegExp(`^\\s+${key}:\\s*("[^\\r\\n]+")$`, 'm'))[1]);
      entry = { name: scalar('name'), config: { credentialFile: scalar('credentialFile'), feedbackNode: scalar('feedbackNode'), feedbackConfigFile: scalar('feedbackConfigFile') } };
    } else {
      const installed = await installHostBridge(config);
      [entry] = JSON.parse(await readFile(path.join(installed.presetDirectory, 'agent.cordis.yml'), 'utf8'));
    }
    const module = await import(entry.name);
    assert.equal(new URL(entry.name).protocol, 'file:');
    const delegationEntry = { options: { name: '@deepseek-ai/dsh-tool-subagent' }, moduleNamespace: {}, fiber: { config: { provider: 'fixture' } } };
    f.services.agentPresets = { generationFor: () => ({ mount: { tree: { entries: () => [delegationEntry] } } }) };
    f.services.loader = { unwrapExports: value => value };
    f.services.sessionController.agents.composeAgent = async () => ({ agentPreset: 'fixture', setup: async agentCtx => { agentCtx.plugin = () => ({ await: async () => {} }); } });
    let handler;
    const ctx = { ...f.ctx, root: f.ctx, effect() {}, connection: { register(_owner, _route, fn) { handler = fn; return () => {}; } } };
    await module.apply(ctx, entry.config);
    const { token } = JSON.parse(await readFile(entry.config.credentialFile, 'utf8'));
    const input = identity(f.workspace), call = async (method, args) => {
      const response = await handler(method, { args: { ...args, token } });
      assert.equal(response.ok, true, JSON.stringify(response)); return response.value;
    };
    await call('managedCreate', input);
    await call('managedBeginTask', { ...input, taskId: 'task-installed', feedbackAgentName: `安装-${mode}`, feedbackCallerHost: 'codex' });
    const agent = f.live.get(input.sessionId), exec = { agent, concludeTurn() {} };
    const receipt = await agent.definitions.get('feedback').execute({ kind: 'friction', message: `安装桥 ${mode}` }, exec);
    assert.equal(receipt.saved, true);
    const [row] = pendingFeedback(configFile);
    assert.equal(row.id, receipt.id); assert.equal(row.occurrences[0].name, `安装-${mode}`);
    assert.equal(row.occurrences[0].caller, 'codex');
  }
});

test('bridge reload adds feedback to a preexisting binding and respects task lifecycle', async () => {
  const f = await fixture(), input = identity(f.workspace), configFile = path.join(f.root, 'config.json');
  await writeFile(configFile, '{}');
  const first = f.create();
  await first.managedCreate(input); await first.managedBeginTask({ ...input, taskId: 'old-task' });
  const agent = f.live.get(input.sessionId), exec = { agent, concludeTurn() {} };
  const runtime = [...f.ctx[Symbol.for('futureaide-control.managed-runtimes')].values()][0];
  const binding = [...runtime.bindings.values()][0];
  // Emulate a live agent created by the previous bridge revision.
  delete binding.feedbackRegistered; delete binding.feedbackTool; agent.definitions.delete('feedback');
  const reloaded = f.create(f.ctx, { feedbackNode: process.execPath, feedbackConfigFile: configFile });
  assert.ok(agent.definitions.has('feedback'));
  assert.equal(f.creations.length, 1);
  await reloaded.managedBeginTask({ ...input, taskId: 'old-task', feedbackAgentName: '热载助手', feedbackCallerHost: 'codex' });
  await assert.rejects(agent.definitions.get('report_parent').execute({ message: '  ' }, exec), e => e.controlCode === 'invalid-report');
  await agent.definitions.get('ask_parent').execute({ message: '等答复' }, exec);
  assert.equal(agent.guards.map(fn => fn({ agent, name: 'feedback' })).find(Boolean), undefined);
  const feedback = agent.definitions.get('feedback');
  assert.equal((await feedback.execute({ kind: 'problem', message: '热载后的问题' }, exec)).saved, true);
  let rows = pendingFeedback(configFile);
  assert.equal(rows[0].occurrences[0].name, '热载助手');
  assert.equal(rows[0].occurrences[0].error.code, 'invalid-report');
  await reloaded.managedAnswer({ ...input, taskId: 'old-task', answerId: 'answer', message: '继续' });
  await reloaded.managedBeginTask({ ...input, taskId: 'new-task' });
  assert.equal((await feedback.execute({ kind: 'problem', message: '新任务问题' }, exec)).saved, true);
  rows = pendingFeedback(configFile);
  assert.equal(rows.find(row => row.occurrences[0].message === '新任务问题').occurrences[0].error, null);
  await agent.definitions.get('report_parent').execute({ message: '完成', final: true }, exec);
  await assert.rejects(feedback.execute({ kind: 'problem', message: '完成之后' }, exec), e => e.controlCode === 'managed-task-required');
  await reloaded.managedCancel({ ...input, taskId: 'new-task' });
  await assert.rejects(feedback.execute({ kind: 'problem', message: '取消之后' }, exec), e => e.controlCode === 'managed-task-closed');
  assert.equal(pendingFeedback(configFile).length, 2);
});

test('a final is refused while a steer input still waits for the model’s next step', async () => {
  const f = await fixture(), input = identity(f.workspace), host = f.create();
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  const agent = f.live.get(input.sessionId), report = agent.definitions.get('report_parent');
  let ended = 0;
  const exec = { agent, concludeTurn: () => { ended++; } };
  agent.inbox.nextStep.push({ id: 'steer-1', content: 'new input' });
  await assert.rejects(report.execute({ message: 'delivery', final: true }, exec), error => {
    assert.equal(error.controlCode, undefined, 'the model receives a plain error, not a protocol refusal');
    assert.match(error.message, /new input/i);
    assert.match(error.message, /before submitting this final report/i);
    return true;
  });
  assert.deepEqual((await host.managedStatus({ ...input, taskId: 'task-a' })).reports, [], 'the refused final was not recorded');
  assert.equal(ended, 0, 'the turn is not concluded while the input is unread');
  await report.execute({ message: 'progress' }, exec);
  assert.deepEqual((await host.managedStatus({ ...input, taskId: 'task-a' })).reports.map(item => item.final), [false],
    'a non-final progress report is unaffected');
  agent.inbox.nextStep.length = 0;
  agent.inbox.nextTurn.push({ id: 'queued' });
  await report.execute({ message: 'delivery', final: true }, exec);
  assert.equal(ended, 1);
  assert.deepEqual((await host.managedStatus({ ...input, taskId: 'task-a' })).reports.map(item => [item.message, item.final]),
    [['progress', false], ['delivery', true]], 'an input that only waits for the next turn never blocks a final');
});

test('tree completion waits for a task turn and descendant result before returning the final root turn', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  const agent = f.live.get(input.sessionId);
  agent.session.seq = 0;
  let release;
  f.services.subagents.listDescendants = async () => [{kind:'child',id:'child',parentId:input.sessionId,label:'helper',mode:'continuable'}];
  f.services.subagents.waitForChildren = () => new Promise(resolve => { release = resolve; });
  await host.managedBeginTask({ ...input, taskId:'task-a' });
  assert.equal((await host.managedStatus(input)).tree.settled, false);
  agent.session.events.push({seq:0,type:'turn/start'}, {seq:1,type:'assistant/message',data:{message:{content:[{type:'text',text:'initial'}]}}}, {seq:2,type:'turn/end'});
  agent.callbacks.get('session/event')[0](agent.session, agent.session.events.at(-1));
  agent.session.seq = 3;
  assert.equal((await host.managedStatus(input)).tree.settled, false);
  await new Promise(resolve => setImmediate(resolve));
  agent.session.events.push({seq:3,type:'turn/start'}, {seq:4,type:'assistant/message',data:{message:{content:[{type:'text',text:'final summary'}]}}}, {seq:5,type:'turn/end'});
  agent.callbacks.get('session/event')[0](agent.session, agent.session.events.at(-1));
  agent.session.seq = 6;
  release(true);
  await new Promise(resolve => setImmediate(resolve));
  release(false);
  await new Promise(resolve => setImmediate(resolve));
  const final = await host.managedStatus(input);
  assert.equal(final.tree.settled, true);
  assert.deepEqual(final.tree.rootSummary, {ready:true,reply:'final summary',state:'completed'});
  agent.session.seq = 7;
  assert.equal((await host.managedStatus(input)).tree.settled, false);
});

test('legacy tasks remain leaf-only and cannot downgrade an upgraded record', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  const legacy = { ...input, treeProtocol: undefined, taskId: 'task-a' };
  assert.equal((await host.managedBeginTask(legacy)).treeProtocol, undefined);
  const agent = f.live.get(input.sessionId);
  assert.match(agent.guards[0]({ agent, name: 'managed_subagent' }), /reload/);
  assert.equal(agent.guards[0]({ agent, name: 'write_file' }), undefined);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  await assert.rejects(host.managedBeginTask(legacy), error => error.controlCode === 'managed-tree-protocol-required');
});

test('managed creation spends no model turn, binds project, and exposes delegation in the owned scope', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  const created = await host.managedCreate(input);
  assert.equal(created.modelRequestsStarted, 0);
  assert.deepEqual(f.project.sessionIds, [input.sessionId]);
  const agent = f.live.get(input.sessionId);
  assert.equal(agent.definitions.has('ask_parent'), true);
  assert.equal(agent.definitions.has('subagent'), true);
  assert.equal(agent.definitions.has('managed_subagent'), true);
  assert.equal(agent.definitions.has('write_file'), true);
  assert.deepEqual(agent.session.events, []);
  assert.equal((await host.managedCreate(input)).sessionId, input.sessionId);
  await assert.rejects(host.managedStatus({ ...input, ownerId: 'other-owner' }), error => error.controlCode === 'managed-agent-not-found');
  await assert.rejects(host.managedStatus({ ...input, sessionId: 'another-session' }), error => error.controlCode === 'managed-session-mismatch');
});

test('managed history reads only an authorized node in the durable tree', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  assert.deepEqual((await host.managedHistory({ ...input, targetSessionId: input.sessionId })).events, []);
  assert.equal((await host.managedStatus({ ...input, treeProtocol: undefined })).taskId, null);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  f.services.subagents.listDescendants = async () => [{ kind: 'child', id: 'child', parentId: input.sessionId, mode: 'continuable' }];
  f.services.sessionController.inspect = async id => ({ events: [{ seq: 0, type: 'assistant/message', data: { id } }] });
  assert.equal((await host.managedHistory({ ...input, targetSessionId: 'child' })).events[0].data.id, 'child');
  await assert.rejects(host.managedHistory({ ...input, targetSessionId: 'other' }), error => error.controlCode === 'managed-session-mismatch');
  await assert.rejects(host.managedHistory({ ...input, targetSessionId: 'child', treeProtocol: undefined }), error => error.controlCode === 'managed-tree-protocol-required');
});

test('question and answer carry text directly, conclude the waiting turn, and answer retries do not repeat consumption', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  await assert.rejects(host.managedStatus({ ...input, treeProtocol: undefined }), error => error.controlCode === 'managed-tree-protocol-required');
  await assert.rejects(host.managedDestroy({ ...input, treeProtocol: undefined }), error => error.controlCode === 'managed-tree-protocol-required');
  assert.deepEqual(f.disposed, []);
  const agent = f.live.get(input.sessionId);
  let concluded = 0;
  await agent.definitions.get('ask_parent').execute({ message: '第一行\n是否保留 "中文" 标注？' }, { agent, concludeTurn: () => { concluded++; } });
  const waiting = await host.managedStatus(input);
  assert.equal(waiting.questions[0].state, 'pending');
  assert.equal(concluded, 1);
  assert.match(agent.guards[0]({ agent, name: 'write_file' }), /Wait/);
  const answerInput = { ...input, taskId: 'task-a', answerId: 'answer-a', message: '保留\n并标出入口。' };
  const answer = await host.managedAnswer(answerInput);
  assert.deepEqual(await host.managedAnswer(answerInput), answer);
  assert.equal(answer.consumedQuestionIds.length, 1);
  assert.match(answer.continuation, /保留/);
  assert.equal(agent.guards[0]({ agent, name: 'write_file' }), undefined);
  await assert.rejects(host.managedAnswer({ ...answerInput, message: 'different' }), error => error.controlCode === 'managed-answer-conflict');
  await host.managedBeginTask({ ...input, taskId: 'task-b' });
  assert.equal((await host.managedStatus(input)).questions.length, 0);
});

test('native sequence cursors do not require reading a public full events array', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  const agent = f.live.get(input.sessionId);
  delete agent.session.events;
  agent.session.seq = 12;
  assert.equal((await host.managedBeginTask({ ...input, taskId: 'task-a' })).throughSeq, 11);
  agent.session.seq = 15;
  assert.equal((await host.managedStatus(input)).throughSeq, 14);
});

test('file observations are attributed to the executing agent and task, while coverage stays explicit', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  const agent = f.live.get(input.sessionId);
  const result = agent.callbacks.get('tools/result')[0];
  result({ agent, name: 'write_file' }, { value: { path: path.join(f.workspace, 'diagram.svg'), operation: 'create', before: null, after: '<svg />' } });
  result({ agent: { id: 'other-agent' }, name: 'write_file' }, { value: { path: path.join(f.workspace, 'other.md'), operation: 'create' } });
  result({ agent, name: 'write_file' }, { isError: true, value: { path: path.join(f.workspace, 'failed.md'), operation: 'create' } });
  const status = await host.managedStatus(input);
  assert.equal(status.changes.length, 1);
  assert.equal(status.changes[0].attribution, 'confirmed');
  assert.equal(status.coverage.complete, false);
  await host.managedBeginTask({ ...input, taskId: 'task-b' });
  assert.equal((await host.managedStatus(input)).changes.length, 0);
});

test('cancel clears pending input and questions but retains the reusable session', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  const agent = f.live.get(input.sessionId);
  await agent.definitions.get('ask_parent').execute({ message: '继续吗？' }, { agent, concludeTurn() {} });
  agent.inbox.nextTurn.push({ id: 'pending' });
  const requestCancel = agent.cancel.bind(agent);
  agent.cancel = cause => { requestCancel(cause); agent.status = 'running'; };
  agent.whenIdle = () => { throw new Error('cancel must not wait on the ongoing model request'); };
  const cancelled = await host.managedCancel({ ...input, taskId: 'task-a' });
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.cancelRequested, true);
  assert.equal(cancelled.pendingInputCleared, true);
  assert.equal(cancelled.running, true);
  assert.deepEqual(agent.inbox.nextTurn, []);
  assert.deepEqual(f.disposed, [input.sessionId]);
  assert.equal(f.stored.has(input.sessionId), true);
  assert.equal(cancelled.questions[0].state, 'cancelled');
  await assert.rejects(host.managedAnswer({ ...input, message: '继续' }), error => error.controlCode === 'managed-task-closed');
});

test('cleanup failure keeps its record, retries release only once, and a lost success response is idempotent', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  f.failNextRemoval();
  await assert.rejects(host.managedDestroy(input), /fixture cleanup failure/);
  assert.equal(f.records.size, 1);
  assert.deepEqual(f.disposed, [input.sessionId]);
  assert.equal((await host.managedStatus(input)).status, 'cleaning');
  const result = await host.managedDestroy(input);
  assert.equal(result.destroyed, true);
  assert.equal(f.records.size, 0);
  assert.equal(f.checkpoints.has(input.sessionId), false);
  assert.equal(f.observed.has(input.sessionId), false);
  // The search index reconciles itself before answering, so a stale row may outlive
  // the delete; it must neither keep the name alive nor make cleanup look unfinished.
  assert.equal(f.indexed.has(input.sessionId), true);
  assert.deepEqual(f.project.sessionIds, []);
  assert.deepEqual(f.disposed, [input.sessionId]);
  assert.equal(f.removed.length, 1);
  assert.equal((await host.managedDestroy(input)).alreadyDestroyed, true);
  // The injected deletion adapter records the exact native directory; it does not delete fixture files.
  assert.equal(path.basename(f.removed[0]), input.sessionId);
});

test('a retry cannot claim a finished delete when the host can no longer verify it', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  await host.managedDestroy(input);
  f.services.sessionQuery._observations = {};
  await assert.rejects(host.managedDestroy(input), error => error.controlCode === 'managed-cleanup-verification-unavailable');
});

test('destroy never queues behind the search index and tolerates a stale index row', async () => {
  const f = await fixture(), host = f.create(), input = identity(f.workspace);
  await host.managedCreate(input);
  let reconciled = 0;
  // The shared query queue never answers: destroy must not need it.
  f.services.sessionQuery._serialized = () => new Promise(() => {});
  f.services.sessionQuery._reconcile = async () => { reconciled++; };
  const guard = new Promise((_, reject) => setTimeout(() => reject(new Error('destroy waited for the search index')), 2000).unref());
  const result = await Promise.race([host.managedDestroy(input), guard]);
  assert.equal(result.destroyed, true);
  assert.equal(reconciled, 0, 'reconciliation is the search path’s job, not cleanup’s');
  assert.equal(f.observed.has(input.sessionId), false, 'the live observation is still dropped');
  assert.equal(f.indexed.has(input.sessionId), true, 'the derived row stays for the next search to reconcile');
  const retried = await Promise.race([host.managedDestroy(input), guard]);
  assert.equal(retried.alreadyDestroyed, true, 'a stale index row cannot keep the name alive');
  assert.equal(reconciled, 0);
});

test('interrupted cleanup rebuilds its plan from the cold durable tree without resuming an agent', async () => {
  const f = await fixture(), input = identity(f.workspace);
  await f.create().managedCreate(input);
  for (const record of f.records.values()) record.closing = true;
  f.live.clear(); f.sessions.clear();
  const restartedRoot = { get: f.ctx.get, agents: f.ctx.agents, sessions: f.ctx.sessions };
  const result = await f.create(restartedRoot).managedDestroy(input);
  assert.equal(result.destroyed, true);
  assert.equal(f.creations.length, 1);
  assert.equal(f.records.size, 0);
});

test('host restart resumes the same durable agent with its question, without a model turn', async () => {
  const f = await fixture(), input = identity(f.workspace);
  const first = f.create();
  await first.managedCreate(input);
  await first.managedBeginTask({ ...input, taskId: 'task-a' });
  const agent = f.live.get(input.sessionId);
  await agent.definitions.get('ask_parent').execute({ message: '恢复后仍需回答' }, { agent, concludeTurn() {} });
  f.live.clear();
  f.sessions.clear();
  const restartedRoot = { get: f.ctx.get, agents: f.ctx.agents, sessions: f.ctx.sessions };
  const resumed = await f.create(restartedRoot).managedStatus(input);
  assert.equal(resumed.sessionId, input.sessionId);
  assert.equal(resumed.questions[0].message, '恢复后仍需回答');
  assert.equal(f.live.get(input.sessionId).session.events.length, 0);
  assert.deepEqual(f.creations.map(item => item.resume), [false, true]);
});

test('bridge reload keeps root-owned handles, shared queues and current scoped observers', async () => {
  const f = await fixture(), input = identity(f.workspace);
  const context = () => ({ root: f.ctx, get: f.ctx.get, sessions: f.ctx.sessions,
    agents: { get: f.ctx.agents.get,
      create() { throw new Error('a replaceable bridge fiber must not own a native Agent'); },
      resume() { throw new Error('a replaceable bridge fiber must not own a native Agent'); } } });
  const first = f.create(context());
  await first.managedCreate(input);
  await first.managedBeginTask({ ...input, taskId: 'task-a' });
  const agent = f.live.get(input.sessionId);
  const questionTool = agent.definitions.get('ask_parent');
  await questionTool.execute({ message: '热更前的问题' }, { agent, concludeTurn() {} });

  const writing = Promise.withResolvers(), release = Promise.withResolvers();
  const save = f.store.write;
  f.store.write = async (key, value) => {
    if (value.activity === 'answer-ready') { writing.resolve(); await release.promise; }
    return save(key, value);
  };
  const answer = first.managedAnswer({ ...input, taskId: 'task-a', answerId: 'answer-a', message: '继续' });
  await writing.promise;
  const reloaded = f.create(context());
  let began = false;
  const next = reloaded.managedBeginTask({ ...input, taskId: 'task-b' }).then(value => { began = true; return value; });
  await new Promise(setImmediate);
  assert.equal(began, false, 'new handlers share the in-flight per-agent operation queue');
  release.resolve();
  await answer;
  await next;

  await questionTool.execute({ message: '热更后的问题' }, { agent, concludeTurn() {} });
  agent.callbacks.get('tools/result')[0]({ agent, name: 'write_file' },
    { value: { path: path.join(f.workspace, 'after-reload.svg'), operation: 'create', before: null, after: '<svg />' } });
  const status = await reloaded.managedStatus(input);
  assert.equal(status.questions[0].taskId, 'task-b');
  assert.equal(status.questions[0].message, '热更后的问题');
  assert.equal(status.changes.length, 1);
  assert.equal(f.live.get(input.sessionId), agent);
  assert.equal(f.creations.length, 1);
  assert.deepEqual(f.disposed, []);
  assert.equal(agent.guards.length, 1);
  for (const listeners of agent.callbacks.values()) assert.equal(listeners.length, 1);
});

test('host publishes private discovery directly and keeps its process instance identity across reloads', async () => {
  const f = await fixture();
  const credentialFile = path.join(f.root, 'credential.json');
  const discoveryFile = path.join(f.root, 'instance.json');
  await writeFile(credentialFile, JSON.stringify({ token: 'a'.repeat(64) }));
  const root = {};
  const context = () => ({ root, effect() {}, webServer: { port: 12345 },
    connection: { register() { return () => {}; }, authenticatedUrl: async origin => `${origin}/?token=private-token` } });
  await apply(context(), { credentialFile, discoveryFile, dataRoot: f.root });
  const first = JSON.parse(await readFile(discoveryFile, 'utf8'));
  const ping = () => root[Symbol.for('futureaide-control.host-handler')].handler('ping', { args: { token: 'a'.repeat(64) } });
  assert.equal((await ping()).value.revision, null);
  const revision = '1234567890abcdef';
  const revised = await import(`../src/host-plugin.mjs?v=${revision}`);
  await revised.apply(context(), { credentialFile, discoveryFile, dataRoot: f.root });
  const second = JSON.parse(await readFile(discoveryFile, 'utf8'));
  assert.equal((await ping()).value.revision, revision);
  assert.equal(first.instanceId, second.instanceId);
  assert.equal(first.application, 'dsh');
  assert.equal(first.dataRoot, f.root);
  assert.equal(first.pid, process.pid);
});

// DSH 0.2.2 dropped sessionController.inspect; the query service reads the same
// stored session. Nothing else about the fixture changes.
function newHostShape(f) {
  delete f.services.sessionController.inspect;
  f.services.sessionQuery.readSession = async id => ({ session: f.stored.get(id), events: f.sessions.get(id)?.events ?? [] });
  f.services.sessionController.resolveAgent = async id =>
    ({ agent: (await f.ctx.agents.resume({ resumeSessionId: id, setup: async () => {} })).agent });
}

test('a host without sessionController.inspect resumes, reads, and deletes through the query service', async () => {
  const f = await fixture(), input = identity(f.workspace);
  newHostShape(f);
  const host = f.create();
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  const agent = f.live.get(input.sessionId);
  agent.session.events.push({ seq: 0, type: 'turn/start' },
    { seq: 1, type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first reply' }] } } },
    { seq: 2, type: 'turn/end', data: { reason: { kind: 'completed' } } });
  agent.session.seq = 3;

  // Tree inspection reads the stored events.
  assert.equal((await host.managedStatus(input)).tree.running, false);

  // History reads one node of the durable tree.
  f.services.subagents.listDescendants = async () => [{ kind: 'child', id: 'child', parentId: input.sessionId, mode: 'continuable' }];
  f.stored.set('child', { id: 'child', cwd: f.workspace });
  f.sessions.set('child', { events: [{ seq: 0, type: 'assistant/message', data: { id: 'child' } }] });
  assert.deepEqual((await host.managedHistory({ ...input, targetSessionId: 'child' })).events,
    [{ seq: 0, type: 'assistant/message', data: { id: 'child' } }]);

  // The bridge endpoints read the same way.
  const handler = createHostHandler(f.ctx, 'a'.repeat(64),
    { stateDirectory: path.join(f.root, 'managed'), store: f.store, removeDirectory: f.removeDirectory });
  const cursor = await handler('historyCursor', { args: { token: 'a'.repeat(64), sessionId: input.sessionId, workspace: f.workspace } });
  assert.equal(cursor.ok, true, JSON.stringify(cursor));
  assert.equal(cursor.value.throughSeq, 2);

  // Activation recovers a cold session from its stored header.
  f.live.delete(input.sessionId);
  f.live.delete(input.sessionId);
  const activated = await handler('capabilities', { args: { token: 'a'.repeat(64), sessionId: input.sessionId,
    workspace: f.workspace, activate: true } });
  assert.equal(activated.ok, true, JSON.stringify(activated));
  assert.equal(activated.value.activated, true);
  assert.equal(activated.value.sessionId, input.sessionId);

  // Cleanup reads a descendant's stored header before removing it.
  f.live.delete(input.sessionId);
  f.sessions.delete('child');
  await mkdir(path.join(f.root, 'sessions', 'project', 'child'), { recursive: true });
  const destroyed = await host.managedDestroy({ ...input, taskId: 'task-a' });
  assert.equal(destroyed.destroyed, true);
  assert.deepEqual(f.removed.map(directory => path.basename(directory)).sort(), ['child', input.sessionId].sort());
  assert.equal(f.records.size, 0);
});

test('the old inspect shape still reads a stored session when the query service has no reader', async () => {
  const f = await fixture(), input = identity(f.workspace), host = f.create();
  delete f.services.sessionQuery.readSession;
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  f.services.sessionController.inspect = async id => ({ meta: f.stored.get(id), events: [{ seq: 7, type: 'assistant/message', data: { id } }] });
  assert.deepEqual((await host.managedHistory({ ...input, targetSessionId: input.sessionId })).events,
    [{ seq: 7, type: 'assistant/message', data: { id: input.sessionId } }]);
});

test('a host with neither reader refuses explicitly instead of failing obscurely', async () => {
  const f = await fixture(), input = identity(f.workspace), host = f.create();
  delete f.services.sessionController.inspect;
  delete f.services.sessionQuery.readSession;
  await host.managedCreate(input);
  await host.managedBeginTask({ ...input, taskId: 'task-a' });
  await assert.rejects(host.managedHistory({ ...input, targetSessionId: input.sessionId }),
    error => error.controlCode === 'managed-session-inspection-unavailable');
  const handler = createHostHandler(f.ctx, 'a'.repeat(64),
    { stateDirectory: path.join(f.root, 'managed'), store: f.store, removeDirectory: f.removeDirectory });
  const cursor = await handler('historyCursor', { args: { token: 'a'.repeat(64), sessionId: input.sessionId, workspace: f.workspace } });
  assert.equal(cursor.ok, false);
  assert.equal(cursor.error.code, 'managed-session-inspection-unavailable');
});

test('an unexpected host failure is noted outside the managed state directory without the token', async () => {
  const f = await fixture(), input = identity(f.workspace);
  const stateDirectory = path.join(f.root, 'managed');
  await f.create().managedCreate(input);
  f.live.delete(input.sessionId);
  f.services.sessionController.resolveAgent = async () => { throw new Error('native agent factory exploded'); };
  const handler = createHostHandler(f.ctx, 'b'.repeat(64), { stateDirectory, store: f.store, removeDirectory: f.removeDirectory });
  const result = await handler('capabilities', { args: { token: 'b'.repeat(64), sessionId: input.sessionId,
    workspace: f.workspace, activate: true } });
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, 'host-operation-failed', 'the answer stays the generic failure');
  const noteFile = path.join(path.dirname(stateDirectory), 'host-last-error.json');
  const note = JSON.parse(await readFile(noteFile, 'utf8'));
  assert.equal(note.endpoint, 'capabilities');
  assert.match(note.message, /native agent factory exploded/);
  assert.equal(JSON.stringify(note).includes('b'.repeat(64)), false, 'the bridge credential is never written');
  assert.equal(path.dirname(noteFile), path.dirname(stateDirectory));
  assert.notEqual(path.dirname(noteFile), stateDirectory, 'the listener watches the managed directory');
  await assert.rejects(stat(path.join(stateDirectory, 'host-last-error.json')), /ENOENT/,
    'nothing is written inside the directory the monitor watches');
});

test('a refusal with a control code and a failed write leave no note', async () => {
  const f = await fixture(), input = identity(f.workspace);
  const stateDirectory = path.join(f.root, 'managed');
  const handler = createHostHandler(f.ctx, 'c'.repeat(64), { stateDirectory, store: f.store, removeDirectory: f.removeDirectory });
  await f.create().managedCreate(input);
  f.live.delete(input.sessionId);
  delete f.services.sessionController.inspect;
  delete f.services.sessionQuery.readSession;
  const refused = await handler('capabilities', { args: { token: 'c'.repeat(64), sessionId: input.sessionId,
    workspace: f.workspace, activate: true } });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'managed-session-inspection-unavailable');
  await assert.rejects(readFile(path.join(path.dirname(stateDirectory), 'host-last-error.json'), 'utf8'), /ENOENT/,
    'a known refusal is not an unexpected host failure');

  // A note that cannot be written changes nothing about the answer.
  const blocked = path.join(f.root, 'a-file.txt');
  await writeFile(blocked, 'not a directory');
  f.services.sessionController.inspect = async () => { throw new Error('second explosion'); };
  const unwritable = createHostHandler(f.ctx, 'd'.repeat(64), { stateDirectory: path.join(blocked, 'managed'),
    store: f.store, removeDirectory: f.removeDirectory });
  const result = await unwritable('capabilities', { args: { token: 'd'.repeat(64), sessionId: input.sessionId,
    workspace: f.workspace, activate: true } });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'host-operation-failed');
});

test('a managed agent cannot raise a UI question the dispatching chat never sees', async () => {
  const f = await fixture(), input = identity(f.workspace), host = f.create();
  await host.managedCreate(input);
  const agent = f.live.get(input.sessionId);
  assert.equal(agent.guards[0]({ agent, name: 'ask_user_question' }), ROOT_QUESTION_REFUSAL);
  assert.equal(agent.guards[0]({ agent, name: 'request_user_input' }), ROOT_QUESTION_REFUSAL,
    'the older spelling of the same prompt is refused too');
  assert.equal(agent.guards[0]({ agent, name: 'write_file' }), undefined, 'other tools are untouched');
  assert.equal(agent.guards[0]({ agent: { id: 'unrelated' }, name: 'write_file' }), undefined);

  // A native descendant is guarded where its own tool calls are checked, because a
  // descendant's scope is not guaranteed to chain to the root agent's guard.
  const child = await f.ctx.agents.create({ sessionId: 'child-1', meta: { cwd: f.workspace }, setup: async () => {} });
  f.own('child-1', agent);
  const runtime = [...f.ctx[Symbol.for('futureaide-control.managed-runtimes')].values()][0];
  await runtime.installManagedDescendant(child.agent);
  assert.equal(child.agent.guards.length, 1);
  assert.equal(child.agent.guards[0]({ agent: child.agent, name: 'ask_user_question' }), CHILD_QUESTION_REFUSAL);
  assert.equal(child.agent.guards[0]({ agent: child.agent, name: 'read_file' }), undefined);
  assert.equal(agent.guards[0]({ agent: child.agent, name: 'ask_user_question' }), CHILD_QUESTION_REFUSAL,
    'if the root guard does see a descendant call, it names the parent route');
});
