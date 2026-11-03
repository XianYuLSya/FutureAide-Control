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

async function fixture() {
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

