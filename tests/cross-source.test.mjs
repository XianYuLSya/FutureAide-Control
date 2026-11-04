import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeBindingStale, claudeNoticeReceipt, createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor, ownerIdForSource, TRUSTED_CALLER } from '../src/calling-context.mjs';
import { claudeTrustedCaller, registerScopedTools, scopedManagement } from '../src/mcp-server.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREAD = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const extra = threadId => ({ _meta: { threadId } });

async function fixture({ adapters = {} } = {}) {
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
    assert.equal(deleted.deleted, true);
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
    models: async () => ({ models: [MODEL], default: MODEL }),
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
    const failed = await f.service.delete({ name: 'root' }, extra(THREAD));
    assert.equal(failed.deleted, false, 'the parent reports the child failure');
    assert.equal(f.store.get(rootId).state, 'cleanup_failed', 'and stays listed for a retry');
    assert.ok(f.store.get(childId), 'the child that could not be destroyed is still there');
    assert.equal(backend.calls.destroy.includes(rootId), false, 'the parent native session was not destroyed yet');

    const retried = await f.service.delete({ name: 'root' }, extra(THREAD));
    assert.equal(retried.deleted, true);
    assert.equal(f.store.count(), 0);
    assert.deepEqual(backend.calls.destroy.filter(id => id === childId).length, 2, 'the child was retried, not re-destroyed after success');
    assert.equal(backend.calls.destroy.filter(id => id === rootId).length, 1, 'the parent destroyed exactly once');
  } finally { f.service.close(); }
});
