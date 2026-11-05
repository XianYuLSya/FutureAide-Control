// The shared monitor must not pay for work it does not need: an unchanged save
// writes nothing, a slow round re-reads nothing, and task history no longer rides
// inside the body that every poll used to rewrite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RosterStore } from '../src/roster-store.mjs';
import { idleSignal, scanSleeping } from '../src/idle-monitor.mjs';
import { createDirectoryWatchers, createWakeQueue, waitForCommit, wakeHintName } from '../src/shared-monitor.mjs';
import { captureObservation, owesFastPoll, retryDelayMs } from '../src/scoped-agents.mjs';

const record = (overrides = {}) => ({
  agentId: 'agent-a', ownerId: 'owner-a', name: 'worker', sessionId: 'session-a', state: 'running',
  task: { taskId: 'task-a', message: 'do the thing', dispatches: [], answers: [],
    reports: [{ id: 'report-a', final: true, message: 'done', delivery: { state: 'delivered' } }] },
  observation: { questions: [], tree: { settled: false, running: true } },
  ...overrides,
});

test('a save that changes nothing writes nothing, and still reports a removed name', () => {
  const store = new RosterStore(':memory:');
  try {
    const value = record();
    store.insert(value);
    const loaded = store.get(value.agentId);
    const before = store.db.prepare('SELECT total_changes() AS changed').get().changed;
    const updatedAt = loaded.updatedAt;
    store.save(loaded);
    assert.equal(store.db.prepare('SELECT total_changes() AS changed').get().changed, before,
      'an unchanged record must not be rewritten');
    assert.equal(store.get(value.agentId).updatedAt, updatedAt);

    loaded.state = 'awaiting_report';
    store.save(loaded);
    assert.equal(store.db.prepare('SELECT total_changes() AS changed').get().changed, before + 1);
    assert.equal(store.get(value.agentId).state, 'awaiting_report');

    // The skip must never hide that the row is gone.
    store.db.prepare('DELETE FROM agents WHERE id=?').run(value.agentId);
    assert.throws(() => store.save({ ...loaded }), /already been removed/);
  } finally { store.close(); }
});

test('an unchanged save does not resurrect a sleep marker another writer removed', () => {
  const store = new RosterStore(':memory:');
  try {
    const value = record({ sleep: { taskId: 'task-a', sessionId: 'session-a', signal: 'baseline' } });
    store.insert(value);
    const loaded = store.get(value.agentId);
    assert.equal(store.wake(value.agentId, 'task-a'), true);
    store.save(loaded);
    assert.equal(store.get(value.agentId).sleep, undefined, 'the atomic wake must survive the stale poll');
  } finally { store.close(); }
});

test('task history lives outside the body, survives a reopen and moves exactly once', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'futureaide-history-'));
  const file = path.join(directory, 'roster.sqlite');
  // A roster written by the build from before this change: history inside the body.
  const legacy = new DatabaseSync(file);
  legacy.exec("CREATE TABLE agents (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(owner,name));");
  legacy.prepare('INSERT INTO agents(id,owner,name,body) VALUES (?,?,?,?)').run('agent-legacy', 'owner-a', 'legacy',
    JSON.stringify(record({ agentId: 'agent-legacy', name: 'legacy',
      history: [{ message: 'first', state: 'completed' }, { message: 'second', state: 'completed' }] })));
  legacy.close();

  const store = new RosterStore(file);
  try {
    const loaded = store.get('agent-legacy');
    assert.deepEqual(loaded.history, []);
    assert.deepEqual(store.historyFor('agent-legacy').map(item => item.message), ['first', 'second']);
    assert.equal(store.historyCount('agent-legacy'), 2);
    store.appendHistory('agent-legacy', { message: 'third', state: 'completed' });
    assert.deepEqual(store.historyFor('agent-legacy').map(item => item.message), ['first', 'second', 'third']);
    assert.ok(JSON.stringify(store.get('agent-legacy')).length < 2000, 'history must not come back through get()');
    const marker = store.db.prepare("SELECT value FROM schema_meta WHERE key='agent-history-table-v1'").get();
    assert.ok(marker, 'the move is recorded so it never repeats');
  } finally { store.close(); }

  const reopened = new RosterStore(file);
  try {
    assert.equal(reopened.historyCount('agent-legacy'), 3);
    assert.equal(reopened.db.prepare('SELECT total_changes() AS changed').get().changed, 0, 'a migrated roster opens without writing');
  } finally { reopened.close(); }
});

test('the scan projection answers the poll questions and follows this connection own saves', () => {
  const store = new RosterStore(':memory:');
  try {
    const idle = record({ agentId: 'agent-idle', name: 'idle', state: 'idle', task: undefined,
      observation: { questions: [] } });
    store.insert(idle);
    const candidate = store.listWorkerCandidates()[0];
    assert.equal(candidate.hasSupplement, false);
    assert.equal(candidate.pendingReports, 0);

    store.enqueueSubmission({ id: 'submission-a', ownerId: 'owner-a', agentId: 'agent-idle', taskId: 'task-a', kind: 'report', message: 'hi' });
    assert.equal(store.listWorkerCandidates()[0].hasSupplement, false, 'a submission is not a supplement');

    const loaded = store.get('agent-idle');
    Object.assign(loaded, record({ agentId: 'agent-idle', name: 'idle', state: 'awaiting_report' }));
    loaded.task.reports[0].delivery.state = 'pending';
    store.save(loaded);
    const fresh = store.listWorkerCandidates()[0];
    assert.equal(fresh.state, 'awaiting_report');
    assert.equal(fresh.pendingReports, 1);
    assert.equal(fresh.task.reports[0].delivery.state, 'pending');
  } finally { store.close(); }
});

test('an unchanged sleeping state file waits for its timestamp, but never forever', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'futureaide-sleep-'));
  const stateDir = path.join(directory, 'managed-host');
  mkdirSync(stateDir, { recursive: true });
  const store = new RosterStore(':memory:');
  try {
    const questions = [{ id: 'q-a', state: 'x' }];
    const base = { ownerId: 'owner-a', agentId: 'agent-a', sessionId: 'session-a', taskId: 'task-a', throughSeq: 7, questions, reports: [] };
    const value = record({ state: 'awaiting_report', sleep: { taskId: 'task-a', sessionId: 'session-a', signal: idleSignal(base) } });
    store.insert(value);
    const key = createHash('sha256').update('owner-a\nagent-a').digest('hex');
    const file = path.join(stateDir, `${key}.json`);
    writeFileSync(file, JSON.stringify(base));
    const stamp = new Date(Date.now() - 5000);
    utimesSync(file, stamp, stamp);

    const cache = new Map();
    const wakes = [];
    const scan = options => scanSleeping(store, stateDir, async (agentId, taskId) => wakes.push([agentId, taskId]), new Map(), cache, options);
    await scan();
    assert.deepEqual(wakes, []);

    // Same size and same timestamp, different state: only a re-read could see it, so
    // within the cache lifetime it is deliberately not seen.
    writeFileSync(file, JSON.stringify({ ...base, questions: [{ id: 'q-a', state: 'y' }] }));
    utimesSync(file, stamp, stamp);
    await scan();
    assert.deepEqual(wakes, [], 'an unchanged size and timestamp is not re-read inside the cache lifetime');

    // But the cache is not trusted forever: once it is older than the lifetime the file
    // is read again even though it still looks unchanged, so a same-tick rewrite can
    // delay a name by the lifetime and never park it there.
    await scan({ ttlMs: 0 });
    assert.deepEqual(wakes, [['agent-a', 'task-a']], 'the cached state expires on its own');

    // A real rewrite moves the timestamp and must wake the name at once.
    wakes.length = 0;
    writeFileSync(file, JSON.stringify({ ...base, questions: [{ id: 'q-a', state: 'z' }] }));
    await scan();
    assert.deepEqual(wakes, [['agent-a', 'task-a']]);
  } finally { store.close(); }
});

test('a leftover accepted supplement is not owed work, and the scan and the record agree', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(record({ state: 'running', task: { taskId: 'task-a', message: 'open task', dispatches: [], answers: [], reports: [] } }));
    const scope = status => {
      const requestId = `supp-${status}`;
      assert.equal(store.enqueueSupplement(store.get('agent-a'), requestId, 'follow-up'), true);
      store.setSupplement(requestId, status);
      // The scan projection and the full record must answer "does this name owe a
      // supplement?" the same way, whatever the status is.
      const projection = store.listWorkerCandidates()[0].hasSupplement;
      const recordSays = store.supplements('agent-a').some(item => item.status !== 'blocked');
      assert.equal(projection, recordSays, `projection and record disagree for ${status}`);
      return projection;
    };
    assert.equal(scope('accepted'), false, 'an accepted supplement was already taken');
    assert.equal(scope('blocked'), false);
    assert.equal(scope('queued'), true);
    assert.equal(scope('sending'), true);
    assert.equal(scope('unknown'), true);
  } finally { store.close(); }
});

test('a write that bypasses the store still invalidates the projections', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(record({ state: 'awaiting_report', sleep: { taskId: 'task-a', sessionId: 'session-a', signal: 'baseline' } }));
    assert.equal(store.listSleeping().length, 1, 'the projection is built and cached here');
    // Another module writes the table directly; an adapter's own state write does this.
    store.db.prepare("UPDATE agents SET body=json_remove(body,'$.sleep') WHERE id=?").run('agent-a');
    // A write the store does know about must not vouch for the one it does not.
    store.claimLease('probe-key', 'probe-holder', 1000);
    assert.deepEqual(store.listSleeping(), [], 'the unknown write still invalidates the projection');
  } finally { store.close(); }
});

test('another process commit asks for a sweep that ignores the poll floor', () => {
  const queue = createWakeQueue();
  assert.equal(queue.commit(), true);
  const taken = queue.take();
  assert.equal(taken.sweep, true, 'a commit nobody announced means sweep');
  assert.equal(taken.force, true, 'and the swept names must not wait for their own floor');
});

test('the watcher carries the changed file name so one event can name one record', () => {
  const seen = [];
  const watchers = createDirectoryWatchers((directory, filename) => seen.push([directory, filename]), {
    watchImpl: (directory, options, listener) => {
      listener('change', 'a'.repeat(64) + '.json');
      listener('change', null);
      return { on() {}, close() {} };
    },
  });
  try {
    watchers.update(['D:\\state\\managed-host']);
    assert.deepEqual(seen, [['D:\\state\\managed-host', 'a'.repeat(64) + '.json'], ['D:\\state\\managed-host', null]]);
  } finally { watchers.close(); }
});

test('deleting a name deletes its task history before the checkpoint runs', () => {
  const store = new RosterStore(':memory:');
  try {
    const value = record();
    store.insert(value);
    store.appendHistory(value.agentId, { message: 'TASK_TEXT_TO_ERASE', state: 'completed' });
    assert.equal(store.historyCount(value.agentId), 1);
    store.remove(store.get(value.agentId));
    assert.equal(store.get(value.agentId), undefined);
    assert.equal(store.historyCount(value.agentId), 0, 'the task text must not survive the delete');
  } finally { store.close(); }
});

test('a delete that cannot checkpoint leaves a marker without the erased task text', () => {
  const store = new RosterStore(':memory:');
  const prepare = store.db.prepare.bind(store.db);
  try {
    store.insert(record());
    store.appendHistory('agent-a', { message: 'TASK_TEXT_TO_ERASE', state: 'completed' });
    // A reader still holding the database makes the truncating checkpoint report busy.
    store.db.prepare = sql => (/wal_checkpoint/i.test(sql) ? { get: () => ({ busy: 1 }) } : prepare(sql));
    assert.throws(() => store.remove(store.get('agent-a')), /still pending/);
    store.db.prepare = prepare;
    const tombstone = store.get('agent-a');
    assert.equal(tombstone.state, 'cleanup_failed');
    assert.deepEqual(tombstone.history, []);
    assert.equal(store.historyFor('agent-a').length, 0, 'the tombstone must not resurrect erased history');
  } finally { store.db.prepare = prepare; store.close(); }
});

test('a stale poll saving after an atomic wake cannot put the name back to sleep', () => {
  const store = new RosterStore(':memory:');
  try {
    const value = record({ state: 'awaiting_report', sleep: { taskId: 'task-a', sessionId: 'session-a', signal: 'baseline' } });
    store.insert(value);
    const stale = store.get(value.agentId);
    assert.equal(store.wake(value.agentId, 'task-a'), true);
    assert.deepEqual(store.listSleeping(), [], 'the projection follows the wake at once');
    store.save(stale);
    assert.equal(store.get(value.agentId).sleep, undefined, 'the write keeps the wake');
    assert.deepEqual(store.listSleeping(), []);
    assert.equal(store.listWorkerCandidates().find(row => row.agentId === value.agentId).sleep, undefined);
  } finally { store.close(); }
});

test('one projection rebuilding never hides a change another projection must see', () => {
  const store = new RosterStore(':memory:');
  try {
    const value = record({ state: 'awaiting_report', sleep: { taskId: 'task-a', sessionId: 'session-a', signal: 'baseline' } });
    store.insert(value);
    assert.equal(store.listWorkerCandidates().length, 1, 'the first projection is built here');
    const loaded = store.get(value.agentId);
    delete loaded.sleep;
    loaded.state = 'running';
    store.save(loaded);
    assert.deepEqual(store.listSleeping().map(row => row.agentId), [], 'a later projection sees the saved change');
    assert.equal(store.listWorkerCandidates()[0].state, 'running');
  } finally { store.close(); }
});

test('the sleeping projection is the query, not a narrower filter', () => {
  const store = new RosterStore(':memory:');
  try {
    // A name can carry a sleep marker while its state has already moved on; the scan
    // has to see it so it can wake it, so the projection must not filter by state.
    store.insert(record({ state: 'running', sleep: { taskId: 'task-a', sessionId: 'session-a', signal: 'baseline' } }));
    assert.deepEqual(store.listSleeping().map(row => row.agentId), ['agent-a']);
    assert.equal(store.hasSleeping(), true);
  } finally { store.close(); }
});

test('a hinted file event names one record and unknown events ask for one sweep a second', () => {
  const hash = createHash('sha256').update('owner-a\nagent-a').digest('hex');
  assert.equal(wakeHintName(`${hash}.json`), hash);
  assert.equal(wakeHintName('session.json'), null);
  assert.equal(wakeHintName(undefined), null);

  let clock = 0;
  const queue = createWakeQueue({ sweepRequestMs: 1000, now: () => clock });
  assert.equal(queue.event('agent-a'), true, 'a named event wakes the loop');
  assert.equal(queue.event(null), true, 'the first unmapped event wakes the loop');
  clock = 10;
  assert.equal(queue.event(null), false, 'a burst does not wake the loop again');
  assert.equal(queue.sweeping, true, 'but the sweep it asked for is kept');
  const taken = queue.take();
  assert.deepEqual(taken.names, ['agent-a']);
  assert.equal(taken.sweep, true);
  assert.equal(queue.sweeping, false, 'taking the queue clears it');
  clock = 2000;
  assert.equal(queue.event(null), true, 'a later second may wake it again');
});

test('a hint that arrives while its poll is running is kept for the next round', () => {
  const queue = createWakeQueue();
  queue.event('agent-a');
  queue.take();
  assert.equal(queue.defer(['agent-a']), true);
  assert.deepEqual(queue.take().names, ['agent-a'], 'the deferred hint is still there');
  assert.equal(queue.defer([]), false);
});

test('another process commit ends the quiet wait within one slice', async () => {
  const waited = [];
  let version = 7;
  const outcome = await waitForCommit({
    timeoutMs: 5000, floorMs: 0, sliceMs: 1000,
    sleep: async milliseconds => { waited.push(milliseconds); version += 1; },
    signalled: () => false, readVersion: () => version, version: 7,
  });
  assert.equal(outcome.reason, 'commit');
  assert.equal(waited.length, 1, 'the wait did not run to its timeout');
  assert.equal(waited[0], 1000, 'one slice is the longest blind period');

  const idle = await waitForCommit({ timeoutMs: 2000, floorMs: 0, sliceMs: 1000,
    sleep: async () => {}, signalled: () => false, readVersion: () => 7, version: 7 });
  assert.equal(idle.reason, 'timeout');

  const woken = await waitForCommit({ timeoutMs: 5000, floorMs: 0, sliceMs: 1000,
    sleep: async () => {}, signalled: () => true, readVersion: () => 7, version: 7 });
  assert.equal(woken.reason, 'work');
});

test('a poll that observed the same tree reuses the stored observation', () => {
  const previous = { throughSeq: 7, tree: { settled: false }, capturedAt: 'old' };
  const same = captureObservation(previous, { throughSeq: 7, tree: { settled: false }, capturedAt: 'later' }, 'new');
  assert.equal(same, previous, 'the stored object is reused, so the body cannot change');
  assert.equal(same.capturedAt, 'old', 'and so is its capture stamp');
  const changed = captureObservation(previous, { throughSeq: 8, tree: { settled: false } }, 'new');
  assert.notEqual(changed, previous);
  assert.equal(changed.capturedAt, 'new');
  assert.equal(changed.throughSeq, 8);
  assert.equal(captureObservation(undefined, { throughSeq: 1 }, 'first').capturedAt, 'first');
});

test('a repeated poll of an unchanged name writes nothing at all', () => {
  const store = new RosterStore(':memory:');
  try {
    store.insert(record({ state: 'running',
      observation: { throughSeq: 5, tree: { settled: false }, questions: [], reports: [], capturedAt: 'old' } }));
    // The migration marker is one row change of its own; the baseline is what follows it.
    const baseline = store.db.prepare('SELECT total_changes() AS changed').get().changed;
    for (let tick = 0; tick < 3; tick += 1) {
      const current = store.get('agent-a');
      current.observation = captureObservation(current.observation, { throughSeq: 5, tree: { settled: false }, questions: [], reports: [] }, new Date().toISOString());
      store.save(current);
    }
    assert.equal(store.db.prepare('SELECT total_changes() AS changed').get().changed, baseline, 'three polls, no write');
    const current = store.get('agent-a');
    current.observation = captureObservation(current.observation, { throughSeq: 6, tree: { settled: false }, questions: [], reports: [] }, new Date().toISOString());
    store.save(current);
    assert.equal(store.db.prepare('SELECT total_changes() AS changed').get().changed, baseline + 1, 'a real change still writes');
    assert.equal(store.get('agent-a').observation.throughSeq, 6);
  } finally { store.close(); }
});

test('a delivery that keeps failing is not polled every second', () => {
  const now = Date.now();
  const base = { agentId: 'a', state: 'delivery_pending', task: { taskId: 't', reports: [] } };
  const withReport = delivery => ({ ...base, task: { taskId: 't', reports: [{ id: 'r', final: true, delivery }] } });
  assert.equal(owesFastPoll(withReport({ state: 'pending' }), now), true, 'a brand new report is due now');
  assert.equal(owesFastPoll(withReport({ state: 'pending', nextAttemptAt: now + 1000 }), now), true);
  assert.equal(owesFastPoll(withReport({ state: 'pending', nextAttemptAt: now + 30000, attempts: 8259 }), now), false,
    'a report backing off past its window is not polled every second');
  assert.equal(owesFastPoll(withReport({ state: 'delivered' }), now), false);
  assert.equal(owesFastPoll(withReport({ state: 'blocked' }), now), false);
  assert.equal(owesFastPoll(base, now), false, 'delivery_pending alone is not owed work');
  assert.equal(owesFastPoll({ ...base, sleep: { taskId: 't' } }, now), false);
  const notice = task => ({ ...base, task: { taskId: 't', reports: [], ...task } });
  assert.equal(owesFastPoll(notice({ questionNotices: { q: { state: 'pending', nextAttemptAt: now + 60000 } } }), now), false);
  assert.equal(owesFastPoll(notice({ questionNotices: { q: { state: 'pending' } } }), now), true);
  assert.equal(owesFastPoll(notice({ dispatches: [{ state: 'retrying', nextAttemptAt: now + 1000 }] }), now), true);
  assert.equal(owesFastPoll(notice({ dispatches: [{ state: 'retrying', nextAttemptAt: now + 60000 }] }), now), false);
});

test('a delivery abandoned for a long time backs off to five minutes', () => {
  assert.equal(retryDelayMs(1), 2000);
  assert.equal(retryDelayMs(2), 4000);
  assert.equal(retryDelayMs(5), 30000, 'a live channel still retries within 30 seconds');
  assert.equal(retryDelayMs(20), 30000);
  assert.equal(retryDelayMs(21), 300000, 'past 20 attempts it is clearly abandoned');
  assert.equal(retryDelayMs(8259), 300000);
});