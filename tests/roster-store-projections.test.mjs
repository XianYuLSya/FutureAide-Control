import test from 'node:test';
import assert from 'node:assert/strict';
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
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT body FROM agents WHERE json_extract(body,'$.parentAgentId')=? ORDER BY name").all('agent-large');
    assert.ok(plan.some(row => /USING INDEX agents_parent/.test(row.detail)), JSON.stringify(plan));
    assert.deepEqual(store.descendantsOf(['agent-large']), []);
    store.insert({ ...largeRecord(), agentId: 'child', name: 'child', parentAgentId: 'agent-large' });
    assert.deepEqual(store.descendantsOf(['agent-large']).map(row => row.agentId), ['child']);
  } finally { store.close(); }
});
