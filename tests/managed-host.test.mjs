import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { apply, createManagedHost } from '../src/host-plugin.mjs';

// Fixtures remain in the project's clean directory. No test deletes or moves files.
async function fixture() {
  const root = path.resolve('clean', '20261030-managed-host-tests', randomUUID());
  const workspace = path.join(root, 'project');
  const sessionRoot = path.join(root, 'sessions');
  await mkdir(workspace, { recursive: true });
  const stored = new Map(), live = new Map(), sessions = new Map(), records = new Map();
  const checkpoints = new Map(), indexed = new Set(), observed = new Map();
  const removed = [], disposed = [], cancelled = [], creations = [];
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
    agentDefaultModel: { currentSelection: () => ({ provider: 'provider', model: 'model' }) },
    sessionProjectionCache: { requireTable: () => ({ delete: async id => checkpoints.delete(id), get: id => checkpoints.get(id) }),
      flushSoft: async session => checkpoints.set(session.header.id, { oldContext: true }) },
    sessionController: { agents: { composeAgent: async preset => ({ agentPreset: preset ?? 'default', setup: async () => {} }) },
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
      get: name => definitions.get(name), guard: guard => guards.push(guard),
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
    await options.setup(agent.ctx, agent);
    live.set(id, agent); sessions.set(id, agent.session); stored.set(id, header);
    indexed.add(id); checkpoints.set(id, { context: 'private' });
    observed.set(id, { context: 'private' });
    await mkdir(path.join(sessionRoot, 'project', id), { recursive: true });
    return { agent, async dispose() { disposed.push(id); live.delete(id); sessions.delete(id); } };
  }
  const ctx = { get: name => services[name], agents: { get: id => live.get(id), create: makeAgent,
    resume: options => makeAgent(options, true) }, sessions: { get: id => sessions.get(id), flush: async () => {} } };
  const store = { read: async key => records.has(key) ? structuredClone(records.get(key)) : undefined,
    write: async (key, value) => records.set(key, structuredClone(value)), remove: async key => records.delete(key) };
  let failRemoval = false;
  const removeDirectory = async target => {
    if (failRemoval) { failRemoval = false; throw new Error('fixture cleanup failure'); }
    removed.push(target);
    stored.delete(path.basename(target));
  };
  return { root, workspace, ctx, services, store, removeDirectory, live, sessions, stored, records, project, checkpoints, indexed, observed, removed, disposed, cancelled, creations,
    failNextRemoval: () => { failRemoval = true; },
    create: (context = ctx) => createManagedHost(context, { stateDirectory: path.join(root, 'managed'), store, removeDirectory,
      installDelegation: async agentCtx => { agentCtx.get('tools').register({name:'managed_subagent'}); } }) };
}

const identity = workspace => ({ ownerId: 'owner-a', agentId: 'agent-a', sessionId: 'session-managed-a', workspace, treeProtocol: 1, reportProtocol: 1 });

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
  assert.equal(f.indexed.has(input.sessionId), false);
  assert.equal(f.observed.has(input.sessionId), false);
  assert.deepEqual(f.project.sessionIds, []);
  assert.deepEqual(f.disposed, [input.sessionId]);
  assert.equal(f.removed.length, 1);
  assert.equal((await host.managedDestroy(input)).alreadyDestroyed, true);
  // The injected deletion adapter records the exact native directory; it does not delete fixture files.
  assert.equal(path.basename(f.removed[0]), input.sessionId);
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
