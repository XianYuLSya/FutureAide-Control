import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, appendFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeBindingStale, claudeNoticeReceipt, claudeNoticeRequestId, createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { ownerIdFor, ownerIdForSource, TRUSTED_CALLER } from '../src/calling-context.mjs';
import { claudeTrustedCaller, registerScopedTools, scopedManagement } from '../src/mcp-server.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const extra = threadId => ({ _meta: { threadId } });

async function fixture({ adapters = {}, onPollComplete } = {}) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'cross-'));
  const store = new RosterStore(':memory:');
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store,
    clientFactory: () => { throw new Error('no DSH host is needed for these cases'); },
    callCodex: async (threadId, tool) => (tool === 'read_thread'
      ? { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } }
      : { accepted: true }),
    backendAdapters: adapters,
    ...(onPollComplete ? { onPollComplete } : {}),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  return { service, store };
}

test('owner ids are namespaced per source and never collide', () => {
  assert.equal(ownerIdForSource('codex-desktop', THREAD), ownerIdFor(THREAD), 'the Codex owner id is unchanged');
  assert.notEqual(ownerIdForSource('claude-desktop', THREAD), ownerIdForSource('codex-desktop', THREAD));
  assert.equal(ownerIdForSource('claude-desktop', THREAD.toUpperCase()), ownerIdForSource('claude-desktop', THREAD),
    'a native session id is case-insensitive');
  assert.notEqual(ownerIdForSource('claude-desktop', THREAD), ownerIdForSource('claude-desktop', OTHER));
});

test('a Codex child can submit an explicit report only for its own bound task', async () => {
  const { service, store } = await fixture();
  try {
    const ownerId = ownerIdFor(THREAD);
    const record = { agentId: 'agent-' + 'b'.repeat(32), ownerId, sessionId: 'session-child', name: 'child',
      lifetime: 'persistent', target: 'codex-desktop', workspace, state: 'running', created: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [],
      task: { taskId: 'task-child', message: 'work', state: 'running', startedAt: new Date().toISOString(), dispatches: [], answers: [] } };
    store.insert(record);
    store.saveBackendState(record.agentId, { binding: { threadId: THREAD, sessionId: 'native-child' } });

    const accepted = await service.submitToParent({ kind: 'report', message: 'done reviewing', final: true }, extra(THREAD));
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.taskId, 'task-child');
    const pending = store.pendingSubmissions(record.agentId, 'task-child');
    assert.deepEqual(pending.map(item => [item.kind, item.message, item.final]), [['report', 'done reviewing', true]]);
    assert.equal(store.consumeSubmission(pending[0].id), true);
    assert.equal(store.consumeSubmission(pending[0].id), false, 'a submission is consumed once');

    // A chat that is not bound to a managed name cannot report for it.
    const foreign = await service.submitToParent({ kind: 'report', message: 'nope' }, extra(OTHER))
      .then(() => null, error => error);
    assert.equal(foreign.code, 'submission-not-owned');
    assert.equal(store.agentForCodexThread(OTHER), undefined);
  } finally { service.close(); }
});

test('a Claude notice is settled by its native delivery record, never by trailing text', async () => {
  assert.equal(claudeNoticeReceipt([{ requestId: 'notice-1', stage: 'accepted' }], 'notice-1').stage, 'accepted');
  assert.equal(claudeNoticeReceipt([{ requestId: 'notice-1', stage: 'inserted' }], 'notice-1').stage, 'inserted');
  assert.equal(claudeNoticeReceipt([{ requestId: 'notice-2', stage: 'inserted' }], 'notice-1'), undefined,
    'another request id is not our receipt');
  // A long report is truncated by the reader, so a page whose text happens to hold
  // the marker with no delivery record proves nothing.
  assert.equal(claudeNoticeReceipt([], 'notice-1'), undefined);
  assert.equal(claudeBindingStale(new Error('claude-session-changed')), true);
  assert.equal(claudeBindingStale(new Error('claude-message-empty')), false, 'a message error is not a stale binding');
});

test('the shared registration mounts the ten management tools with a trusted caller', async () => {
  const registered = [];
  const server = { registerTool: (tool, config, handler) => registered.push({ tool, config, handler }) };
  const seen = [];
  const service = { status: async extra => { seen.push(extra); return { ready: true }; } };
  registerScopedTools(server, { service,
    extraFor: async () => ({ [TRUSTED_CALLER]: { source: 'claude-desktop', nativeSessionId: 'native-1', workspace } }) });
  const names = registered.map(item => item.tool);
  assert.deepEqual(names, ['futureaide_status', 'futureaide_create_agent', 'futureaide_send_agent', 'futureaide_answer_agent',
    'futureaide_list_agents', 'futureaide_wait_agents', 'futureaide_agent_changes', 'futureaide_inspect_agent',
    'futureaide_cancel_agent', 'futureaide_delete_agent']);
  assert.equal(names.includes('ask_parent'), false, 'the report surface keeps its own ask/report tools');
  const status = registered.find(item => item.tool === 'futureaide_status');
  const result = await status.handler({}, { _meta: { threadId: THREAD } });
  assert.equal(result.isError, undefined);
  assert.equal(seen[0][TRUSTED_CALLER].nativeSessionId, 'native-1', 'the handler got the verified caller, not tool args');
});

test('the management hook builds the trusted context from the connection', async () => {
  const registered = [];
  const server = { registerTool: (tool, _config, handler) => registered.push({ tool, handler }) };
  const received = [];
  scopedManagement({ service: { status: async extra => { received.push(extra); return { ready: true }; } } })
    ({ server, caller: async () => ({ sessionId: 'native-9', cwd: workspace, pid: 42 }), trusted: async () => undefined });
  assert.equal(registered.length, 10);
  const status = registered.find(item => item.tool === 'futureaide_status');
  await status.handler({}, {});
  assert.equal(received[0][TRUSTED_CALLER].nativeSessionId, 'native-9');
  assert.equal(received[0][TRUSTED_CALLER].source, 'claude-desktop');
  await assert.rejects(claudeTrustedCaller({ trusted: async () => ({}), caller: async () => undefined }),
    error => error.code === 'calling-context-unavailable');
});

test('a managed name created from another managed session follows the parent tree', async () => {
  const { service, store } = await fixture();
  try {
    const rootId = 'agent-' + 'd'.repeat(32);
    const childId = 'agent-' + 'e'.repeat(32);
    const base = { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [],
      lifetime: 'persistent', workspace, created: true, nativeDestroyed: true, state: 'idle' };
    store.insert({ ...base, agentId: rootId, ownerId: ownerIdFor(THREAD), sessionId: 'session-root', name: 'root', target: 'claude-desktop' });
    // The child was created from inside the parent's Claude session, so it belongs to
    // that session's own owner and runs on a third application.
    store.insert({ ...base, agentId: childId, ownerId: ownerIdForSource('claude-desktop', 'native-s'),
      sessionId: 'session-child', name: 'child', target: 'codex-desktop', parentAgentId: rootId });
    store.insert({ ...base, agentId: 'agent-' + 'f'.repeat(32), ownerId: ownerIdForSource('claude-desktop', 'native-deep'),
      sessionId: 'session-deep', name: 'deep', target: 'dsh', parentAgentId: childId });

    assert.deepEqual(store.descendantsOf([rootId]).map(item => item.name), ['child', 'deep'], 'the closure crosses owners');
    const listed = await service.list(extra(THREAD));
    // 0.5.7 list: this chat's own names, each with its own tree. A descendant belongs
    // inside that tree, never as an extra entry in this chat's list.
    assert.deepEqual(listed.items.map(item => item.name), ['root'], 'only own names are listed');
    assert.equal(store.count(), 3, 'the descendants still exist as their own records');

    const deleted = await service.delete({ name: 'root' }, extra(THREAD));
    assert.equal(deleted.queued, true);
    assert.equal((await service.poll(rootId)).deleted, true);
    assert.equal(store.count(), 0, 'every managed descendant closes with its parent');
  } finally { service.close(); }
});

test('a verified Claude owner keeps its host session and binding for cold resume', async () => {
  const { store } = await fixture();
  try {
    const binding = { pid: 4242, sessionId: 'native-parent', socketPath: '\\\\.\\pipe\\claude-inbox', recordFile: 'D:\\claude\\4242.json',
      transcriptFile: 'D:\\claude\\projects\\p\\native-parent.jsonl', procStart: '123', pidDomain: 'win32:host' };
    const owner = { ownerId: ownerIdForSource('claude-desktop', 'native-parent'), source: 'claude-desktop',
      nativeSessionId: 'native-parent', hostSessionId: 'native-parent', workspace, binding, createdAt: new Date().toISOString() };
    store.saveOwner(owner);
    const saved = store.owner(owner.ownerId);
    assert.equal(saved.hostSessionId, 'native-parent');
    assert.equal(saved.binding.socketPath, binding.socketPath, 'the transport binding survives a cold start');
    assert.equal(store.saveOwner({ ...saved }).binding.pid, 4242);
  } finally { store.close(); }
});

test('a name created by a managed parent records its parent and an unmanaged caller does not', async () => {
  const { service, store } = await fixture();
  try {
    const parent = { agentId: 'agent-' + 'c'.repeat(32), ownerId: 'owner-parent', sessionId: 'session-parent',
      name: 'parent', lifetime: 'persistent', target: 'claude-desktop', workspace, state: 'idle', created: true,
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [] };
    store.insert(parent);
    store.saveBackendState(parent.agentId, { binding: { sessionId: 'native-parent', transcriptFile: 'D:\\claude\\p.jsonl' } });
    assert.equal(store.agentForNativeSession('native-parent').agentId, parent.agentId);
  } finally { service.close(); }
});


// --- Shared-tree cases: composition, addressing, cleanup ordering ---------------

const MODEL = { provider: 'anthropic', model: 'claude-sonnet-4-5' };

/** A backend whose native tree, changes and destroy behaviour the test controls. */
function fakeBackend({ nodes = [], changes = [], historyText = id => 'history:' + id, failDestroyTimes = 0, failWhen = () => true } = {}) {
  const calls = { destroy: [], history: [] };
  const attempts = new Map();
  const factory = record => ({
    labels: { host: 'DSH', bridge: 'The test backend' },
    probe: async () => ({ identity: { workspace }, methods: [], treeProtocol: 1, reportProtocol: 1 }),
    create: async () => ({ sessionId: record.sessionId, modelRequestsStarted: 0 }),
    beginTask: async () => ({ treeProtocol: 1, reportProtocol: 1 }),
    observe: async () => ({ sessionId: record.sessionId, taskId: record.task?.taskId, running: false, throughSeq: 1,
      questions: [], reports: [], changes,
      tree: { settled: true, running: false, nodes: nodes.length ? nodes
        : [{ sessionId: record.sessionId, parentSessionId: null, name: record.name, status: 'idle', activity: 'idle', changes, coverage: 'Observed' }] } }),
    history: async ({ targetSessionId }) => { calls.history.push(targetSessionId);
      return { messages: [{ role: 'assistant', content: historyText(targetSessionId) }], hasMore: false }; },
    answer: async () => ({ consumedQuestionIds: [] }),
    deliver: async () => ({ accepted: true }),
    receipt: async () => undefined,
    turn: async () => ({ state: 'ended' }),
    models: async () => ({ default: MODEL, routableProviders: [MODEL.provider],
      groups: [{ id: MODEL.provider, models: [{ id: MODEL.model }] }] }),
    model: async () => MODEL,
    selectModel: async () => ({ accepted: true }),
    cancel: async () => ({ cancelRequested: true }),
    destroy: async () => {
      calls.destroy.push(record.agentId);
      const used = (attempts.get(record.agentId) ?? 0) + 1;
      attempts.set(record.agentId, used);
      if (failWhen(record) && used <= failDestroyTimes) return { destroyed: false, message: 'injected destroy failure' };
      return { destroyed: true };
    },
    cursor: async () => ({ offset: 0 }),
  });
  factory.calls = calls;
  return factory;
}

const taskRecord = (overrides) => ({ state: 'awaiting_report', created: true, nativeDestroyed: true,
  lifetime: 'persistent', target: 'claude-desktop', workspace, createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(), history: [], task: { taskId: 'task-' + overrides.name, message: 'work',
    state: 'running', startedAt: new Date().toISOString(), dispatches: [], answers: [], reports: [] }, ...overrides });

const completedInput = (name, reports = []) => ({ taskId: `task-${name}`, message: 'work', state: 'running',
  treeProtocol: 1, reportProtocol: 1, startedAt: new Date().toISOString(), answers: [], reports,
  dispatches: [{ requestId: `request-${name}`, state: 'completed', accepted: true }] });
const finalReport = name => ({ id: `final-${name}`, taskId: `task-${name}`, message: `${name} done`, final: true,
  delivery: { id: `notice-${name}`, state: 'pending' } });

test('a same-named descendant never enters this chat’s namespace or list', async () => {
  const owner = ownerIdFor(THREAD);
  const alpha = 'agent-' + '1'.repeat(32);
  const beta = 'agent-' + '2'.repeat(32);
  const f = await fixture({ adapters: { 'claude-desktop': fakeBackend() } });
  try {
    f.store.insert(taskRecord({ agentId: alpha, ownerId: owner, sessionId: 'session-alpha', name: 'alpha' }));
    f.store.insert(taskRecord({ agentId: beta, ownerId: owner, sessionId: 'session-beta', name: 'beta' }));
    // Both roots have a descendant called reviewer, each under its own session owner.
    for (const [parent, native] of [[alpha, 'native-alpha'], [beta, 'native-beta']]) {
      f.store.insert(taskRecord({ agentId: 'agent-' + parent.slice(6, 12) + 'f'.repeat(26), ownerId: ownerIdForSource('claude-desktop', native),
        sessionId: 'session-' + native, name: 'reviewer', target: 'claude-desktop', parentAgentId: parent }));
    }
    const listed = await f.service.list(extra(THREAD));
    assert.deepEqual(listed.items.map(item => item.name).sort(), ['alpha', 'beta'], 'descendants stay out of the list');
    const missing = await f.service.inspect({ name: 'reviewer' }, extra(THREAD)).then(() => null, error => error);
    assert.equal(missing.code, 'agent-not-found', 'a descendant name is not addressable from this chat');
    await f.service.delete({ name: 'alpha' }, extra(THREAD));
    await f.service.poll(alpha);
    assert.equal(f.store.list(ownerIdForSource('claude-desktop', 'native-beta')).length, 1,
      'closing one root leaves the other root’s child alone');
  } finally { f.service.close(); }
});

test('one composed view: a running descendant keeps the root from finishing', async () => {
  const owner = ownerIdFor(THREAD);
  const rootId = 'agent-' + '3'.repeat(32);
  const childId = 'agent-' + '4'.repeat(32);
  const f = await fixture({ adapters: { 'claude-desktop': fakeBackend() } });
  try {
    f.store.insert(taskRecord({ agentId: rootId, ownerId: owner, sessionId: 'session-root', name: 'root',
      state: 'awaiting_report', task: { taskId: 'task-root', message: 'work', state: 'running',
        startedAt: new Date().toISOString(), dispatches: [], answers: [],
        reports: [{ id: 'report-1', taskId: 'task-root', message: 'root done', final: true, createdAt: new Date().toISOString(),
          delivery: { id: 'report-d1', state: 'pending' } }] } }));
    f.store.insert(taskRecord({ agentId: childId, ownerId: ownerIdForSource('claude-desktop', 'native-kid'),
      sessionId: 'session-child', name: 'child', parentAgentId: rootId, state: 'running' }));
    await f.service.poll(rootId);
    const after = f.store.get(rootId);
    assert.equal(after.task.result, undefined, 'the root never confirms a final while a descendant is still running');
    assert.ok(!after.closed, 'and it is not cleaned up');
    // The descendant’s work appears inside the root’s own tree, with the path.
    const changes = await f.service.changes({ name: 'root' }, extra(THREAD));
    assert.ok(changes.tree.nodes.length >= 2, 'both applications are in one tree');
    assert.equal(changes.tree.settled, false, 'the composed tree is not settled while a child runs');
  } finally { f.service.close(); }
});

test('inspect and changes expose the mixed tree without internal ids', async () => {
  const owner = ownerIdFor(THREAD);
  const rootId = 'agent-' + '5'.repeat(32);
  const childId = 'agent-' + '6'.repeat(32);
  const nodes = [{ sessionId: 'session-root', parentSessionId: null, name: 'root', status: 'idle', activity: 'idle',
    changes: [{ path: 'src/root.ts', operation: 'edit' }], coverage: 'Observed' }];
  const childNodes = [{ sessionId: 'session-child', parentSessionId: null, name: 'child', status: 'idle', activity: 'idle',
    changes: [{ path: 'src/child.ts', operation: 'edit' }], coverage: 'Observed' }];
  const f = await fixture({ adapters: { 'claude-desktop': record => {
    const factory = fakeBackend(record.name === 'root' ? { nodes } : { nodes: childNodes });
    return factory(record);
  } } });
  try {
    f.store.insert(taskRecord({ agentId: rootId, ownerId: owner, sessionId: 'session-root', name: 'root' }));
    f.store.insert(taskRecord({ agentId: childId, ownerId: ownerIdForSource('claude-desktop', 'native-kid2'),
      sessionId: 'session-child', name: 'child', parentAgentId: rootId }));
    await f.service.poll(childId);
    const changes = await f.service.changes({ name: 'root' }, extra(THREAD));
    assert.deepEqual(changes.changes.map(change => change.agentPath.join('/')).sort(), ['root', 'root/child'],
      'both applications’ files are attributed by path');
    const inspected = await f.service.inspect({ name: 'root' }, extra(THREAD));
    assert.deepEqual(inspected.tree.nodes.map(node => node.agentPath.join('/')), ['root', 'root/child']);
    assert.ok(inspected.tree.nodes.every(node => Array.isArray(node.messages)), 'each node carries its own history');
    const serialized = JSON.stringify(inspected);
    assert.equal(/"(nativeSessionId|backendKey|socketPath|transcriptFile|recordFile)"/.test(serialized), false,
      'no internal id or binding leaves the shared layer');
  } finally { f.service.close(); }
});

test('children are cleaned first; a child failure keeps the parent retryable', async () => {
  const owner = ownerIdFor(THREAD);
  const rootId = 'agent-' + '7'.repeat(32);
  const childId = 'agent-' + '8'.repeat(32);
  const backend = fakeBackend({ failDestroyTimes: 1, failWhen: record => record.name === 'child' });
  const f = await fixture({ adapters: { 'claude-desktop': backend } });
  try {
    f.store.insert(taskRecord({ agentId: rootId, ownerId: owner, sessionId: 'session-root', name: 'root', nativeDestroyed: false }));
    f.store.insert(taskRecord({ agentId: childId, ownerId: ownerIdForSource('claude-desktop', 'native-kid3'),
      sessionId: 'session-child', name: 'child', parentAgentId: rootId, nativeDestroyed: false, lifetime: 'once' }));
    assert.equal((await f.service.delete({ name: 'root' }, extra(THREAD))).queued, true);
    const failed = await f.service.poll(rootId);
    assert.equal(failed.deleted, false, 'the parent reports the child failure');
    assert.equal(f.store.get(rootId).state, 'cleanup_failed', 'and stays listed for a retry');
    assert.ok(f.store.get(childId), 'the child that could not be destroyed is still there');
    assert.equal(backend.calls.destroy.includes(rootId), false, 'the parent native session was not destroyed yet');

    assert.equal((await f.service.delete({ name: 'root' }, extra(THREAD))).queued, true);
    const retried = await f.service.poll(rootId);
    assert.equal(retried.deleted, true);
    assert.equal(f.store.count(), 0);
    assert.deepEqual(backend.calls.destroy.filter(id => id === childId).length, 2, 'the child was retried, not re-destroyed after success');
    assert.equal(backend.calls.destroy.filter(id => id === rootId).length, 1, 'the parent destroyed exactly once');
  } finally { f.service.close(); }
});

test('three managed levels settle after persistent child finals and pending notices finish', async () => {
  const backend = fakeBackend({ changes: [{ path: 'work.txt', operation: 'write' }] });
  const f = await fixture({ adapters: { 'claude-desktop': backend } });
  try {
    await f.service.list(extra(THREAD));
    await f.service.list(extra(OTHER));
    for (const [name, parent] of [['root', undefined], ['child', 'root'], ['grand', 'child']]) {
      f.store.insert(taskRecord({ agentId: name, ownerId: ownerIdFor(name === 'root' ? THREAD : OTHER),
        sessionId: `session-${name}`, name, parentAgentId: parent,
        task: completedInput(name, [finalReport(name)]) }));
    }
    await f.service.poll('root');
    assert.equal(f.store.get('root').task.result, undefined);
    const before = await f.service.changes({ name: 'root' }, extra(THREAD));
    assert.deepEqual(before.tree.nodes.map(n => n.agentPath), [['root'], ['root', 'child'], ['root', 'child', 'grand']]);
    await f.service.poll('grand');
    assert.equal(f.store.get('grand').state, 'idle');
    await f.service.poll('child');
    assert.equal(f.store.get('child').state, 'idle');
    // An idle native tree alone is insufficient while a child's notice is pending.
    const child = f.store.get('child');
    child.task.reports.push({ id: 'late', taskId: child.task.taskId, message: 'notice', final: false, delivery: { state: 'pending' } });
    f.store.save(child);
    await f.service.poll('root');
    assert.equal(f.store.get('root').task.result, undefined);
    child.task.reports.at(-1).delivery.state = 'delivered'; f.store.save(child);
    await f.service.poll('root');
    assert.equal(f.store.get('root').state, 'idle');
    assert.equal(f.store.get('root').task.reports[0].delivery.state, 'delivered');
    assert.equal(f.store.get('root').closed, undefined);
    assert.equal(f.store.get('root').task.result.changes.length, 3);
  } finally { f.service.close(); }
});

test('a once child cleans itself and its files and native history survive in the parent task', async () => {
  const backend = fakeBackend({ changes: [{ path: 'child.txt', operation: 'write' }], historyText: () => 'completed child history' });
  const f = await fixture({ adapters: { 'claude-desktop': backend } });
  try {
    await f.service.list(extra(THREAD)); await f.service.list(extra(OTHER));
    f.store.insert(taskRecord({ agentId: 'parent', ownerId: ownerIdFor(THREAD), sessionId: 'session-parent', name: 'parent',
      task: completedInput('parent') }));
    f.store.insert(taskRecord({ agentId: 'once', ownerId: ownerIdFor(OTHER), sessionId: 'session-once', name: 'once',
      parentAgentId: 'parent', lifetime: 'once', nativeDestroyed: false, task: completedInput('once', [finalReport('once')]) }));
    const staleParent = f.store.get('parent');
    await f.service.poll('once');
    assert.equal(f.store.get('once'), undefined, 'the child completed its own automatic cleanup');
    assert.equal(backend.calls.destroy.length, 1);
    f.store.save(staleParent);
    assert.equal(f.store.get('parent').task.childSnapshots.length, 1, 'an old parent save cannot lose the handoff');
    const changes = await f.service.changes({ name: 'parent' }, extra(THREAD));
    assert.ok(changes.changes.some(c => c.path === 'child.txt' && c.agentPath.join('/') === 'parent/once'));
    const inspected = await f.service.inspect({ name: 'parent' }, extra(THREAD));
    assert.equal(inspected.tree.nodes[1].messages[0].content, 'completed child history');
    assert.equal(JSON.stringify(inspected).includes('"sessionId"'), false);
    const parent = f.store.get('parent'); parent.task.reports.push(finalReport('parent')); f.store.save(parent);
    await f.service.poll('parent');
    const finished = f.store.get('parent');
    assert.equal(finished.state, 'idle');
    await f.service.send({ name: 'parent', message: 'next task' }, extra(THREAD));
    const historical = await f.service.changes({ name: 'parent', task: 1 }, extra(THREAD));
    assert.ok(historical.changes.some(c => c.agentPath.join('/') === 'parent/once'));
    assert.deepEqual(historical.tree.nodes.map(n => n.agentPath), [['parent'], ['parent', 'once']]);
  } finally { f.service.close(); }
});

test('Codex poll consumes submissions atomically while ask remains answerable through its backend', async () => {
  const adapter = (record, deps) => createCodexBackend(record, { ...deps, host: {
    probe: async () => ({ identity: { application: 'codex-desktop' }, missing: [] }),
    readDefaultModel: async () => ({ provider: 'openai', model: 'test' }),
  } });
  const f = await fixture({ adapters: { 'codex-desktop': adapter } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'codex', ownerId: ownerIdFor(THREAD), sessionId: 'logical-codex', name: 'codex',
      target: 'codex-desktop', task: completedInput('codex') }));
    for (const [id, kind] of [['ask-1', 'ask'], ['report-1', 'report']]) f.store.enqueueSubmission({ id,
      ownerId: ownerIdFor(THREAD), agentId: 'codex', taskId: 'task-codex', kind, message: `${kind} text` });
    const save = f.store.save.bind(f.store);
    const record = f.store.get('codex');
    f.store.save = () => { throw new Error('injected transaction failure'); };
    assert.throws(() => f.store.saveAndConsumeSubmissions(record, ['ask-1', 'report-1']), /transaction failure/);
    f.store.save = save;
    assert.equal(f.store.pendingSubmissions('codex', 'task-codex').length, 2);
    await f.service.poll('codex');
    assert.equal(f.store.pendingSubmissions('codex', 'task-codex').length, 0);
    assert.equal(f.store.get('codex').state, 'awaiting_input');
    assert.equal(f.store.get('codex').task.reports.length, 1);
    assert.equal(f.store.get('codex').observation.questions[0].message, 'ask text');
    assert.equal((await f.service.answer({ name: 'codex', message: 'answer text' }, extra(THREAD))).answered, true);
    assert.deepEqual(f.store.backendState('codex').answeredQuestionIds, ['submission:ask-1']);
    const inspected = await f.service.inspect({ name: 'codex' }, extra(THREAD));
    assert.deepEqual(inspected.questions, []);
    assert.equal(f.store.get('codex').task.reports.length, 1, 'the consumed report is not duplicated');
  } finally { f.service.close(); }
});

test('cancelPending keeps the monitor advancing a late handback until the native tree settles', async () => {
  let cancels = 0;
  const base = fakeBackend();
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record), cancel: async () => {
    cancels++;
    return { cancelRequested: true, cancelPending: cancels < 3, remainingTasks: cancels < 3 ? ['late-handback'] : [], treeSettled: cancels >= 3 };
  } }) } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'cancel', ownerId: ownerIdFor(THREAD), sessionId: 'session-cancel', name: 'cancel',
      task: completedInput('cancel') }));
    await f.service.cancel({ name: 'cancel' }, extra(THREAD));
    assert.equal(cancels, 0, 'the MCP only persisted the cancellation intent');
    await f.service.poll('cancel');
    await f.service.poll('cancel');
    assert.equal(cancels, 2);
    assert.equal(f.store.get('cancel').task.cancelVerified, true);
    assert.equal(f.store.get('cancel').task.cancelPending, true);
    assert.equal(f.store.get('cancel').state, 'running');
    assert.equal(f.store.get('cancel').observation.tree.settled, false);
    await f.service.poll('cancel');
    assert.equal(cancels, 3, 'verified cancellation still advances while cancelPending is true');
    assert.equal(f.store.get('cancel').state, 'cancelled');
    assert.equal(f.store.get('cancel').task.cancelTreeSettled, true);
    await f.service.poll('cancel');
    assert.equal(cancels, 3, 'settled cancellation no longer calls the backend');
  } finally { f.service.close(); }
});

test('Desktop first input and immediate supplement queue promptly and each dispatch exactly once', async () => {
  const sent = [];
  let instances = 0;
  const base = fakeBackend();
  const f = await fixture({ adapters: { 'claude-desktop': record => {
    instances++;
    return { ...base(record), deliver: async input => { sent.push(input); return { accepted: true }; } };
  } } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'queue', ownerId: ownerIdFor(THREAD), sessionId: 'session-queue', name: 'queue', state: 'idle', task: undefined }));
    assert.equal((await f.service.send({ name: 'queue', message: 'first' }, extra(THREAD))).queued, true);
    assert.equal((await f.service.send({ name: 'queue', message: 'supplement' }, extra(THREAD))).queued, true);
    assert.equal(sent.length, 0);
    assert.equal(instances, 0, 'queuing never probes the host or creates an adapter');
    await f.service.poll('queue');
    assert.equal(instances, 1, 'a poll uses one backend instance');
    await f.service.poll('queue');
    await f.service.poll('queue');
    assert.deepEqual(sent.map(input => [input.message, input.kind]), [['first', 'task'], ['supplement', 'supplement']]);
    assert.notEqual(sent[0].requestId, sent[1].requestId);
  } finally { f.service.close(); }
});

test('one slow monitor name does not hold up another and shutdown drains the single in-flight poll', async () => {
  let enterSlow, releaseSlow, fastDone;
  const entered = new Promise(resolve => { enterSlow = resolve; });
  const gate = new Promise(resolve => { releaseSlow = resolve; });
  const fast = new Promise(resolve => { fastDone = resolve; });
  let slowCalls = 0, wakes = 0;
  const base = fakeBackend();
  const f = await fixture({ onPollComplete: () => wakes++, adapters: { 'claude-desktop': record => ({ ...base(record),
    deliver: async () => {
      if (record.name === 'a-slow') { slowCalls++; enterSlow(); await gate; }
      else fastDone();
      return { accepted: true };
    } }) } });
  try {
    await f.service.list(extra(THREAD));
    for (const name of ['a-slow', 'z-fast']) {
      f.store.insert(taskRecord({ agentId: name, ownerId: ownerIdFor(THREAD), sessionId: `session-${name}`, name, state: 'idle', task: undefined }));
      await f.service.send({ name, message: 'work' }, extra(THREAD));
    }
    assert.equal(await f.service.monitorScan(), true);
    await entered; await fast;
    await f.service.monitorScan();
    assert.equal(slowCalls, 1, 'another round never starts the same name twice');
    let drained = false;
    const ending = f.service.drainPolls().then(() => { drained = true; });
    await Promise.resolve();
    assert.equal(drained, false, 'shutdown leaves the database open until the native call returns');
    releaseSlow(); await ending;
    assert.ok(wakes > 0);
    assert.equal(f.store.get('z-fast').task.dispatches[0].accepted, true);
  } finally { releaseSlow(); await f.service.drainPolls(); f.service.close(); }
});

test('a 123-name retained roster serves HTTP during a scan without loading idle histories', async () => {
  const { startHttpService } = await import('../src/claude-report-server.mjs');
  const base = fakeBackend();
  let observed = 0;
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record),
    observe: async () => { observed++; return base(record).observe(); } }) } });
  const http = await startHttpService({ port: 0 });
  const gets = new Set(), get = f.store.get.bind(f.store);
  f.store.get = id => { gets.add(id); return get(id); };
  try {
    const retained = 'x'.repeat(416000);
    for (let i = 0; i < 123; i++) {
      const name = `scale-${String(i).padStart(3, '0')}`;
      f.store.insert(taskRecord({ agentId: name, name, ownerId: ownerIdFor(THREAD), sessionId: `session-${name}`,
        state: i < 45 ? 'awaiting_report' : 'idle', task: completedInput(name), history: [{ message: retained }] }));
    }
    const url = `http://127.0.0.1:${http.port}/healthz`;
    await (await fetch(url)).json();
    let observedAtHealth;
    const health = fetch(url).then(async response => { assert.equal((await response.json()).ok, true); observedAtHealth = observed; });
    const start = performance.now();
    await f.service.monitorScan();
    await health;
    await f.service.drainPolls();
    assert.ok(observedAtHealth < 45, `HTTP waited for all ${observedAtHealth} polls`);
    assert.equal(observed, 45);
    assert.equal([...gets].some(id => Number(id.slice(6)) >= 45), false, 'idle history bodies were never loaded');
    process.stdout.write(`scale: 123 names / 51 MB, HTTP after ${observedAtHealth} of 45 observations, scan+drain ${Math.round(performance.now() - start)}ms\n`);
  } finally { await f.service.drainPolls(); await http.close(); f.service.close(); }
});

test('pre-delivery failures back off visibly, while ambiguous delivery is never sent again', async () => {
  let beginFailures = 1, modelFailures = 1, begins = 0, models = 0, sends = 0;
  const base = fakeBackend();
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record),
    beginTask: async () => { begins++; if (beginFailures-- > 0) throw Object.assign(new Error('host busy before begin'), { code: 'agent-busy' }); return { treeProtocol: 1, reportProtocol: 1 }; },
    models: async () => { models++; if (modelFailures-- > 0) throw Object.assign(new Error('default read busy'), { code: 'agent-busy' }); return base(record).models(); },
    deliver: async () => { sends++; throw Object.assign(new Error('receipt not yet known'), { uncertain: true, code: 'delivery-unknown' }); },
    turn: async () => ({ state: 'running' }),
  }) } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'retry', ownerId: ownerIdFor(THREAD), sessionId: 'session-retry', name: 'retry', state: 'idle', task: undefined }));
    await f.service.send({ name: 'retry', message: 'work' }, extra(THREAD));
    await f.service.poll('retry'); await f.service.poll('retry');
    assert.equal(begins, 1, 'begin failure is not retried on every scan');
    assert.ok(f.store.get('retry').nextAttemptAt > Date.now());
    let r = f.store.get('retry'); r.nextAttemptAt = 0; f.store.save(r);
    await f.service.poll('retry'); await f.service.poll('retry');
    assert.equal(models, 1);
    r = f.store.get('retry');
    assert.equal(r.task.dispatches[0].state, 'retrying');
    const waiting = await f.service.wait({ names: ['retry'], timeoutSeconds: 1 }, extra(THREAD));
    assert.equal(waiting.timedOut, false);
    assert.equal(waiting.items[0].error.code, 'agent-busy');
    r.task.dispatches[0].nextAttemptAt = 0; f.store.save(r);
    await f.service.poll('retry'); await f.service.poll('retry');
    assert.equal(sends, 1, 'unknown delivery never blindly resends');
    assert.equal((await f.service.list(extra(THREAD))).items[0].error.code, 'delivery-unknown');
  } finally { f.service.close(); }
});

test('parent observation never enters a busy child backend and stale child evidence cannot settle', async () => {
  const calls = [];
  const base = fakeBackend();
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record),
    observe: async () => { calls.push(record.name); return base(record).observe(); },
  }) } });
  try {
    await f.service.list(extra(THREAD));
    for (const name of ['parent', 'child']) f.store.insert(taskRecord({ agentId: name, ownerId: ownerIdFor(THREAD),
      sessionId: `session-${name}`, name, parentAgentId: name === 'child' ? 'parent' : undefined,
      task: completedInput(name) }));
    const first = await f.service.changes({ name: 'parent' }, extra(THREAD));
    assert.equal(first.tree.settled, false);
    assert.deepEqual(calls, ['parent'], 'no missing child observation is filled outside the child lock');
    await f.service.poll('child');
    const child = f.store.get('child'); child.state = 'idle'; child.task.state = 'completed'; child.observation.stale = true; f.store.save(child);
    calls.length = 0;
    await f.store.locked('child', async () => {
      const inspected = await f.service.inspect({ name: 'parent' }, extra(THREAD));
      assert.equal(inspected.tree.settled, false);
      assert.equal(inspected.tree.nodes[1].error.code, 'agent-busy');
    });
    assert.deepEqual(calls, ['parent']);
  } finally { f.service.close(); }
});

test('queued Desktop cleanup survives an old poll save and native failure is visible and retryable', async () => {
  let destroys = 0;
  const base = fakeBackend();
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record), destroy: async () => {
    destroys++; return { destroyed: destroys > 1, message: 'native deletion refused' };
  } }) } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'delete', ownerId: ownerIdFor(THREAD), sessionId: 'session-delete', name: 'delete', nativeDestroyed: false, task: completedInput('delete') }));
    const old = f.store.get('delete');
    const queued = await f.service.delete({ name: 'delete' }, extra(THREAD));
    assert.equal(queued.queued, true); assert.equal(queued.deleted, false); assert.equal(destroys, 0);
    old.state = 'running'; f.store.save(old);
    assert.equal(f.store.get('delete').state, 'cleaning');
    await f.service.monitorScan();
    await f.service.poll('delete');
    assert.equal(f.store.get('delete').state, 'cleanup_failed');
    assert.match((await f.service.list(extra(THREAD))).items[0].error.message, /native deletion refused/);
    await f.service.delete({ name: 'delete' }, extra(THREAD));
    assert.equal((await f.service.poll('delete')).deleted, true);
    assert.equal(destroys, 2);
  } finally { await f.service.drainPolls(); f.service.close(); }
});

test('queued Desktop cancel exposes a host failure, backs off and resumes the same intent', async () => {
  let cancels = 0;
  const base = fakeBackend();
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record), cancel: async () => {
    cancels++;
    if (cancels === 1) throw Object.assign(new Error('cancel host unavailable'), { code: 'host-unavailable' });
    return { cancelRequested: true, cancelPending: false };
  } }) } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'stop', ownerId: ownerIdFor(THREAD), sessionId: 'session-stop', name: 'stop', task: completedInput('stop') }));
    const queued = await f.service.cancel({ name: 'stop' }, extra(THREAD));
    assert.equal(queued.queued, true); assert.equal(queued.accepted, false); assert.equal(cancels, 0);
    await f.service.poll('stop'); await f.service.poll('stop');
    assert.equal(cancels, 1);
    const r = f.store.get('stop');
    assert.equal(r.task.cancelRequested, true);
    assert.equal((await f.service.wait({ names: ['stop'], timeoutSeconds: 1 }, extra(THREAD))).items[0].error.code, 'host-unavailable');
    r.nextAttemptAt = 0; f.store.save(r);
    await f.service.poll('stop');
    assert.equal(cancels, 2);
    assert.equal(f.store.get('stop').state, 'cancelled');
  } finally { f.service.close(); }
});

test('a returned stop refusal remains visible through observation until native cancellation settles', async () => {
  let cancels = 0, settled = false;
  const base = fakeBackend();
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record),
    observe: async () => { const view = await base(record).observe(); return { ...view, running: !settled,
      tree: { ...view.tree, running: !settled, settled } }; },
    cancel: async () => {
      cancels++;
      if (cancels < 3) return { cancelRequested: cancels === 2, cancelPending: true, treeSettled: false,
        reason: 'no-native-stop-accepted', cancelRounds: [{ round: 1, action: 'stop-tasks', clicked: 0, remaining: 1,
          detail: [{ rowText: 'working child', clicked: false, state: 'refused',
            error: { code: 'task-stop-click-unavailable', message: 'No clickable point', detail: { nativeSessionId: 'private-id' } } }] }] };
      settled = true;
      return { cancelRequested: true, cancelPending: false, treeSettled: true };
    },
  }) } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'refusal', ownerId: ownerIdFor(THREAD), sessionId: 'session-refusal', name: 'refusal', task: completedInput('refusal') }));
    await f.service.cancel({ name: 'refusal' }, extra(THREAD));
    await f.service.poll('refusal');
    assert.equal(f.store.get('refusal').error, undefined, 'observe completed normally');
    const listed = (await f.service.list(extra(THREAD))).items[0];
    assert.equal(listed.error.code, 'native-cancel-unconfirmed');
    assert.equal(listed.error.detail.rounds[0].rows[0].error.code, 'task-stop-click-unavailable');
    assert.equal(JSON.stringify(listed).includes('private-id'), false);
    const waited = await f.service.wait({ names: ['refusal'], timeoutSeconds: 1 }, extra(THREAD));
    assert.equal(waited.timedOut, false);
    assert.equal(waited.items[0].error.code, 'native-cancel-unconfirmed');
    await f.service.poll('refusal');
    assert.equal(cancels, 1, 'normal-return refusals also back off');
    let r = f.store.get('refusal'); r.nextAttemptAt = 0; f.store.save(r);
    await f.service.poll('refusal');
    assert.equal((await f.service.list(extra(THREAD))).items[0].error.code, 'native-cancel-partial');
    assert.equal(f.store.get('refusal').task.cancelPending, true);
    r = f.store.get('refusal'); r.nextAttemptAt = 0; f.store.save(r);
    await f.service.poll('refusal');
    assert.equal(f.store.get('refusal').state, 'cancelled');
    assert.equal((await f.service.list(extra(THREAD))).items[0].error, undefined);
  } finally { f.service.close(); }
});

test('a recovered receipt clears stale dispatch errors and completed legacy errors stay out of list', async () => {
  const base = fakeBackend();
  let sends = 0;
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record),
    receipt: async () => ({ status: 'accepted', afterSeq: 1 }),
    deliver: async () => { sends++; throw new Error('recovery must not resend'); },
  }) } });
  try {
    await f.service.list(extra(THREAD));
    const task = completedInput('recovered');
    Object.assign(task.dispatches[0], { state: 'unknown', accepted: false, nextAttemptAt: 0, retryAttempts: 2,
      error: { code: 'codex-native-binding-invalid', message: 'old path failure' } });
    f.store.insert(taskRecord({ agentId: 'recovered', ownerId: ownerIdFor(THREAD), sessionId: 'session-recovered', name: 'recovered', task }));
    await f.service.poll('recovered');
    const current = f.store.get('recovered');
    assert.equal(current.state, 'awaiting_report');
    assert.equal(current.task.dispatches[0].state, 'completed');
    for (const key of ['error', 'nextAttemptAt', 'retryAttempts']) assert.equal(current.task.dispatches[0][key], undefined);
    assert.equal(sends, 0);
    assert.equal((await f.service.list(extra(THREAD))).items[0].error, undefined);
    // Existing completed records need no roster rewrite to stop advertising an old transport error.
    current.task.dispatches[0].error = { code: 'codex-native-binding-invalid', message: 'legacy error' };
    f.store.save(current);
    assert.equal((await f.service.list(extra(THREAD))).items[0].error, undefined);
  } finally { f.service.close(); }
});

test('a Codex final reaches Claude through a legal native id and recovers its receipt without rewriting report identity', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const directory = await mkdtemp(path.join(workspace, '.runtime', 'tests', 'notice-pipe-'));
  const socketPath = `\\\\.\\pipe\\futureaide-notice-test-${randomUUID()}`;
  const binding = { pid: process.pid, sessionId: randomUUID(), procStart: '1', pidDomain: 'win32:test',
    workspace, directory, socketPath, recordFile: path.join(directory, 'record.json'), transcriptFile: path.join(directory, 'transcript.jsonl') };
  await writeFile(binding.recordFile, JSON.stringify({ ...binding, cwd: workspace,
    entrypoint: 'claude-desktop', messagingSocketPath: socketPath }));
  await writeFile(binding.transcriptFile, '');
  await writeFile(path.join(directory, `${binding.pid}.${createHash('sha256').update(socketPath).digest('hex')}.key`),
    JSON.stringify({ peerToken: 'a'.repeat(32), procStart: binding.procStart, pidDomain: binding.pidDomain }));
  const received = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    let data = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      data += chunk;
      if (!data.endsWith('\n') || data.trim().split('\n').length < 2) return;
      const frame = data.trim().split('\n').map(line => JSON.parse(line)).find(item => item.type === 'user');
      data = '';
      received.push(frame);
      appendFile(binding.transcriptFile, JSON.stringify({ sessionId: binding.sessionId, type: 'user', uuid: frame.uuid,
        message: frame.message }) + '\n').then(() => socket.end(), error => socket.destroy(error));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  try {
    const ownerId = ownerIdForSource('claude-desktop', binding.sessionId);
    f.store.saveOwner({ ownerId, source: 'claude-desktop', nativeSessionId: binding.sessionId, workspace, binding });
    const reportId = 'submission:submission-f19a44d65e454235a643e7ce556e7c2e';
    const noticeId = `report-${reportId}`;
    const report = { id: reportId, taskId: 'task-notice', final: true, message: 'verified final artifact', treeSettledConfirmed: true,
      delivery: { id: noticeId, state: 'unknown', error: { code: 'operation-failed', message: 'claude-request-id-invalid' } } };
    const task = { ...completedInput('notice', [report]), result: { state: 'completed', reply: report.message } };
    f.store.insert(taskRecord({ agentId: 'notice', ownerId, sessionId: 'session-notice', name: 'notice',
      target: 'codex-desktop', state: 'delivery_pending', task }));
    await f.service.poll('notice');
    assert.equal(received.length, 1, JSON.stringify(f.store.get('notice')));
    assert.match(received[0].uuid, /^[a-zA-Z0-9-]{1,100}$/);
    assert.equal(received[0].uuid, claudeNoticeRequestId(noticeId));
    assert.equal(claudeNoticeRequestId('legal-notice-1'), 'legal-notice-1');
    const pending = f.store.get('notice'); pending.task.reports[0].delivery.nextAttemptAt = 0; f.store.save(pending);
    await f.service.poll('notice');
    const finished = f.store.get('notice');
    assert.equal(finished.task.reports[0].id, reportId);
    assert.equal(finished.task.reports[0].delivery.id, noticeId);
    assert.equal(finished.task.reports[0].delivery.state, 'delivered');
    assert.equal(finished.task.reports[0].delivery.receipt.requestId, received[0].uuid);
    assert.equal(received.length, 1, 'read-back never resends the written notice');
  } finally { await new Promise(resolve => server.close(resolve)); f.service.close(); }
});
