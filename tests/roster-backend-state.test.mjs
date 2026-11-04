import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RosterStore } from '../src/roster-store.mjs';

function agent(overrides = {}) {
  return { agentId: 'agent-a', ownerId: 'owner-a', name: 'artist', lifetime: 'persistent', target: 'claude-desktop',
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
      { binding: { sessionId: 'native-1', pid: 4321, transcriptFile: 'D:\\t.jsonl' }, cursor: 7,
        requests: { 'request-1': { attempted: true, stage: 'written' } }, projection: { running: false } }), true);

    assert.deepEqual(store.backendState(record.agentId).binding, { sessionId: 'native-1', pid: 4321, transcriptFile: 'D:\\t.jsonl' });
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

test('a native session resolves to its live claude-desktop name only', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(agent({ agentId: 'agent-claude', name: 'partner', sessionId: 'session-codex-c' }));
    store.saveBackendState('agent-claude', { binding: { sessionId: 'native-c', pid: 1 }, cursor: 3 });
    store.insert(agent({ agentId: 'agent-dsh', name: 'artist', sessionId: 'session-codex-d', target: 'dsh' }));
    store.saveBackendState('agent-dsh', { binding: { sessionId: 'native-d' } });
    store.insert(agent({ agentId: 'agent-closed', name: 'retired', sessionId: 'session-codex-e', closed: true }));
    store.saveBackendState('agent-closed', { binding: { sessionId: 'native-e' } });

    const found = store.agentForNativeSession('native-c');
    assert.equal(found.agentId, 'agent-claude');
    assert.equal(found.name, 'partner');
    assert.equal(found.target, 'claude-desktop');
    assert.equal(found.ownerId, 'owner-a');
    assert.equal(found.logicalSessionId, 'session-codex-c');
    assert.equal(found.nativeSessionId, 'native-c');
    assert.deepEqual(found.binding, { sessionId: 'native-c', pid: 1 });

    assert.equal(store.agentForNativeSession('native-d'), undefined, 'a dsh name is not a claude caller');
    assert.equal(store.agentForNativeSession('native-e'), undefined, 'a closed name is not a caller');
    assert.equal(store.agentForNativeSession('native-unknown'), undefined);
    assert.equal(store.agentForNativeSession(''), undefined);
    assert.equal(store.agentForNativeSession(undefined), undefined);
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

test('only open claude-desktop bindings are offered for watching', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(agent({ agentId: 'agent-claude', name: 'partner' }));
    store.saveBackendState('agent-claude', { binding: { sessionId: 'native-c', transcriptFile: 'D:\\claude\\projects\\p\\native-c.jsonl' } });
    store.insert(agent({ agentId: 'agent-closed', name: 'retired', closed: true }));
    store.saveBackendState('agent-closed', { binding: { sessionId: 'native-e', transcriptFile: 'D:\\claude\\projects\\p\\native-e.jsonl' } });
    store.insert(agent({ agentId: 'agent-dsh', name: 'artist', target: 'dsh' }));
    store.saveBackendState('agent-dsh', { binding: { sessionId: 'native-d', transcriptFile: 'D:\\dsh\\native-d.log' } });
    store.insert(agent({ agentId: 'agent-nobinding', name: 'blank' }));

    assert.deepEqual(store.listClaudeBindings().map(binding => binding.sessionId), ['native-c']);
  } finally { store.close(); }
});

test('an idle reservation keeps its target open, a closed name does not', () => {
  const store = new RosterStore(':memory:');
  try {
    assert.equal(store.hasOpenTarget('claude-desktop'), false);
    // A zero-model reservation has no native binding yet, and still counts: the
    // listener that will serve its first turn must not retire while it exists.
    store.insert(agent({ agentId: 'agent-reserved', name: 'reserved' }));
    assert.equal(store.hasOpenTarget('claude-desktop'), true);
    assert.deepEqual(store.listClaudeBindings(), [], 'a reservation has no transcript to watch yet');
    store.insert(agent({ agentId: 'agent-dsh', name: 'artist', target: 'dsh' }));
    assert.equal(store.hasOpenTarget('dsh'), true);
    assert.equal(store.hasOpenTarget('claude-desktop'), true);
    const closed = store.get('agent-reserved'); closed.closed = true; store.save(closed);
    assert.equal(store.hasOpenTarget('claude-desktop'), false, 'a closed name no longer holds the listener open');
  } finally { store.close(); }
});

test('target state and the reverse lookup share the roster database across processes', async () => {
  const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const filename = path.join(await mkdtemp(path.join(base, 'state-')), 'roster.sqlite');
  const writer = new RosterStore(filename);
  writer.insert(agent({ agentId: 'agent-claude', name: 'partner' }));
  writer.saveBackendState('agent-claude', { binding: { sessionId: 'native-x' }, cursor: 11 });
  writer.close();

  // A second process (the reply surface) reads the same file without any new database.
  const reader = new RosterStore(filename);
  try {
    assert.equal(reader.backendState('agent-claude').cursor, 11);
    assert.equal(reader.agentForNativeSession('native-x').name, 'partner');
  } finally { reader.close(); }
});
