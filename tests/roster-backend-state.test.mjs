import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RosterStore } from '../src/roster-store.mjs';

function agent(overrides = {}) {
  return { agentId: 'agent-a', ownerId: 'owner-a', name: 'artist', lifetime: 'persistent', target: 'codex-desktop',
    sessionId: 'session-codex-a', workspace: 'D:\\Work\\fixture', state: 'idle', created: true,
    createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', history: [], ...overrides };
}

test('target state is stored beside the roster, never inside the record', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = agent();
    store.insert(record);
    assert.equal(store.backendState(record.agentId), undefined);
    assert.equal(store.saveBackendState(record.agentId,
      { binding: { sessionId: 'native-1', pid: 4321, threadId: 'T-1' }, cursor: 7,
        requests: { 'request-1': { attempted: true, stage: 'written' } }, projection: { running: false } }), true);

    assert.deepEqual(store.backendState(record.agentId).binding, { sessionId: 'native-1', pid: 4321, threadId: 'T-1' });
    assert.equal(store.backendState(record.agentId).cursor, 7);
    assert.equal(store.get(record.agentId).binding, undefined, 'the shared record stays free of target-native fields');

    // Replacing the document is an upsert on the same row.
    store.saveBackendState(record.agentId, { binding: { sessionId: 'native-2' }, cursor: 9 });
    assert.deepEqual(store.backendState(record.agentId), { binding: { sessionId: 'native-2' }, cursor: 9 });

    // A later save of a record loaded before that write cannot erase it.
    const stale = store.get(record.agentId);
    store.save({ ...stale, state: 'running' });
    assert.equal(store.backendState(record.agentId).cursor, 9);
  } finally { store.close(); }
});

test('a state write for a removed name is refused instead of leaving an orphan row', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = agent();
    store.insert(record);
    store.saveBackendState(record.agentId, { binding: { sessionId: 'native-1' } });
    store.remove(record);
    assert.equal(store.backendState(record.agentId), undefined, 'remove() clears the state row');
    assert.equal(store.saveBackendState(record.agentId, { binding: { sessionId: 'native-9' } }), false);
    assert.equal(store.backendState(record.agentId), undefined);
  } finally { store.close(); }
});

test('the listener can tell an external commit from its own write', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const filename = path.join(await mkdtemp(path.join(base, 'version-')), 'roster.sqlite');
  const listener = new RosterStore(filename);
  try {
    const start = listener.dataVersion();
    assert.equal(typeof start, 'number');
    listener.insert(agent({ agentId: 'agent-a', name: 'artist' }));
    assert.equal(listener.dataVersion(), start, 'own commits do not move this connection’s counter');
    listener.saveBackendState('agent-a', { cursor: 1 });
    assert.equal(listener.dataVersion(), start, 'own state writes are silent too');

    // A different connection committing is what a listener must react to.
    const other = new RosterStore(filename);
    try {
      other.insert(agent({ agentId: 'agent-b', name: 'partner', target: 'dsh' }));
      assert.notEqual(listener.dataVersion(), start, 'an external commit is visible');
    } finally { other.close(); }
  } finally { listener.close(); }
});

test('target state is shared across processes through the same roster database', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const filename = path.join(await mkdtemp(path.join(base, 'state-')), 'roster.sqlite');
  const writer = new RosterStore(filename);
  writer.insert(agent({ agentId: 'agent-codex', name: 'partner' }));
  writer.saveBackendState('agent-codex', { binding: { sessionId: 'native-x', threadId: 'T-x' }, cursor: 11 });
  writer.close();

  // A second process (the reply surface) reads the same file without any new database.
  const reader = new RosterStore(filename);
  try {
    assert.equal(reader.backendState('agent-codex').cursor, 11);
    assert.deepEqual(reader.backendState('agent-codex').binding, { sessionId: 'native-x', threadId: 'T-x' });
    assert.equal(reader.agentForCodexThread('t-x').name, 'partner');
  } finally { reader.close(); }
});
