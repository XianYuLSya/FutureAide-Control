import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RosterStore } from '../src/roster-store.mjs';

function largeRecord() {
  return {
    agentId: 'agent-large',
    ownerId: 'owner-a',
    name: 'large',
    sessionId: 'session-a',
    state: 'awaiting_report',
    history: [{ message: 'HISTORY_SECRET'.repeat(100) }],
    task: {
      taskId: 'task-a',
      message: 'TASK_SECRET'.repeat(100),
      reports: [{ id: 'report-a', message: 'REPORT_SECRET'.repeat(100), final: true, delivery: { state: 'pending' } }],
    },
    observation: { questions: [], tree: { settled: true, running: false } },
    sleep: { taskId: 'task-a', sessionId: 'session-a', signal: 'baseline' },
  };
}

test('roster lifecycle projections omit task, report and history bodies', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(largeRecord());
    assert.equal(store.count('owner-a'), 1);
    assert.equal(store.hasSleeping(), true);

    const sleeping = store.listSleeping();
    const workers = store.listWorkerCandidates();
    const pending = store.listPendingDeliveries();
    assert.equal(sleeping.length, 1);
    assert.equal(workers.length, 1);
    assert.deepEqual(pending, [{ agentId: 'agent-large', taskId: 'task-a', sessionId: 'session-a' }]);
    assert.equal(workers[0].task.reports[0].delivery.state, 'pending');
    for (const value of [sleeping, workers, pending]) assert.ok(!JSON.stringify(value).includes('_SECRET'));
  } finally { store.close(); }
});

test('pending delivery projection honors report delivery and question notice state', () => {
  const store = new RosterStore(':memory:');
  try {
    const value = largeRecord();
    value.task.reports[0].delivery.state = 'delivered';
    value.observation.questions = [{ id: 'q-a', state: 'pending' }];
    value.task.questionNotices = {};
    store.insert(value);
    assert.deepEqual(store.listPendingDeliveries().map(item => item.agentId), ['agent-large']);

    value.task.questionNotices['q-a'] = { state: 'delivered' };
    store.save(value);
    assert.deepEqual(store.listPendingDeliveries(), []);
  } finally { store.close(); }
});

test('native-only rosters use an indexed empty descendant lookup and preserve closed projections', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert({ ...largeRecord(), closed: true });
    assert.equal(store.listWorkerCandidates()[0].closed, true);
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT id FROM agents INDEXED BY agents_parent_v2 WHERE json_extract(body,'$.parentAgentId')=? ORDER BY name").all('agent-large');
    assert.ok(plan.some(row => /USING INDEX agents_parent/.test(row.detail)), JSON.stringify(plan));
    assert.deepEqual(store.descendantsOf(['agent-large']), []);
    store.insert({ ...largeRecord(), agentId: 'child', name: 'child', parentAgentId: 'agent-large' });
    assert.deepEqual(store.descendantsOf(['agent-large']).map(row => row.agentId), ['child']);
  } finally { store.close(); }
});

test('a quiet save of a large unchanged body writes nothing', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(largeRecord());
    const record = store.get('agent-large');
    const updatedAt = record.updatedAt;
    const changes = store.db.prepare('SELECT total_changes() AS n').get().n;
    store.save(record);
    assert.equal(record.updatedAt, updatedAt, 'the quiet round did not stamp a write');
    assert.equal(store.db.prepare('SELECT total_changes() AS n').get().n, changes);
  } finally { store.close(); }
});

test('a commit another process lands right after a save is not hidden by the cached body', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'futureaide-save-race-')), 'roster.sqlite');
  const store = new RosterStore(file);
  const other = new DatabaseSync(file);
  try {
    store.insert(largeRecord());
    const record = store.get('agent-large');
    record.state = 'running';
    // The other process commits the moment this save's own UPDATE has committed.
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = sql => {
      const statement = prepare(sql);
      if (!sql.includes('RETURNING body')) return statement;
      return { get: (...args) => {
        const row = statement.get(...args);
        other.prepare("UPDATE agents SET body=json_set(body,'$.external',json('true')) WHERE id=?").run('agent-large');
        return row;
      } };
    };
    store.save(record);
    delete store.db.prepare;
    assert.equal(store.get('agent-large').external, true, 'the next read sees the other process commit');
  } finally { other.close(); store.close(); }
});

test('an unchanged backend state is not rewritten, and a removed name still answers false', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(largeRecord());
    const state = { binding: { sessionId: 's' }, projections: { s: { messages: ['x'.repeat(1000)] } } };
    assert.equal(store.saveBackendState('agent-large', state), true);
    const changes = store.changed();
    assert.equal(store.saveBackendState('agent-large', structuredClone(state)), true, 'an identical document still finds the name');
    assert.equal(store.changed(), changes, 'and writes nothing');
    assert.equal(store.saveBackendState('agent-large', { ...state, extra: 1 }), true);
    assert.equal(store.changed(), changes + 1, 'a changed document is written');
    assert.equal(store.backendState('agent-large').extra, 1);
    assert.equal(store.saveBackendState('agent-missing', state), false, 'a removed name is still reported');
  } finally { store.close(); }
});

test('taking and releasing a lease keeps the cached body and sweep', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(largeRecord());
    store.get('agent-large');
    store.listWorkerCandidates();
    const prepare = store.db.prepare.bind(store.db);
    const reads = [];
    store.db.prepare = sql => {
      if (/SELECT body FROM agents WHERE id=\?|INDEXED BY agents_lifecycle_v2/.test(sql)) reads.push(sql);
      return prepare(sql);
    };
    await store.locked('agent-large', async () => { store.get('agent-large'); store.listWorkerCandidates(); });
    store.get('agent-large');
    store.listWorkerCandidates();
    delete store.db.prepare;
    assert.deepEqual(reads, [], 'neither the body nor the sweep was read again');
    // A write that bypasses the store still invalidates both.
    store.db.prepare("UPDATE agents SET body=json_set(body,'$.state','running') WHERE id=?").run('agent-large');
    assert.equal(store.get('agent-large').state, 'running');
    assert.equal(store.listWorkerCandidates()[0].state, 'running');
  } finally { store.close(); }
});

test('the roster commits without a disk flush per transaction', () => {
  const file = path.join(mkdtempSync(path.join(os.tmpdir(), 'futureaide-sync-')), 'roster.sqlite');
  const store = new RosterStore(file);
  try {
    assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    assert.equal(store.db.prepare('PRAGMA synchronous').get().synchronous, 1, 'NORMAL: the WAL is synced at checkpoints');
  } finally { store.close(); }
});

test('lifecycle scans use covering fields and immediately reflect direct roster writes', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(largeRecord());
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT json_extract(body,'$.state'),json_extract(body,'$.task.reports') FROM agents INDEXED BY agents_lifecycle").all();
    assert.ok(plan.some(row => /COVERING INDEX agents_lifecycle/.test(row.detail)), JSON.stringify(plan));
    // A separate plugin connection can write body directly; no cache-invalidation
    // protocol is needed to see a changed delivery, wake or task state.
    store.db.prepare("UPDATE agents SET body=json_remove(json_set(body,'$.state','running','$.task.reports[0].delivery.state','delivered'),'$.sleep') WHERE id=?").run('agent-large');
    const candidate = store.listWorkerCandidates()[0];
    assert.equal(candidate.state, 'running');
    assert.equal(candidate.task.reports[0].delivery.state, 'delivered');
    assert.equal(store.hasSleeping(), false);
    assert.deepEqual(store.listSleeping(), []);
    assert.ok(!JSON.stringify(candidate).includes('_SECRET'));
  } finally { store.close(); }
});

test('an explicit repeat cancel reopens native verification for newly observed background work', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = largeRecord(); record.state = 'cancelled'; delete record.sleep;
    Object.assign(record.task, { cancelRequested: true, cancelVerified: true, cancelTreeSettled: true, cancelPending: false });
    store.insert(record);
    assert.equal(store.requestCancel(record), true);
    const current = store.get(record.agentId);
    assert.equal(current.state, 'running');
    assert.equal(current.task.cancelPending, true);
    assert.equal(current.task.cancelTreeSettled, false);
    assert.equal(current.task.taskId, record.task.taskId);
  } finally { store.close(); }
});
