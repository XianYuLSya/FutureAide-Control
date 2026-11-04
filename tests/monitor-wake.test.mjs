// The shared monitor's wake path: work queued inside this process is a hint, and a
// hint for a name whose own poll is still running is handed back, not dropped.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RosterStore } from '../src/roster-store.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';

function build({ removeTree, onPollComplete } = {}) {
  const store = new RosterStore(':memory:');
  const queued = [];
  const stateDirectory = mkdtempSync(path.join(os.tmpdir(), 'futureaide-wake-'));
  const agents = createScopedAgents({ stateDirectory, configFile: undefined }, {
    store,
    startSharedMonitor: async () => true,
    onWorkQueued: agentId => queued.push(agentId),
    ...(removeTree ? { removeTree } : {}),
    ...(onPollComplete ? { onPollComplete } : {}),
  });
  return { store, agents, queued, stateDirectory };
}

const sleeping = () => ({
  agentId: 'agent-a', ownerId: 'owner-a', name: 'worker', sessionId: 'session-a', state: 'awaiting_report',
  task: { taskId: 'task-a', dispatches: [], answers: [], reports: [] },
  sleep: { taskId: 'task-a', sessionId: 'session-a', signal: 'baseline' },
});

test('waking a sleeping name tells a listener in this process about it', async () => {
  const { store, agents, queued } = build();
  try {
    store.insert(sleeping());
    assert.equal(await agents.wake('agent-a', 'task-a'), true);
    assert.deepEqual(queued, ['agent-a'], 'the loop can poll it at once instead of waiting for a sweep');
    assert.equal(store.get('agent-a').sleep, undefined);
  } finally { agents.close(); }
});

test('a hint for a name whose poll is still running is handed back, not dropped', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const { store, agents, stateDirectory } = build({ removeTree: async () => { entered(); await gate; } });
  try {
    // A name in cleanup is always polled, and its own directory exists, so this poll
    // parks inside the delete until the test lets it go.
    mkdirSync(path.join(stateDirectory, 'scoped', 'owner-a', 'agent-c'), { recursive: true });
    store.insert({ agentId: 'agent-c', ownerId: 'owner-a', name: 'cleaning', sessionId: 'session-c',
      state: 'cleaning', closed: true, nativeDestroyed: true });
    const first = agents.monitorScan();
    await started;
    const deferred = [];
    await agents.monitorScan({ only: ['agent-c'], fresh: ['agent-c'], sweep: false, deferred });
    assert.deepEqual(deferred, ['agent-c'], 'the name is polled again as soon as this poll ends');
    release();
    await first;
    // Let the poll itself finish before the service closes the database under it.
    await new Promise(resolve => setTimeout(resolve, 100));
  } finally { agents.close(); }
});

test('only names that owe time-critical work are polled every second', async () => {
  const { store, agents } = build();
  const owed = delivery => ({ ownerId: 'owner-a', sessionId: `s-${delivery}`, state: 'running', lifetime: 'persistent',
    // A future attempt keeps the host out of this test: the fast set is decided before
    // any poll starts, and no poll is started while an attempt is not yet due.
    nextAttemptAt: Date.now() + 60000,
    task: { taskId: `task-${delivery}`, message: 'm', state: 'running',
      dispatches: [{ requestId: `r-${delivery}`, state: 'completed', accepted: true }], answers: [],
      reports: [{ id: `rp-${delivery}`, final: false, message: 'm', delivery: { state: delivery } }] } });
  try {
    store.insert({ ...owed('delivered'), agentId: 'agent-plain', name: 'plain' });
    store.insert({ ...owed('sending'), agentId: 'agent-owed', name: 'owed' });
    await agents.monitorScan();
    assert.deepEqual(agents.fastPollNames(), ['agent-owed'],
      'an unconfirmed receipt is worth a one-second cadence, ordinary running work is not');
  } finally { agents.close(); }
});

test('a poll that finds a new report is polled again at once, not at the next sweep', async () => {
  const { store, agents } = build();
  const polls = [];
  try {
    store.insert({ agentId: 'agent-x', ownerId: 'owner-a', name: 'x', sessionId: 's-x', state: 'awaiting_report',
      task: { taskId: 't-x', message: 'm', state: 'awaiting_report', dispatches: [], answers: [], reports: [] } });
    // The poll is what finds the report: it writes it and resolves, and from then on the
    // host writes nothing more for this name.
    agents.poll = async agentId => {
      polls.push(agentId);
      if (polls.length === 1) {
        const record = store.get(agentId);
        record.task.reports.push({ id: 'r-final', final: true, message: 'done', delivery: { state: 'pending' } });
        store.save(record);
      }
      return { state: 'awaiting_report' };
    };
    await agents.monitorScan();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.deepEqual(agents.fastPollNames(), ['agent-x'],
      'the record the poll just wrote decides, not the one the poll was scheduled from');

    // That is what makes the next round poll it again without waiting for a sweep.
    const deferred = [];
    await agents.monitorScan({ only: agents.fastPollNames(), sweep: false, deferred });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(polls.length, 2, 'the very next round polls the same name again');
  } finally { agents.close(); }
});
test('a name that only owes fast work is still polled at most once a second', async () => {
  const { store, agents } = build();
  const polls = [];
  try {
    store.insert({ agentId: 'agent-f', ownerId: 'owner-a', name: 'f', sessionId: 's-f', state: 'delivery_pending',
      task: { taskId: 't-f', message: 'm', state: 'delivery_pending', dispatches: [], answers: [], reports: [{ id: 'r', final: true, message: 'm', delivery: { state: 'pending' } }] } });
    agents.poll = async agentId => { polls.push(agentId); return { state: 'delivery_pending' }; };
    // The fast set is how a name gets polled without a sweep; it is not a licence to
    // skip the one-second floor, or every round would poll it again immediately.
    await agents.monitorScan({ only: ['agent-f'], sweep: false });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(polls.length, 1, 'the first round polls it');
    await agents.monitorScan({ only: ['agent-f'], sweep: false });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(polls.length, 1, 'the round right after does not, its own floor is not up');
    await agents.monitorScan({ only: ['agent-f'], fresh: ['agent-f'], sweep: false });
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(polls.length, 2, 'a real hint may still skip the floor');
  } finally { agents.close(); }
});

test('a poll that found nothing does not wake the loop, one that found work does', async () => {
  const signals = [];
  const { store, agents } = build({ onPollComplete: () => signals.push(Date.now()) });
  const polls = [];
  try {
    store.insert({ agentId: 'agent-q', ownerId: 'owner-a', name: 'q', sessionId: 's-q', state: 'awaiting_report',
      task: { taskId: 't-q', message: 'm', state: 'awaiting_report', dispatches: [], answers: [], reports: [] } });
    agents.poll = async agentId => { polls.push(agentId); return { state: 'awaiting_report' }; };
    await agents.monitorScan();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(polls.length, 1);
    assert.deepEqual(signals, [], 'nothing was found, so there is nothing to wake for');

    // The same name, this time with the poll writing the final it found.
    store.db.prepare("DELETE FROM leases WHERE key=?").run('agent-q');
    agents.poll = async agentId => {
      const record = store.get(agentId);
      record.task.reports.push({ id: 'r-final', final: true, message: 'done', delivery: { state: 'pending' } });
      store.save(record);
      return { state: 'awaiting_report' };
    };
    await new Promise(resolve => setTimeout(resolve, 1100));
    await agents.monitorScan();
    await new Promise(resolve => setTimeout(resolve, 60));
    assert.equal(signals.length, 1, 'a poll that found a report wakes the loop so it is polled again at once');
  } finally { agents.close(); }
});