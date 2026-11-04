import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, appendFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { hostname } from 'node:os';
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

async function fixture({ adapters = {}, onPollComplete, captureFiles,
  clientFactory = () => { throw new Error('no DSH host is needed for these cases'); }, startSharedMonitor = () => true } = {}) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'cross-'));
  const store = new RosterStore(':memory:');
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store,
    clientFactory,
    callCodex: async (threadId, tool) => (tool === 'read_thread'
      ? { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } }
      : { accepted: true }),
    backendAdapters: adapters,
    ...(onPollComplete ? { onPollComplete } : {}),
    ...(captureFiles ? { captureFiles } : {}),
    startSharedMonitor,
    removeTree: async () => {},
  });
  return { service, store, stateDirectory };
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

test('the shared registration mounts the eleven management tools with a trusted caller', async () => {
  const registered = [];
  const server = { registerTool: (tool, config, handler) => registered.push({ tool, config, handler }) };
  const seen = [];
  const service = { status: async extra => { seen.push(extra); return { ready: true }; } };
  registerScopedTools(server, { service,
    extraFor: async () => ({ [TRUSTED_CALLER]: { source: 'claude-desktop', nativeSessionId: 'native-1', workspace } }) });
  const names = registered.map(item => item.tool);
  assert.deepEqual(names, ['futureaide_status', 'futureaide_run_agent', 'futureaide_create_agent', 'futureaide_send_agent', 'futureaide_answer_agent',
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
  assert.equal(registered.length, 11);
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

// --- Workspace snapshots: files a shell wrote, not a file tool ------------------

/** A capture whose two answers stand for the task's start and end snapshots. */
function snapshotSource(root, before, after) {
  const answers = [before, after];
  const source = async () => answers[Math.min(source.calls++, answers.length - 1)];
  source.calls = 0;
  source.root = root;
  return source;
}

const snapshot = (root, files) => ({ available: true, workspace: root, files });

test('a task keeps its workspace baseline beside the agent state and ends with unconfirmed changes', async () => {
  const root = path.join(workspace, '.runtime', 'tests', 'workspace-snapshot-fixture');
  const confirmed = path.join(root, 'confirmed.txt');
  const shellWritten = path.join(root, 'shell-written.txt');
  const captureFiles = snapshotSource(root, snapshot(root, { 'confirmed.txt': { code: ' M', stamp: '1000:5' } }),
    snapshot(root, { 'confirmed.txt': { code: ' M', stamp: '2000:9' }, 'shell-written.txt': { code: '??', stamp: '2000:7' } }));
  const base = fakeBackend({ changes: [{ path: confirmed, operation: 'write' }] });
  let finalSubmitted = false;
  const f = await fixture({ captureFiles, adapters: { 'claude-desktop': record => ({ ...base(record),
    observe: async () => ({ ...await base(record).observe(), reports: finalSubmitted
      ? [{ id: 'final-snapshot', taskId: record.task.taskId, message: 'files written', final: true, createdAt: new Date().toISOString() }]
      : [] }) }) } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'writer', ownerId: ownerIdFor(THREAD), sessionId: 'session-writer',
      name: 'writer', state: 'idle', task: undefined, workspace: root }));
    assert.equal((await f.service.send({ name: 'writer', message: 'write files' }, extra(THREAD))).queued, true);
    assert.equal(captureFiles.calls, 0, 'queuing never waits for a snapshot');
    await f.service.list(extra(THREAD));
    assert.equal(captureFiles.calls, 0, 'list reads stored state only and never runs a snapshot');
    await f.service.poll('writer');
    assert.equal(captureFiles.calls, 1, 'the baseline is taken once, with the first dispatch');

    finalSubmitted = true;
    await f.service.poll('writer');
    // The snapshot write is not awaited by the dispatch, so it is read back only after a
    // reader that waits for it has run: the closing comparison in the poll above.
    const finished = f.store.get('writer');
    const saved = JSON.parse(await readFile(path.join(f.stateDirectory, 'scoped', finished.ownerId, finished.agentId,
      'workspace-baseline.json'), 'utf8'));
    assert.equal(saved.taskId, finished.task.taskId, 'the baseline names the task it belongs to');
    assert.deepEqual(saved.capture.files, { 'confirmed.txt': { code: ' M', stamp: '1000:5' } });
    assert.equal(JSON.stringify(finished).includes('1000:5'), false, 'the snapshot is never copied into the record body');
    assert.equal(finished.state, 'idle');
    assert.equal(finished.task.workspace.coverage.source, 'git-status-diff');
    assert.equal(finished.task.workspace.coverage.complete, false);
    assert.match(finished.task.workspace.coverage.limitation, /other processes or other assistants/);
    const changes = await f.service.changes({ name: 'writer' }, extra(THREAD));
    const shell = changes.changes.find(change => change.path === shellWritten);
    assert.deepEqual(shell, { path: shellWritten, operation: 'create', source: 'workspace-diff',
      attribution: 'unconfirmed', agentPath: ['writer'] });
    assert.equal(changes.changes.filter(change => change.path === confirmed).length, 1,
      'a path the file tools already confirmed is not counted twice');
    assert.equal(changes.coverage.workspace.source, 'git-status-diff');
    assert.equal(changes.coverage.workspace.reason, undefined);
    assert.equal(captureFiles.calls, 2, 'one baseline and one closing snapshot per task');
    const listed = (await f.service.list(extra(THREAD))).items.find(item => item.name === 'writer');
    assert.equal(listed.changes.files.find(change => change.path === shellWritten).attribution, 'unconfirmed',
      'the compact list must not present a guess as a confirmed write');
    assert.equal(listed.changes.files.find(change => change.path === confirmed).attribution, undefined);
    // The finished task keeps its snapshot changes in the same history entry a caller
    // already reads with task=1.
    await f.service.send({ name: 'writer', message: 'next task' }, extra(THREAD));
    const historical = await f.service.changes({ name: 'writer', task: 1 }, extra(THREAD));
    assert.ok(historical.changes.some(change => change.path === shellWritten && change.attribution === 'unconfirmed'));
    assert.equal(historical.coverage.workspace.source, 'git-status-diff');
  } finally { f.service.close(); }
});

test('a running task computes workspace changes on demand and persists nothing', async () => {
  const root = path.join(workspace, '.runtime', 'tests', 'workspace-live-fixture');
  const shellWritten = path.join(root, 'shell-written.txt');
  const captureFiles = snapshotSource(root, snapshot(root, {}),
    snapshot(root, { 'shell-written.txt': { code: '??', stamp: '2000:7' } }));
  const base = fakeBackend();
  const f = await fixture({ captureFiles, adapters: { 'claude-desktop': record => base(record) } });
  try {
    await f.service.list(extra(THREAD));
    f.store.insert(taskRecord({ agentId: 'live', ownerId: ownerIdFor(THREAD), sessionId: 'session-live',
      name: 'live', state: 'idle', task: undefined, workspace: root }));
    await f.service.send({ name: 'live', message: 'write files' }, extra(THREAD));
    await f.service.poll('live');
    assert.equal(f.store.get('live').state, 'awaiting_report', 'the task has not finished yet');
    const computed = await f.service.changes({ name: 'live' }, extra(THREAD));
    assert.deepEqual(computed.changes.map(change => change.path), [shellWritten]);
    assert.equal(computed.changes[0].attribution, 'unconfirmed');
    assert.equal(f.store.get('live').task.workspace, undefined, 'an on-demand comparison is not saved');
    const again = await f.service.changes({ name: 'live' }, extra(THREAD));
    assert.deepEqual(again.changes.map(change => change.path), [shellWritten]);
    assert.equal(captureFiles.calls, 3, 'each running read recaptures instead of reusing a saved answer');
    await f.service.list(extra(THREAD));
    assert.equal(captureFiles.calls, 3, 'list stays free of snapshots while the task runs');
  } finally { f.service.close(); }
});

test('a failed or unusable snapshot never blocks delivery and states its reason', async () => {
  const root = path.join(workspace, '.runtime', 'tests', 'workspace-failure-fixture');
  const scenarios = [
    { name: 'broken', capture: async () => { throw new Error('git status failed hard'); } },
    { name: 'nogit', capture: async () => ({ available: false, reason: 'not-a-repository' }) },
  ];
  for (const scenario of scenarios) {
    const base = fakeBackend();
    const f = await fixture({ captureFiles: scenario.capture, adapters: { 'claude-desktop': record => base(record) } });
    try {
      await f.service.list(extra(THREAD));
      f.store.insert(taskRecord({ agentId: scenario.name, ownerId: ownerIdFor(THREAD), sessionId: `session-${scenario.name}`,
        name: scenario.name, state: 'idle', task: undefined, workspace: root }));
      await f.service.send({ name: scenario.name, message: 'work' }, extra(THREAD));
      await f.service.poll(scenario.name);
      const record = f.store.get(scenario.name);
      record.task.reports.push({ id: `report-${scenario.name}`, taskId: record.task.taskId, message: 'done',
        final: true, createdAt: new Date().toISOString(), delivery: { id: `notice-${scenario.name}`, state: 'pending' } });
      f.store.save(record);
      await f.service.poll(scenario.name);
      const finished = f.store.get(scenario.name);
      assert.equal(finished.state, 'idle', `${scenario.name}: the task still finishes`);
      assert.equal(finished.task.reports[0].delivery.state, 'delivered', `${scenario.name}: the report is still delivered`);
      assert.deepEqual(finished.task.workspace.changes, []);
      assert.equal(finished.task.workspace.coverage.complete, false);
      assert.equal(finished.task.workspace.coverage.reason,
        scenario.name === 'broken' ? 'capture-failed' : 'not-a-repository', `${scenario.name}: the reason is visible`);
    } finally { f.service.close(); }
  }
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

test('supplement backoff does not delay a running task question and progress notice', async () => {
  const base = fakeBackend();
  let observations = 0, sends = 0, receipts = 0;
  const f = await fixture({ adapters: { 'claude-desktop': record => ({ ...base(record),
    observe: async () => { observations++; return { ...await base(record).observe(),
      questions: [{ id: 'q-live', state: 'pending', message: 'Need a decision' }],
      reports: [{ id: 'progress-live', taskId: record.task.taskId, message: 'Work progressed', final: false }] }; },
    deliver: async () => { sends++; return { accepted: true }; },
    receipt: async () => { receipts++; return undefined; },
    turn: async () => ({ state: 'running' }),
  }) } });
  try {
    await f.service.list(extra(THREAD));
    const task = completedInput('live');
    task.dispatches[0].state = 'running'; task.dispatches[0].kind = 'task';
    task.dispatches.push({ requestId: 'supplement-delayed', kind: 'supplement', state: 'retrying', accepted: false,
      nextAttemptAt: Date.now() + 30000, error: { code: 'agent-busy' } });
    f.store.insert(taskRecord({ agentId: 'live', name: 'live', ownerId: ownerIdFor(THREAD), sessionId: 'session-live', state: 'running', task }));
    await f.service.monitorScan();
    await f.service.drainPolls();
    const current = f.store.get('live');
    assert.ok(observations > 0, 'the monitor still observes the admitted task during supplement backoff');
    assert.equal(current.task.questionNotices['q-live'].state, 'delivered');
    assert.equal(current.task.reports.find(report => report.id === 'progress-live').delivery.state, 'delivered');
    assert.equal(current.task.dispatches[1].state, 'retrying');
    assert.equal(sends, 0, 'the supplementary input retains its own retry deadline');
    assert.equal(receipts, 0);
  } finally { await f.service.drainPolls(); f.service.close(); }
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

/**
 * One Claude session that restarted: the owner still holds the binding of a process
 * that is gone, and come() brings up the record, key and pipe of the new process.
 */
async function restartedClaude() {
  const root = await mkdtemp(path.join(workspace, '.runtime', 'tests', 'rebind-'));
  const directory = path.join(root, 'sessions'), project = path.join(root, 'projects', 'p');
  await mkdir(directory); await mkdir(project, { recursive: true });
  const sessionId = randomUUID(), socketPath = `\\\\.\\pipe\\futureaide-rebind-${randomUUID()}`;
  const pidDomain = `win32:${hostname().toLowerCase()}`, transcriptFile = path.join(project, `${sessionId}.jsonl`);
  const procStart = execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${process.pid}).StartTime.ToFileTimeUtc().ToString()`], { encoding: 'utf8', windowsHide: true }).trim();
  await writeFile(transcriptFile, '');
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = root;
  const received = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    let data = '';
    socket.setEncoding('utf8'); socket.on('data', chunk => {
      data += chunk;
      if (!data.endsWith('\n') || data.trim().split('\n').length < 2) return;
      const frame = data.trim().split('\n').map(line => JSON.parse(line)).find(item => item.type === 'user');
      data = '';
      received.push(frame);
      appendFile(transcriptFile, JSON.stringify({ sessionId, type: 'user', uuid: frame.uuid, message: frame.message }) + '\n')
        .then(() => socket.end(), error => socket.destroy(error));
    });
  });
  const recordFile = path.join(directory, `${process.pid}.json`);
  return { sessionId, received, recordFile,
    stale: { pid: 999999, sessionId, workspace, directory, transcriptFile, procStart: '1', pidDomain,
      recordFile: path.join(directory, '999999.json'), socketPath: '\\\\.\\pipe\\futureaide-rebind-gone' },
    async come() {
      await writeFile(recordFile, JSON.stringify({ pid: process.pid, sessionId, cwd: workspace, entrypoint: 'claude-desktop',
        pidDomain, procStart, messagingSocketPath: socketPath, status: 'idle' }));
      await writeFile(path.join(directory, `${process.pid}.${createHash('sha256').update(socketPath).digest('hex')}.key`),
        JSON.stringify({ peerToken: 'a'.repeat(32), procStart, pidDomain }));
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    },
    async close() {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous;
      if (server.listening) await new Promise(resolve => server.close(resolve));
    } };
}

function pendingReport(f, claude, name, delivery) {
  const ownerId = ownerIdForSource('claude-desktop', claude.sessionId);
  f.store.saveOwner({ ownerId, source: 'claude-desktop', nativeSessionId: claude.sessionId, workspace, binding: claude.stale });
  const report = { id: `report-${name}`, taskId: `task-${name}`, final: true, message: 'verified final artifact',
    treeSettledConfirmed: true, delivery: { id: `notice-${name}`, state: 'pending', ...delivery } };
  const task = { ...completedInput(name, [report]), result: { state: 'completed', reply: report.message } };
  f.store.insert(taskRecord({ agentId: name, ownerId, sessionId: `session-${name}`, name, target: 'codex-desktop', state: 'delivery_pending', task }));
  return ownerId;
}

const again = (f, name) => { const record = f.store.get(name); record.task.reports[0].delivery.nextAttemptAt = 0; f.store.save(record); return f.service.poll(name); };

test('a report reaches a Claude session that restarted, once, and the new binding is kept', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    await claude.come();
    const ownerId = pendingReport(f, claude, 'restart');
    await f.service.poll('restart');
    assert.equal(claude.received.length, 1, JSON.stringify(f.store.get('restart').task.reports[0].delivery));
    assert.equal(f.store.owner(ownerId).binding.pid, process.pid, 'the refreshed binding is saved, not just used once');
    assert.equal(f.store.owner(ownerId).pid, process.pid);
    await again(f, 'restart');
    assert.equal(f.store.get('restart').task.reports[0].delivery.state, 'delivered');
    assert.equal(claude.received.length, 1, 'read-back never resends the written notice');
  } finally { await claude.close(); f.service.close(); }
});

test('a notice stranded by the missing pid record resumes, and a written one stays read-only', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    await claude.come();
    const enoent = { code: 'ENOENT', message: `ENOENT: no such file or directory, open '${claude.stale.recordFile}'` };
    pendingReport(f, claude, 'stranded', { state: 'unknown', error: enoent });
    await f.service.poll('stranded');
    assert.equal(claude.received.length, 1, 'nothing was written before, so it may be sent');
    f.store.insert(taskRecord({ agentId: 'written', ownerId: ownerIdForSource('claude-desktop', claude.sessionId), sessionId: 'session-written', name: 'written',
      target: 'codex-desktop', state: 'delivery_pending', task: { ...completedInput('written', [{ id: 'report-written', taskId: 'task-written', final: true, message: 'sent once',
        treeSettledConfirmed: true, delivery: { id: 'notice-written', state: 'unknown' } }]), result: { state: 'completed', reply: 'sent once' } } }));
    await f.service.poll('written');
    assert.equal(claude.received.length, 1, 'an unknown outcome with no pre-write failure is never sent again');
  } finally { await claude.close(); f.service.close(); }
});

test('a notice waits for a session that is not running, then goes out when it returns', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    pendingReport(f, claude, 'absent');
    await f.service.poll('absent');
    const waiting = f.store.get('absent').task.reports[0].delivery;
    assert.equal(waiting.state, 'pending', 'nothing was written, so this is not an unknown outcome');
    assert.equal(waiting.error.code, 'callback-target-missing');
    await claude.come();
    await again(f, 'absent');
    assert.equal(claude.received.length, 1);
  } finally { await claude.close(); f.service.close(); }
});

test('a crashed session leaves its record behind and the notice still finds where it came back', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    await claude.come();
    // The dead process's record is still on disk and still matches, so only the pipe fails.
    const dead = { ...claude.stale, pid: process.pid, recordFile: claude.stale.recordFile };
    await writeFile(dead.recordFile, JSON.stringify({ pid: dead.pid, sessionId: dead.sessionId, cwd: workspace, entrypoint: 'claude-desktop',
      pidDomain: dead.pidDomain, procStart: dead.procStart, messagingSocketPath: dead.socketPath }));
    await writeFile(path.join(dead.directory, `${dead.pid}.${createHash('sha256').update(dead.socketPath).digest('hex')}.key`),
      JSON.stringify({ peerToken: 'a'.repeat(32), procStart: dead.procStart, pidDomain: dead.pidDomain }));
    const ownerId = pendingReport(f, { ...claude, stale: dead }, 'crashed');
    await f.service.poll('crashed');
    assert.equal(claude.received.length, 1, JSON.stringify(f.store.get('crashed').task.reports[0].delivery));
    assert.notEqual(f.store.owner(ownerId).binding.socketPath, dead.socketPath);
  } finally { await claude.close(); f.service.close(); }
});

// --- A caller that already read the final report settles it before ordering more ---

const claudeCaller = sessionId => ({ _meta: { threadId: THREAD },
  [TRUSTED_CALLER]: { source: 'claude-desktop', nativeSessionId: sessionId, workspace } });

/** The receipt Claude writes back within milliseconds of accepting a notice. */
const receiptIn = (claude, noticeId) => appendFile(claude.stale.transcriptFile, JSON.stringify({
  sessionId: claude.sessionId, type: 'user', uuid: claudeNoticeRequestId(noticeId),
  message: { content: 'futureaide notice received' } }) + '\n');

test('a caller that already read the final report orders the next task without waiting for delivery', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    await claude.come();
    pendingReport(f, claude, 'settle', { state: 'unknown' });
    await receiptIn(claude, 'notice-settle');
    const sent = await f.service.send({ name: 'settle', message: 'next order' }, claudeCaller(claude.sessionId));
    assert.equal(claude.received.length, 0, 'the receipt is read back, never written again');
    const current = f.store.get('settle');
    assert.equal(current.task.message, 'next order');
    assert.equal(current.state, 'running');
    const history = f.store.historyFor('settle');
    assert.equal(history.length, 1, 'the delivered task moved to history');
    assert.equal(history[0].taskId, 'task-settle');
    assert.equal(history[0].reports[0].delivery.state, 'delivered');
    assert.equal(sent.queued, true);
  } finally { await claude.close(); f.service.close(); }
});

test('a busy delivery_pending name waits for the poll lock instead of queueing onto a finished task', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    await claude.come();
    pendingReport(f, claude, 'busy', { state: 'unknown' });
    await receiptIn(claude, 'notice-busy');
    // A poll round holds this lock while it delivers and settles, so the dispatch below
    // must wait for it: queueing would attach a supplement to a task that has ended.
    let release;
    const held = f.store.locked('busy', () => new Promise(resolve => { release = resolve; }));
    const waits = [], lock = f.store.locked.bind(f.store);
    f.store.locked = (key, action, options) => { waits.push(options?.waitMs ?? 'default'); return lock(key, action, options); };
    try {
      const sending = f.service.send({ name: 'busy', message: 'next order' }, claudeCaller(claude.sessionId))
        .then(value => ({ value }), error => ({ error }));
      // A second lock attempt exists only after the first one was refused by the held
      // lease, so this waits for the retry instead of guessing a delay.
      for (let tick = 0; tick < 1000 && waits.length < 2; tick++) await new Promise(resolve => setImmediate(resolve));
      release(); await held;
      const { value, error } = await sending;
      assert.equal(error, undefined, 'a lock held for one poll round is never reported as a stopped task');
      assert.equal(value.queued, true);
      const current = f.store.get('busy');
      assert.equal(current.task.message, 'next order');
      assert.equal(current.state, 'running');
      const history = f.store.historyFor('busy');
      assert.equal(history.at(-1).taskId, 'task-busy', 'the settled task moved to history');
      assert.equal(history.at(-1).reports[0].delivery.state, 'delivered');
      assert.equal(claude.received.length, 0, 'the receipt is read back, never written again');
    } finally { f.store.locked = lock; }
  } finally { await claude.close(); f.service.close(); }
});

test('a final whose receipt has not landed yet still refuses the next task without writing it twice', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    await claude.come();
    pendingReport(f, claude, 'unread', { state: 'unknown' });
    const error = await f.service.send({ name: 'unread', message: 'next order' }, claudeCaller(claude.sessionId))
      .then(() => null, value => value);
    assert.match(error.message, /final report is waiting for delivery/);
    assert.equal(claude.received.length, 0, 'an ambiguous write is never sent a second time');
    const current = f.store.get('unread');
    assert.equal(current.state, 'delivery_pending');
    assert.equal(current.task.message, 'work', 'no second task was started');
    assert.equal(current.task.reports[0].delivery.state, 'unknown');
  } finally { await claude.close(); f.service.close(); }
});

test('settling a one-shot agent’s final closes it instead of dispatching another task', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    await claude.come();
    pendingReport(f, claude, 'once-settle', { state: 'unknown' });
    const record = f.store.get('once-settle'); record.lifetime = 'once'; f.store.save(record);
    await receiptIn(claude, 'notice-once-settle');
    const error = await f.service.send({ name: 'once-settle', message: 'next order' }, claudeCaller(claude.sessionId))
      .then(() => null, value => value);
    assert.match(error.message, /closing/);
    assert.equal(f.store.get('once-settle'), undefined, 'the settled one-shot name was cleaned up');
    assert.equal(claude.received.length, 0);
  } finally { await claude.close(); f.service.close(); }
});

test('a sleeping name settles its pending delivery and wakes for the next task', async () => {
  const f = await fixture({ adapters: { 'codex-desktop': fakeBackend() } });
  const claude = await restartedClaude();
  try {
    await claude.come();
    pendingReport(f, claude, 'sleepy', { state: 'unknown' });
    f.store.claimLease('idle-monitor', 'owner', 60000);
    f.store.claimLease('idle-monitor:ready', 'owner', 60000);
    assert.equal(f.store.sleep(f.store.get('sleepy'), 'baseline'), true);
    await receiptIn(claude, 'notice-sleepy');
    const sent = await f.service.send({ name: 'sleepy', message: 'next order' }, claudeCaller(claude.sessionId));
    const current = f.store.get('sleepy');
    assert.equal(current.sleep, undefined, 'the wake cleared the marker before the next dispatch');
    assert.equal(current.task.message, 'next order');
    assert.equal(current.state, 'running');
    assert.equal(sent.queued, true);
  } finally { await claude.close(); f.service.close(); }
});

// --- DSH cleanup outcomes: an unknown write queues, a refused destroy fails ---------

/** A DSH host whose only interesting answer is what its managedDestroy call returns. */
function fakeClient({ destroy }) {
  return {
    connectionIdentity: async () => ({ application: 'dsh', dataRoot: workspace }),
    hostStatus: async () => ({ methods: [], treeProtocol: 1, reportProtocol: 1 }),
    managedDestroy: async args => destroy(args),
  };
}

test('a DSH destroy whose write outcome is unknown stays queued instead of failing cleanup', async () => {
  let attempts = 0;
  const client = fakeClient({ destroy: async () => {
    attempts++;
    // The client gave up on a slow host: the delete may or may not have happened.
    if (attempts === 1) throw Object.assign(new Error('The FutureAide write outcome is unknown.'), { code: 'timeout', uncertain: true });
    return { destroyed: true };
  } });
  let monitors = 0;
  const f = await fixture({ clientFactory: () => client, startSharedMonitor: () => { monitors++; return true; } });
  try {
    f.store.insert(taskRecord({ agentId: 'agent-dsh-unknown', ownerId: ownerIdFor(THREAD), sessionId: 'session-dsh-unknown',
      name: 'unknown', target: 'dsh', nativeDestroyed: false }));
    const queued = await f.service.delete({ name: 'unknown' }, extra(THREAD));
    assert.equal(queued.deleted, false);
    assert.equal(queued.queued, true);
    assert.equal(queued.state, 'cleaning', 'the host may still be finishing its own cleanup');
    assert.equal(queued.error, undefined, 'a queued cleanup is never reported as a failure');
    const record = f.store.get('agent-dsh-unknown');
    assert.equal(record.state, 'cleaning');
    assert.equal(record.nextAttemptAt > Date.now(), true, 'the retry is deferred, not dropped');
    assert.equal(monitors > 0, true, 'a queued cleanup has a listener to retry it, whatever the caller does next');
    record.nextAttemptAt = 0; f.store.save(record);
    assert.equal((await f.service.poll('agent-dsh-unknown')).deleted, true);
    assert.equal(f.store.get('agent-dsh-unknown'), undefined, 'the name is removed once the host confirms');
    assert.equal(attempts, 2);
  } finally { f.service.close(); }
});

test('a DSH destroy the host does not confirm stays a visible cleanup failure', async () => {
  const client = fakeClient({ destroy: async () => ({ destroyed: false, message: 'DSH has not confirmed complete session cleanup.' }) });
  const f = await fixture({ clientFactory: () => client });
  try {
    f.store.insert(taskRecord({ agentId: 'agent-dsh-refused', ownerId: ownerIdFor(THREAD), sessionId: 'session-dsh-refused',
      name: 'refused', target: 'dsh', nativeDestroyed: false }));
    const failed = await f.service.delete({ name: 'refused' }, extra(THREAD));
    assert.equal(failed.deleted, false);
    assert.equal(failed.state, 'cleanup_failed');
    assert.match(failed.error.message, /has not confirmed complete session cleanup/);
    assert.equal(f.store.get('agent-dsh-refused').state, 'cleanup_failed', 'a refused destroy stays listed and retryable');
  } finally { f.service.close(); }
});

test('a DSH parent waits while its child’s cleanup is queued instead of failing', async () => {
  const rootId = 'agent-' + 'a'.repeat(32), childId = 'agent-' + 'b'.repeat(32);
  const client = fakeClient({ destroy: async ({ agentId }) => {
    if (agentId === childId) throw Object.assign(new Error('The FutureAide write outcome is unknown.'), { code: 'timeout', uncertain: true });
    return { destroyed: true };
  } });
  const f = await fixture({ clientFactory: () => client });
  try {
    f.store.insert(taskRecord({ agentId: rootId, ownerId: ownerIdFor(THREAD), sessionId: 'session-root', name: 'root', target: 'dsh' }));
    f.store.insert(taskRecord({ agentId: childId, ownerId: ownerIdFor(THREAD), sessionId: 'session-child', name: 'child',
      target: 'dsh', parentAgentId: rootId, nativeDestroyed: false }));
    const queued = await f.service.delete({ name: 'root' }, extra(THREAD));
    assert.equal(queued.queued, true);
    assert.equal(queued.state, 'cleaning', 'a child that queued is not a parent failure');
    assert.equal(queued.error, undefined);
    assert.equal(f.store.get(rootId).state, 'cleaning');
    assert.equal(f.store.get(childId).state, 'cleaning');
  } finally { f.service.close(); }
});

test('a child held by its own poll makes a DSH parent wait instead of failing', async () => {
  const rootId = 'agent-' + 'c'.repeat(32), childId = 'agent-' + 'd'.repeat(32);
  const client = fakeClient({ destroy: async () => ({ destroyed: true }) });
  const f = await fixture({ clientFactory: () => client });
  try {
    f.store.insert(taskRecord({ agentId: rootId, ownerId: ownerIdFor(THREAD), sessionId: 'session-root', name: 'root', target: 'dsh' }));
    f.store.insert(taskRecord({ agentId: childId, ownerId: ownerIdFor(THREAD), sessionId: 'session-child', name: 'child', target: 'dsh', parentAgentId: rootId }));
    let release;
    const holding = f.store.locked(childId, () => new Promise(resolve => { release = resolve; }));
    const queued = await f.service.delete({ name: 'root' }, extra(THREAD));
    assert.equal(queued.queued, true, JSON.stringify(queued));
    assert.equal(f.store.get(rootId).state, 'cleaning');
    release(); await holding;
  } finally { f.service.close(); }
});

test('status does not trust a record left behind by a dead process', async () => {
  const f = await fixture();
  const claude = await restartedClaude();
  try {
    const { stale } = claude;
    await writeFile(stale.recordFile, JSON.stringify({ pid: stale.pid, sessionId: stale.sessionId, cwd: workspace, entrypoint: 'claude-desktop',
      pidDomain: stale.pidDomain, procStart: stale.procStart, messagingSocketPath: stale.socketPath }));
    const ownerId = ownerIdForSource('claude-desktop', claude.sessionId);
    f.store.saveOwner({ ownerId, source: 'claude-desktop', nativeSessionId: claude.sessionId, workspace, binding: stale });
    const caller = { [TRUSTED_CALLER]: { source: 'claude-desktop', nativeSessionId: claude.sessionId, workspace } };
    assert.equal((await f.service.status(caller)).returnChannel, 'unavailable', 'the record matches, but no process stands behind it');
    await claude.come();
    assert.equal((await f.service.status(caller)).returnChannel, 'chat-verified');
    assert.equal(f.store.owner(ownerId).binding.pid, process.pid);
  } finally { await claude.close(); f.service.close(); }
});

test('status proves the way back to a Claude caller instead of assuming it', async () => {
  const f = await fixture();
  const claude = await restartedClaude();
  try {
    const ownerId = ownerIdForSource('claude-desktop', claude.sessionId);
    f.store.saveOwner({ ownerId, source: 'claude-desktop', nativeSessionId: claude.sessionId, workspace, binding: claude.stale });
    const caller = { [TRUSTED_CALLER]: { source: 'claude-desktop', nativeSessionId: claude.sessionId, workspace } };
    const absent = await f.service.status(caller);
    assert.equal(absent.returnChannel, 'unavailable', 'a binding with no live session is not a verified channel');
    assert.equal(absent.returnChannelError.code, 'callback-target-missing');
    assert.equal(absent.ready, false);
    await claude.come();
    const live = await f.service.status(caller);
    assert.equal(live.returnChannel, 'chat-verified');
    assert.equal(f.store.owner(ownerId).binding.pid, process.pid, 'status repairs what it verified');
  } finally { await claude.close(); f.service.close(); }
});
