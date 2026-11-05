// A roster written by an older build still carries records for the target this
// build removed. Those records are history: they must stay readable, keep their
// own bytes, and never be handed to a backend. The other assistants in the same
// roster must be unaffected.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';
import { REMOVED_TARGETS, TARGETS, normalizeTarget, targetOf } from '../src/agent-backend.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });
const LEGACY = '正式双向验收';
const LEGACY_ID = 'agent-' + 'c'.repeat(32);
const OPEN_ID = 'agent-' + 'd'.repeat(32);

function legacyRecord({ agentId = LEGACY_ID, name = LEGACY, closed = true } = {}) {
  return { agentId, ownerId: ownerIdFor(A), sessionId: 'session-' + agentId.slice(6, 12),
    name, lifetime: 'persistent', target: 'claude-desktop', workspace, created: true,
    state: closed ? 'cleanup_failed' : 'idle',
    ...(closed ? { closed: true } : {}),
    createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', history: [] };
}

function dshFixture(calls) {
  return {
    async connectionIdentity() { calls.push('identity'); return { application: 'dsh', dataRoot: path.join(workspace, 'clean', 'removed-target-fixture') }; },
    async hostStatus() {
      calls.push('hostStatus');
      return { treeProtocol: 1, reportProtocol: 1, methods: ['managedCreate', 'managedBeginTask', 'managedStatus',
        'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy'] };
    },
    async managedCreate() { calls.push('managedCreate'); return { sessionId: 'never', modelRequestsStarted: 0 }; },
    async managedBeginTask() { calls.push('managedBeginTask'); return { treeProtocol: 1, reportProtocol: 1 }; },
    async managedStatus() { calls.push('managedStatus'); return { questions: [], reports: [], changes: [], tree: { settled: true, running: false, nodes: [] } }; },
    async historyCursor() { calls.push('historyCursor'); return { throughSeq: 0 }; },
  };
}

async function fixture(records = [legacyRecord()]) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'removed-target-'));
  const calls = [];
  const store = new RosterStore(':memory:');
  for (const record of records) store.insert(record);
  const api = dshFixture(calls);
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store,
    clientFactory: () => api,
    controlFactory: () => ({ async send() { calls.push('send'); return { accepted: true, afterSeq: 1 }; },
      async wait() { return { state: 'running' }; }, async models() { return { default: {}, groups: [] }; },
      async selectModel() { return { accepted: true }; } }),
    callCodex: async (threadId, tool) => (tool === 'read_thread'
      ? { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } } : { accepted: true }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  return { service, store, calls, stateDirectory,
    body: agentId => store.db.prepare('SELECT body FROM agents WHERE id=?').get(agentId)?.body };
}

test('the removed target is not one of the offered targets', () => {
  assert.deepEqual([...TARGETS], ['dsh', 'codex-desktop']);
  assert.deepEqual([...REMOVED_TARGETS], ['claude-desktop']);
  assert.throws(() => normalizeTarget('claude-desktop'), error => error.code === 'invalid-target');
  // Reading a stored record is not creation: the legacy value survives the read.
  assert.equal(targetOf(legacyRecord()), 'claude-desktop');
  assert.equal(targetOf({ target: undefined }), 'dsh');
});

test('a closed record for the removed target stays listed with its own bytes', async () => {
  const f = await fixture();
  try {
    const before = f.body(LEGACY_ID);
    const listed = await f.service.list(extra(A));
    const entry = listed.items.find(item => item.name === LEGACY);
    assert.equal(entry.target, 'claude-desktop', 'the stored target is reported as stored');
    assert.equal(entry.state, 'cleanup_failed');
    assert.equal(listed.total, 1);
    assert.equal(f.body(LEGACY_ID), before, 'listing never rewrites the record');
    assert.deepEqual(f.calls, [], 'no backend was asked about it');
  } finally { f.service.close(); }
});

test('status and wait answer normally while that record exists', async () => {
  const f = await fixture();
  try {
    const status = await f.service.status(extra(A));
    assert.equal(status.ready, true, 'the installation itself is still ready');
    assert.equal(status.contextVerified, true);
    assert.equal(status.agents, 1);
    assert.deepEqual(Object.keys(status.backends).sort(), ['codex-desktop', 'dsh']);

    const waited = await f.service.wait({ names: [LEGACY], timeoutSeconds: 0 }, extra(A));
    assert.equal(waited.items.length, 1);
    assert.equal(waited.items[0].target, 'claude-desktop');
    assert.deepEqual(waited.notListed, []);
  } finally { f.service.close(); }
});

test('the monitor sweep keeps running and leaves that record untouched', async () => {
  const f = await fixture();
  try {
    const before = f.body(LEGACY_ID);
    const busy = await f.service.monitorScan({ sweep: true });
    assert.equal(busy, false, 'a closed record owes no poll');
    assert.equal(f.body(LEGACY_ID), before, 'the sweep never rewrote it');
    assert.deepEqual(f.calls, [], 'and never spoke to a backend on its behalf');
  } finally { f.service.close(); }
});

test('another assistant in the same roster is unaffected', async () => {
  const f = await fixture([legacyRecord(),
    { agentId: 'agent-' + 'a'.repeat(32), ownerId: ownerIdFor(A), sessionId: 'session-dsh', name: '画图助手',
      lifetime: 'persistent', target: 'dsh', workspace, created: true, state: 'idle',
      createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', history: [] }]);
  try {
    const listed = await f.service.list(extra(A));
    assert.deepEqual(listed.items.map(item => [item.name, item.target]).sort(),
      [['正式双向验收', 'claude-desktop'], ['画图助手', 'dsh']].sort());
    const receipt = await f.service.send({ name: '画图助手', message: '继续' }, extra(A));
    assert.notEqual(receipt.error?.code, 'backend-not-ready', 'its failure, if any, is its own and not the removed target');
    assert.equal(f.store.get('agent-' + 'a'.repeat(32)).target, 'dsh');
    assert.ok(f.calls.includes('managedBeginTask'), 'its own task started on the DSH bridge');
  } finally { f.service.close(); }
});

test('an operation that needs a backend refuses with backend-not-ready, not a host call', async () => {
  const f = await fixture();
  try {
    const before = f.body(LEGACY_ID);
    await assert.rejects(f.service.inspect({ name: LEGACY }, extra(A)), error => {
      assert.equal(error.code, 'backend-not-ready');
      assert.match(error.message, /claude-desktop target was removed from this build/);
      assert.match(error.message, /read-only/);
      return true;
    });
    assert.deepEqual(f.calls, [], 'nothing was sent to the DSH host or any other application');
    assert.equal(f.body(LEGACY_ID), before, 'a refused operation does not rewrite the record either');
  } finally { f.service.close(); }
});

test('an open record for the removed target is recorded as backend-not-ready instead of crashing the loop', async () => {
  const f = await fixture([legacyRecord({ agentId: OPEN_ID, name: '旧会话', closed: false })]);
  try {
    const sent = await f.service.send({ name: '旧会话', message: '继续' }, extra(A));
    assert.equal(sent.queued, true, 'the intent is durable, as for any desktop target');
    await f.service.monitorScan({ sweep: true });
    // The sweep starts each poll and returns before it finishes; wait for the work.
    await f.service.drainPolls();
    const record = f.store.get(OPEN_ID);
    assert.equal(record.error.code, 'backend-not-ready');
    assert.match(record.error.message, /claude-desktop target was removed from this build/);
    assert.equal(record.name, '旧会话', 'the record keeps its own identity');
    assert.equal(record.target, 'claude-desktop');
    assert.deepEqual(f.calls, [], 'no DSH call was made for it, and no local UI work either');
  } finally { f.service.close(); }
});
