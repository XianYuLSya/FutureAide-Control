import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { RosterStore } from '../src/roster-store.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = (id, name) => ({
  agentId: `agent-${id.repeat(32)}`, ownerId: 'owner-test', sessionId: `session-${id}`,
  name, lifetime: 'persistent', workspace, state: 'running', created: true,
  task: { taskId: `task-${id}`, state: 'running', dispatches: [] },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [],
});

async function directory() {
  const base = path.join(workspace, '.runtime', 'tests', 'roster-selection');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'run-'));
}

test('queued supplements freeze an explicit selection or the live pin', async () => {
  const store = new RosterStore(':memory:');
  try {
    const record = agent('a', 'artist');
    store.insert(record);
    assert.equal(store.enqueueSupplement(record, 'request-explicit', 'one',
      { provider: 'p', model: 'full-model', reasoningEffort: 'high' }), true);
    assert.deepEqual(store.supplements(record.agentId)[0].selection,
      { provider: 'p', model: 'full-model', reasoningEffort: 'high' });

    record.modelPin = { provider: 'p', model: 'pinned-model', reasoningEffort: 'low' };
    store.save(record);
    assert.equal(store.enqueueSupplement(record, 'request-pin', 'two', undefined, { usePinnedModel: true }), true);
    assert.deepEqual(store.supplements(record.agentId).at(-1).selection,
      { provider: 'p', model: 'pinned-model', reasoningEffort: 'low' },
      'the SQL copies the pin at enqueue time');

    const noPin = agent('b', 'other');
    store.insert(noPin);
    assert.equal(store.enqueueSupplement(noPin, 'request-none', 'three', undefined, { usePinnedModel: true }), true);
    assert.equal(store.supplements(noPin.agentId)[0].selection, undefined,
      'no pin leaves the input on the target default');
  } finally { store.close(); }
});

test('an explicit pin and its queued supplement commit or roll back together', async () => {
  const store = new RosterStore(':memory:');
  try {
    const record = agent('c', 'writer');
    record.modelPin = { provider: 'p', model: 'old-model' };
    store.insert(record);
    record.modelPin = { provider: 'p', model: 'new-model', reasoningEffort: 'high' };
    assert.equal(store.enqueueSupplement(record, 'request-atomic', 'do it',
      { provider: 'p', model: 'new-model', reasoningEffort: 'high' }, { saveRecord: true }), true);
    assert.deepEqual(store.get(record.agentId).modelPin,
      { provider: 'p', model: 'new-model', reasoningEffort: 'high' });
    assert.deepEqual(store.supplements(record.agentId)[0].selection,
      { provider: 'p', model: 'new-model', reasoningEffort: 'high' });

    // Make the INSERT SELECT fail (creating is not a supplement state). The pin
    // write in the same transaction must roll back with it. `idle` would be
    // promoted back to running by save() while a supplement is queued.
    record.state = 'creating';
    record.modelPin = { provider: 'p', model: 'rejected-model' };
    assert.equal(store.enqueueSupplement(record, 'request-rollback', 'no',
      { provider: 'p', model: 'rejected-model' }, { saveRecord: true }), false);
    assert.deepEqual(store.get(record.agentId).modelPin,
      { provider: 'p', model: 'new-model', reasoningEffort: 'high' });
    assert.equal(store.supplements(record.agentId).some(item => item.requestId === 'request-rollback'), false);
  } finally { store.close(); }
});

test('an older roster gains the selection column without losing queued rows', async () => {
  const dir = await directory();
  const file = path.join(dir, 'roster.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE supplements (requestId TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL,
    session TEXT NOT NULL, task TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created TEXT NOT NULL);
    INSERT INTO supplements(requestId,owner,agent,session,task,message,status,created)
      VALUES ('legacy','owner-test','agent-old','session-old','task-old','keep me','queued','2026-01-01T00:00:00.000Z');`);
  old.close();
  for (let pass = 0; pass < 2; pass++) {
    const store = new RosterStore(file);
    try {
      const columns = store.db.prepare('PRAGMA table_info(supplements)').all().map(row => row.name);
      assert.ok(columns.includes('selection'));
      const row = store.db.prepare("SELECT message,selection FROM supplements WHERE requestId='legacy'").get();
      assert.equal(row.message, 'keep me');
      assert.equal(row.selection, null);
    } finally { store.close(); }
  }
});
