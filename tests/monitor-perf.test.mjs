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
import { RosterStore, submissionNoticeId } from '../src/roster-store.mjs';
import { idleSignal, scanSleeping } from '../src/idle-monitor.mjs';
import { createDirectoryWatchers, createWakeQueue, throttledSignal, waitForCommit, wakeHintName } from '../src/shared-monitor.mjs';
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

test('a throttled poll completion still wakes the loop once its window ends', async () => {
  const wakes = [];
  const started = Date.now();
  const gate = throttledSignal(() => wakes.push(Date.now() - started), { intervalMs: 100 });
  try {
    gate.request();
    gate.request();
    gate.request();
    assert.equal(wakes.length, 1, 'the first completion wakes at once');
    await new Promise(resolve => setTimeout(resolve, 250));
    assert.equal(wakes.length, 2, 'completions inside the window are kept, as one wake');
    assert.ok(wakes[1] >= 90, 'that wake waits for the window to end');
  } finally { gate.close(); }
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

// An accepted parent message is a delivery debt until its own notice is terminal, even
// after the task stopped owning it. One predicate decides that for the inbox, for task
// rotation and for cleanup; these cases pin it on the real schema, including two
// connections writing the same roster at once.
const mailOwner = (overrides = {}) => record({ agentId: 'agent-mail', ownerId: 'owner-mail', name: 'mailer',
  sessionId: 'session-mail', state: 'idle',
  task: { taskId: 'task-old', message: 'do it', answers: [],
    dispatches: [{ requestId: 'request-1', kind: 'task', state: 'completed', accepted: true }],
    reports: [{ id: 'report-1', final: true, message: 'done', delivery: { state: 'delivered' } }] },
  observation: { questions: [], tree: { settled: true, running: false } }, ...overrides });

test('a new submission starts with its notice identity and is debt until that notice ends', () => {
  const store = new RosterStore(':memory:');
  try {
    store.enqueueSubmission({ id: 'sub-1', ownerId: 'owner-a', agentId: 'agent-a', taskId: 'task-a',
      kind: 'report', message: 'hi', created: '2026-11-12T00:00:00.000Z' });
    const [work] = store.submissionWork('agent-a');
    assert.equal(work.delivery.id, submissionNoticeId('sub-1'), 'the notice id is the submission id');
    assert.equal(work.delivery.state, 'pending');
    assert.equal(work.delivery.createdAt, '2026-11-12T00:00:00.000Z');
    assert.equal(work.deliveryVersion, JSON.stringify(work.delivery), 'the raw text is the compare-and-swap version');
    assert.equal(store.submissionDebt('agent-a'), 1);

    // Taking the row into the task is absorb progress, not delivery: the notice is still owed.
    assert.equal(store.consumeSubmission('sub-1'), true);
    assert.equal(store.submissionDebt('agent-a'), 1, 'an absorbed message still owes its notice');
    assert.equal(store.saveSubmissionDelivery('sub-1', { state: 'delivered' }, { expected: work.deliveryVersion }), true);
    assert.equal(store.submissionDebt('agent-a'), 0);
    assert.deepEqual(store.submissionWork('agent-a'), []);
  } finally { store.close(); }
});

test('a previous round keeps rotating blocked until its accepted message is delivered', () => {
  const store = new RosterStore(':memory:');
  try {
    const current = mailOwner();
    store.insert(current);
    store.enqueueSubmission({ id: 'old-1', ownerId: current.ownerId, agentId: current.agentId,
      taskId: 'task-old', kind: 'report', message: 'older' });
    // The build before this one consumed the row without recording any notice.
    store.db.prepare("UPDATE submissions SET state='consumed', consumed=?, delivery=NULL WHERE id='old-1'").run(new Date().toISOString());
    const next = { ...current, state: 'running',
      task: { taskId: 'task-new', message: 'again', dispatches: [], answers: [], reports: [] } };

    assert.equal(store.replaceTask(next, current), false, 'an undelivered accepted message blocks the next round');
    const [legacy] = store.submissionWork(current.agentId, 'task-old');
    assert.equal(legacy.deliveryVersion, null, 'a legacy row has no version to compare');
    assert.equal(store.saveSubmissionDelivery('old-1', { state: 'delivered' }, { expected: null }), true);
    assert.equal(store.submissionDebt(current.agentId), 0);
    assert.equal(store.replaceTask(next, current), true, 'once delivered, the next round may replace it');
    assert.equal(store.get(current.agentId).task.taskId, 'task-new');
  } finally { store.close(); }
});

test('two connections cannot both win the same notice', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'roster-cas-'));
  const file = path.join(directory, 'roster.sqlite');
  const first = new RosterStore(file), second = new RosterStore(file);
  try {
    first.enqueueSubmission({ id: 'sub-cas', ownerId: 'owner-a', agentId: 'agent-a', taskId: 'task-a',
      kind: 'report', message: 'hi' });
    const seenFirst = first.submissionWork('agent-a')[0].deliveryVersion;
    const seenSecond = second.submissionWork('agent-a')[0].deliveryVersion;
    assert.equal(seenFirst, seenSecond, 'both readers see the same version');
    assert.equal(first.saveSubmissionDelivery('sub-cas', { state: 'sending' }, { expected: seenFirst }), true);
    assert.equal(second.saveSubmissionDelivery('sub-cas', { state: 'sending' }, { expected: seenSecond }), false,
      'the writer that read the same version must lose the race');

    // A legacy row without a notice compares as null, so the same rule holds there.
    first.db.prepare("UPDATE submissions SET delivery=NULL WHERE id='sub-cas'").run();
    assert.equal(first.submissionWork('agent-a')[0].deliveryVersion, null);
    assert.equal(second.submissionWork('agent-a')[0].deliveryVersion, null);
    assert.equal(first.saveSubmissionDelivery('sub-cas', { state: 'pending', attempts: 1 }, { expected: null }), true);
    assert.equal(second.saveSubmissionDelivery('sub-cas', { state: 'pending', attempts: 1 }, { expected: null }), false);

    // A terminal notice is never walked back to a non-terminal one.
    assert.equal(first.saveSubmissionDelivery('sub-cas', { state: 'delivered' }), true);
    assert.equal(second.saveSubmissionDelivery('sub-cas', { state: 'pending' }), false);
    assert.equal(second.submissionDebt('agent-a'), 0);
  } finally { first.close(); second.close(); }
});

test('a roster from before the notice column still opens and counts what it owes', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'roster-oldschema-'));
  const file = path.join(directory, 'roster.sqlite');
  const legacy = new DatabaseSync(file);
  // Exactly the table the build before this one shipped: absorb progress, but no notice.
  legacy.exec(`CREATE TABLE submissions (id TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL,
    task TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL, final INTEGER NOT NULL, created TEXT NOT NULL,
    state TEXT NOT NULL, consumed TEXT)`);
  legacy.prepare('INSERT INTO submissions VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('legacy-old', 'owner-a', 'agent-a', 'task-a', 'report', 'hi', 0, '2026-11-01T00:00:00.000Z', 'consumed',
      '2026-11-01T00:00:01.000Z');
  legacy.close();

  const store = new RosterStore(file);
  try {
    const [work] = store.submissionWork('agent-a');
    assert.equal(work.id, 'legacy-old');
    assert.equal(work.deliveryVersion, null, 'an old row simply has no notice yet');
    assert.equal(store.submissionDebt('agent-a'), 1);
    store.insert(mailOwner({ agentId: 'agent-a', ownerId: 'owner-a', name: 'mailer',
      task: { taskId: 'task-a', message: 'do it', dispatches: [], answers: [], reports: [] } }));
    assert.deepEqual(store.pendingSubmissionAgents().map(row => ({ ...row })), [{ agentId: 'agent-a', dueAt: 0 }]);
    assert.equal(store.saveSubmissionDelivery('legacy-old', { state: 'delivered' }, { expected: null }), true);
    assert.equal(store.submissionDebt('agent-a'), 0);
    assert.deepEqual(store.pendingSubmissionAgents(), [], 'a delivered notice stops waking the name');
  } finally { store.close(); }
});

test('a notice for an old round finds that round in the history', () => {
  const store = new RosterStore(':memory:');
  try {
    const current = mailOwner();
    store.insert(current);
    const archived = { ...current.task, changes: [], coverage: {}, tree: {} };
    store.appendHistory(current.agentId, archived);
    assert.deepEqual(store.historyTask(current.agentId, 'task-old'), archived);
    assert.equal(store.historyTask(current.agentId, 'task-missing'), undefined);

    // Archiving and the next round's save used to be separate transactions, so one round
    // can have two snapshots: the notice follows the newer one.
    const later = { ...archived, reports: [{ id: 'report-2', final: false, message: 'later', delivery: { state: 'pending' } }] };
    store.appendHistory(current.agentId, later);
    assert.deepEqual(store.historyTask(current.agentId, 'task-old'), later);
  } finally { store.close(); }
});

test('an auto-cleaned name is kept while any round still owes a notice', () => {
  const store = new RosterStore(':memory:');
  try {
    const current = mailOwner();
    store.insert(current);
    // An accepted message from an earlier round, still undelivered.
    store.enqueueSubmission({ id: 'old-clean', ownerId: current.ownerId, agentId: current.agentId,
      taskId: 'task-older', kind: 'report', message: 'older' });
    assert.equal(store.claimAutoCleanup(current), false, 'a message from an earlier round is still owed');
    assert.equal(store.saveSubmissionDelivery('old-clean', { state: 'delivered' }), true);
    assert.equal(store.claimAutoCleanup(current), true);
  } finally { store.close(); }
});

test('a terminal notice is final, and only a legacy row may still be finalized once', () => {
  const store = new RosterStore(':memory:');
  try {
    // A legacy row: accepted, never absorbed, already carrying a terminal outcome.
    store.enqueueSubmission({ id: 'sub-legacy', ownerId: 'owner-a', agentId: 'agent-a', taskId: 'task-a',
      kind: 'report', message: 'hi', created: '2026-11-01T00:00:00.000Z' });
    store.db.prepare("UPDATE submissions SET delivery=? WHERE id='sub-legacy'")
      .run(JSON.stringify({ id: 'old-marker-1', state: 'blocked', createdAt: '2026-11-01T00:00:00.000Z' }));
    const [legacy] = store.submissionWork('agent-a');
    assert.equal(legacy.state, 'pending', 'the row was never absorbed');

    // Two proofs say delivered: finalizing it normalizes the identity and consumes it.
    assert.equal(store.saveSubmissionDelivery('sub-legacy', { state: 'delivered' },
      { expected: legacy.deliveryVersion }), true);
    const after = store.db.prepare("SELECT state, delivery FROM submissions WHERE id='sub-legacy'").get();
    assert.equal(after.state, 'consumed');
    assert.equal(JSON.parse(after.delivery).id, submissionNoticeId('sub-legacy'));
    assert.equal(JSON.parse(after.delivery).state, 'delivered');
    assert.equal(store.submissionDebt('agent-a'), 0);

    // Once consumed and terminal, the row is never rewritten — not even back to pending.
    assert.equal(store.saveSubmissionDelivery('sub-legacy', { state: 'blocked' }), false);
    assert.equal(store.saveSubmissionDelivery('sub-legacy', { state: 'pending' }), false);
  } finally { store.close(); }
});

test('a mirror from before the task moved is not written back', () => {
  const store = new RosterStore(':memory:');
  try {
    const current = mailOwner();
    store.insert(current);
    store.enqueueSubmission({ id: 'sub-mirror', ownerId: current.ownerId, agentId: current.agentId,
      taskId: 'task-old', kind: 'report', message: 'hi' });
    const stale = current; // what a replaced worker still holds
    store.save({ ...current, state: 'running',
      task: { taskId: 'task-next', message: 'again', dispatches: [], answers: [], reports: [] } });

    const [row] = store.submissionWork(current.agentId);
    assert.equal(store.saveSubmissionDelivery('sub-mirror', { state: 'delivered' },
      { expected: row.deliveryVersion, record: stale }), true);
    assert.equal(store.get(current.agentId).task.taskId, 'task-next', 'the stale mirror did not overwrite the newer task');
    assert.equal(store.submissionDebt(current.agentId), 0, 'the notice itself was still recorded');
  } finally { store.close(); }
});

test('a final waiting for its tree makes the name due at once, whatever else is backing off', () => {
  const store = new RosterStore(':memory:');
  try {
    const waiting = mailOwner({ agentId: 'agent-wait', name: 'waiter', sessionId: 'session-wait',
      state: 'delivery_pending',
      task: { taskId: 'task-wait', message: 'work', dispatches: [], answers: [],
        reports: [
          // A progress notice with its own backoff, next to a final still waiting for its tree.
          { id: 'report-progress', final: false,
            delivery: { id: 'notice-progress', state: 'pending', nextAttemptAt: Date.now() + 60000 } },
          { id: 'report-wait', final: true, treeSettledConfirmed: false,
            delivery: { id: 'notice-wait', state: 'pending', waitingForTree: true,
              nextAttemptAt: Date.now() + 6 * 60 * 60 * 1000 } },
        ] } });
    store.insert(waiting);
    const candidate = () => store.listWorkerCandidates().find(row => row.agentId === 'agent-wait');
    assert.equal(candidate().pendingReports, 2, 'both notices are still owed');
    assert.equal(candidate().noticeNextAt, undefined,
      'reading that tree is the sweep’s job, so no notice moment may defer this name');

    // Once the tree is settled and the notice is a plain retry, its own moment counts.
    const due = store.get('agent-wait');
    due.task.reports = [due.task.reports[0]];
    store.save(due);
    assert.ok(candidate().noticeNextAt > Date.now(), 'an ordinary notice keeps its own next attempt');

    // A notice of an earlier round that waits for a tree is due at once: that round is over.
    store.insert(mailOwner({ agentId: 'agent-old', name: 'older', sessionId: 'session-old',
      task: { taskId: 'task-now', message: 'now', dispatches: [], answers: [], reports: [] } }));
    store.enqueueSubmission({ id: 'old-wait', ownerId: 'owner-mail', agentId: 'agent-old',
      taskId: 'task-previous', kind: 'report', message: 'older text' });
    store.saveSubmissionDelivery('old-wait', { state: 'pending', waitingForTree: true,
      nextAttemptAt: Date.now() + 6 * 60 * 60 * 1000 });
    assert.deepEqual(store.pendingSubmissionAgents().map(row => ({ ...row })), [{ agentId: 'agent-old', dueAt: 0 }]);
  } finally { store.close(); }
});

// An automatic cleanup deletes a whole tree, so it must answer for the whole tree. One
// transaction decides it, and the claim closes the tree so nothing can be accepted after.
const treeRoot = (overrides = {}) => record({ agentId: 'root-1', ownerId: 'owner-t', name: 'root',
  sessionId: 'session-root', state: 'idle',
  task: { taskId: 'task-root', message: 'lead', dispatches: [], answers: [], reports: [] }, ...overrides });
const treeChild = (overrides = {}) => record({ agentId: 'child-1', ownerId: 'owner-t', name: 'child',
  sessionId: 'session-child', parentAgentId: 'root-1', state: 'idle',
  task: { taskId: 'task-child', message: 'help', dispatches: [], answers: [], reports: [] }, ...overrides });

test('the hold counts a whole tree, and a childs undelivered message blocks the claim', () => {
  const store = new RosterStore(':memory:');
  try {
    const root = treeRoot(), kid = treeChild();
    store.insert(root);
    store.insert(kid, { requireOpenParent: true });
    assert.deepEqual(store.autoCleanupHold('root-1'), { pending: 0, blocked: 0 });

    store.enqueueSubmission({ id: 'kid-early', ownerId: kid.ownerId, agentId: kid.agentId,
      taskId: kid.task.taskId, kind: 'report', message: 'from the child' });
    assert.deepEqual(store.autoCleanupHold('root-1'), { pending: 1, blocked: 0 }, 'the child is part of the tree');
    assert.equal(store.claimAutoCleanup(root), false, 'an undelivered message anywhere in the tree blocks the delete');
    assert.equal(store.get('root-1').closed, undefined, 'and nothing was closed by the refusal');
    assert.equal(store.get('child-1').closed, undefined);

    assert.equal(store.saveSubmissionDelivery('kid-early', { state: 'delivered' }), true);
    assert.deepEqual(store.autoCleanupHold('root-1'), { pending: 0, blocked: 0 });
    assert.equal(store.claimAutoCleanup(root), true);
  } finally { store.close(); }
});

test('a claimed tree closes its children and keeps their own state', () => {
  const store = new RosterStore(':memory:');
  try {
    const root = treeRoot(), kid = treeChild();
    store.insert(root);
    store.insert(kid, { requireOpenParent: true });
    assert.equal(store.claimAutoCleanup(root), true);

    const child = store.get('child-1');
    assert.equal(child.closed, true, 'the child is closed with the tree');
    assert.equal(child.state, 'idle', 'but keeps its own state, so it is cleaned up by its own turn');
    assert.equal(child.autoCleanupClosed, true);
    assert.equal(store.get('root-1').autoCleanupClosed, true);
    // A message the child would have accepted a moment earlier is refused now.
    assert.throws(() => store.submitParentMessage('child-1', { kind: 'report', message: 'late' }),
      { code: 'submission-not-owned' });
  } finally { store.close(); }
});

test('a copy read before the claim cannot open a closed child again', () => {
  const store = new RosterStore(':memory:');
  try {
    const root = treeRoot(), kid = treeChild();
    store.insert(root);
    store.insert(kid, { requireOpenParent: true });
    const stale = store.get('child-1'); // a worker that read the child before the claim
    assert.equal(store.claimAutoCleanup(root), true);
    stale.closed = false;
    store.save(stale);
    const child = store.get('child-1');
    assert.equal(child.closed, true, 'the closure is restored from the row, not from the copy');
    assert.equal(child.autoCleanupClosed, true);
  } finally { store.close(); }
});

test('a blocked notice keeps its text and blocks automatic cleanup, while a delete still works', () => {
  const store = new RosterStore(':memory:');
  try {
    const root = treeRoot();
    store.insert(root);
    store.enqueueSubmission({ id: 'blocked-1', ownerId: root.ownerId, agentId: root.agentId,
      taskId: root.task.taskId, kind: 'report', message: 'the only copy' });
    assert.equal(store.saveSubmissionDelivery('blocked-1', { state: 'blocked' }), true);
    assert.deepEqual(store.autoCleanupHold('root-1'), { pending: 0, blocked: 1 });
    assert.equal(store.claimAutoCleanup(root), false, 'a blocked text is still the only copy of what was said');

    // Removing a name on request stays an explicit authorization of its own.
    store.remove(root);
    assert.equal(store.get('root-1'), undefined);
  } finally { store.close(); }
});

test('a child created after the tree was claimed is refused', () => {
  const store = new RosterStore(':memory:');
  try {
    const root = treeRoot();
    store.insert(root);
    assert.equal(store.claimAutoCleanup(root), true);
    assert.throws(() => store.insert(treeChild(), { requireOpenParent: true }), { code: 'parent-closed' });
    assert.equal(store.get('child-1'), undefined);

    // Without the guard the plain insert path is unchanged.
    store.insert(record({ agentId: 'loose-1', ownerId: 'owner-t', name: 'loose', sessionId: 'session-loose', state: 'idle' }));
    assert.equal(store.get('loose-1').name, 'loose');
    store.insert(treeChild({ parentAgentId: 'missing-parent' }));
    assert.equal(store.get('child-1').parentAgentId, 'missing-parent');
  } finally { store.close(); }
});

test('two connections cannot both claim a tree and accept a late message', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'roster-tree-'));
  const file = path.join(directory, 'roster.sqlite');
  const first = new RosterStore(file), second = new RosterStore(file);
  try {
    const root = treeRoot(), kid = treeChild();
    first.insert(root);
    first.insert(kid, { requireOpenParent: true });

    // The child's message is accepted on the other connection before the claim.
    second.enqueueSubmission({ id: 'kid-race', ownerId: kid.ownerId, agentId: kid.agentId,
      taskId: kid.task.taskId, kind: 'report', message: 'raced in' });
    assert.deepEqual({ ...first.autoCleanupHold('root-1') }, { pending: 1, blocked: 0 }, 'the claim sees it');
    assert.equal(first.claimAutoCleanup(root), false, 'the message that arrived first wins');

    second.saveSubmissionDelivery('kid-race', { state: 'delivered' });
    assert.equal(first.claimAutoCleanup(root), true, 'once nothing is owed the claim goes through');
    assert.throws(() => second.submitParentMessage('child-1', { kind: 'report', message: 'after the claim' }),
      { code: 'submission-not-owned' }, 'the other connection reads the closure from the row');
    assert.throws(() => second.insert(treeChild({ agentId: 'child-2', name: 'child2' }), { requireOpenParent: true }),
      { code: 'parent-closed' });
  } finally { first.close(); second.close(); }
});

test('an auto-closed row stays closed through every merge branch, mark included', () => {
  const store = new RosterStore(':memory:');
  try {
    const root = treeRoot(), kid = treeChild();
    store.insert(root);
    store.insert(kid, { requireOpenParent: true });
    assert.equal(store.claimAutoCleanup(root), true);

    // A copy that still believes it is open.
    const open = { ...store.get('child-1') };
    delete open.closed; delete open.autoCleanupClosed;
    store.save(open);
    let child = store.get('child-1');
    assert.equal(child.closed, true, 'the closure comes back from the row');
    assert.equal(child.autoCleanupClosed, true);

    // A copy that kept closed but lost the mark: the mark comes back too.
    const unmarked = { ...child, closed: true };
    delete unmarked.autoCleanupClosed;
    store.save(unmarked);
    child = store.get('child-1');
    assert.equal(child.closed, true);
    assert.equal(child.autoCleanupClosed, true, 'the mark is restored from the row');

    // Even a copy that lands on the cancel branch of the merge cannot reopen it.
    store.db.prepare("UPDATE agents SET body=json_set(body,'$.task.cancelRequested',json('true')) WHERE id='child-1'").run();
    const rowwise = JSON.parse(store.db.prepare("SELECT body FROM agents WHERE id='child-1'").get().body);
    delete rowwise.closed; delete rowwise.autoCleanupClosed;
    store.save(rowwise);
    child = store.get('child-1');
    assert.equal(child.task.cancelRequested, true, 'the cancel evidence stays');
    assert.equal(child.closed, true, 'the closure survives the cancel branch');
    assert.equal(child.autoCleanupClosed, true);
  } finally { store.close(); }
});

test('a failed round whose thread is gone is never pulled back to running', () => {
  const store = new RosterStore(':memory:');
  try {
    const base = mailOwner();
    const gone = mailOwner({ state: 'failed', task: { ...base.task, taskId: 'task-gone', state: 'failed',
      treeUnavailable: 'codex-thread-not-found' } });
    store.insert(gone);
    // The caller asked to cancel while the round was still alive; the row recorded it.
    store.db.prepare("UPDATE agents SET body=json_set(body,'$.task.cancelRequested',json('true')) WHERE id=?")
      .run(gone.agentId);

    assert.equal(store.requestCancel(store.get(gone.agentId)), false,
      'an unqueryable failed round is not revived by a cancel');
    const stale = store.get(gone.agentId);
    assert.equal(stale.task.cancelRequested, true);
    store.save(stale);
    const after = store.get(gone.agentId);
    assert.equal(after.task.cancelRequested, true, 'the cancel evidence is kept');
    assert.equal(after.state, 'failed', 'and the round stays failed instead of running');

    // A round whose thread is still there keeps the old wake behaviour.
    const live = mailOwner({ agentId: 'agent-live', name: 'live', sessionId: 'session-live', state: 'running',
      task: { taskId: 'task-live', message: 'work', dispatches: [], answers: [], reports: [] } });
    store.insert(live);
    store.db.prepare("UPDATE agents SET body=json_set(body,'$.task.cancelRequested',json('true'),'$.state','running') WHERE id=?")
      .run(live.agentId);
    store.save(store.get(live.agentId));
    assert.equal(store.get(live.agentId).state, 'running');
  } finally { store.close(); }
});

test('a create can still see the auto-closed parent it must refuse', () => {
  const store = new RosterStore(':memory:');
  try {
    const parent = record({ agentId: 'codex-parent', ownerId: 'owner-c', name: 'parent', sessionId: 'session-parent',
      target: 'codex-desktop', state: 'idle',
      task: { taskId: 'task-parent', message: 'work', dispatches: [], answers: [], reports: [] } });
    store.insert(parent);
    store.saveBackendState('codex-parent', { binding: { sessionId: 'thread-parent', owned: true }, requests: {} });
    assert.equal(store.agentForCodexThread('thread-parent').agentId, 'codex-parent');

    assert.equal(store.claimAutoCleanup(parent), true);
    assert.equal(store.agentForCodexThread('thread-parent'), undefined, 'a closed name is no longer a live parent');
    const found = store.agentForCodexThread('thread-parent', { includeAutoClosed: true });
    assert.equal(found.agentId, 'codex-parent', 'but create can still see the parent it must refuse');
    // The child is recorded under it and then refused, instead of being taken as top level.
    assert.throws(() => store.insert(treeChild({ parentAgentId: 'codex-parent' }), { requireOpenParent: true }),
      { code: 'parent-closed' });
  } finally { store.close(); }
});