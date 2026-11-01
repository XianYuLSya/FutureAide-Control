import test from 'node:test';
import assert from 'node:assert/strict';
import { RosterStore } from '../src/roster-store.mjs';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { canSleep, hasPendingDelivery } from '../src/idle-monitor-eligibility.mjs';
import { backgroundBatch, idleSignal, pollSleeping, scanSleeping } from '../src/idle-monitor.mjs';

function record() {
  return { agentId: 'agent-a', ownerId: 'owner-a', name: 'helper', sessionId: 'session-a', state: 'awaiting_report',
    task: { taskId: 'task-a', dispatches: [{ state: 'completed' }], reports: [], answers: [] },
    observation: { throughSeq: 4, questions: [], reports: [], tree: { settled: true, running: false } } };
}
test('only a verified quiet tree with no unfinished work may sleep', () => {
  const value = record(), settled = (_r, view) => view.tree.settled && !view.tree.running;
  assert.equal(canSleep(value, [], settled), true);
  assert.equal(canSleep(value, [{ task: 'task-a', status: 'queued' }], settled), false);
  value.observation.questions.push({ id: 'q', state: 'pending' });
  assert.equal(canSleep(value, [], settled), true);
  assert.equal(hasPendingDelivery(value), true);
  value.task.questionNotices = { q: { state: 'delivered' } };
  assert.equal(hasPendingDelivery(value), false);
  value.observation.questions = []; value.observation.tree.running = true;
  assert.equal(canSleep(value, [], settled), false);
});
test('shared monitor retries pending or unknown deliveries with at most two concurrent polls', async () => {
  const records = Array.from({ length: 5 }, (_, index) => ({ ...record(), agentId: `agent-${index}`,
    sleep: { taskId: 'task-a' }, task: { ...record().task, reports: [{ delivery: { state: index % 2 ? 'unknown' : 'pending' } }] } }));
  const store = { list: () => records, get: id => records.find(item => item.agentId === id), supplements: () => [] };
  let active = 0, peak = 0, count = 0;
  await pollSleeping(store, async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; count++; }, async () => {}, () => true);
  assert.equal(count, 5); assert.equal(peak, 2);
  records[0].callbackBlocked = true;
  assert.equal(hasPendingDelivery(records[0]), false);
});
test('slow delivery does not block event scanning or start overlapping batches', async () => {
  let release, notices = 0, started = false;
  const gate = new Promise(resolve => { release = resolve; });
  const batch = backgroundBatch(async () => { started = true; await gate; }, () => { notices++; });
  assert.equal(batch.start(), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(started, true);
  assert.equal(batch.start(), false);
  // A queued wake is scanned while delivery remains blocked.
  const value = record(); value.sleep = { taskId: 'task-a', sessionId: 'session-a', wakePending: true };
  const wakes = [];
  await scanSleeping({ list: () => [value], supplements: () => [] }, '.', async (...args) => wakes.push(args));
  assert.deepEqual(wakes, [['agent-a', 'task-a']]);
  release(); await batch.drain();
  assert.equal(notices, 1);
});
test('saved reports and questions wake only the matching sleeping task; partial writes retry', async () => {
  const base = path.resolve('clean', 'idle-monitor-tests'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(path.join(base, 'run-'));
  const store = new RosterStore(':memory:'), value = record(); store.insert(value);
  store.claimLease('idle-monitor', 'owner', 60000); store.claimLease('idle-monitor:ready', 'owner', 60000);
  const baseline = idleSignal({ ...value.observation, taskId: value.task.taskId });
  store.sleep(value, baseline);
  const key = createHash('sha256').update(`${value.ownerId}\n${value.agentId}`).digest('hex');
  const filename = path.join(directory, `${key}.json`);
  const native = { ownerId: value.ownerId, agentId: value.agentId, sessionId: value.sessionId,
    taskId: value.task.taskId, throughSeq: 4, questions: [], reports: [] };
  const awakened = [];
  const scan = () => scanSleeping(store, directory, async (id, task) => { awakened.push([id, task]); store.wake(id, task); });
  await writeFile(filename, JSON.stringify(native)); await scan(); assert.equal(awakened.length, 0);
  await writeFile(filename, '{'); await scan(); assert.equal(awakened.length, 0);
  native.questions.push({ id: 'question', state: 'pending' });
  await writeFile(filename, JSON.stringify(native)); await scan();
  assert.deepEqual(awakened, [['agent-a', 'task-a']]);
  store.sleep(value, baseline); native.questions = []; native.reports = [{ id: 'report-a', final: false }];
  await writeFile(filename, JSON.stringify(native)); await scan();
  assert.deepEqual(awakened, [['agent-a', 'task-a'], ['agent-a', 'task-a']]);
  store.sleep(value, baseline);
  assert.equal(store.enqueueSupplement(value, 'request-queued', 'update'), true);
  await scan();
  assert.deepEqual(awakened.at(-1), ['agent-a', 'task-a']);
  store.close();
});
test('sleep requires a ready monitor lease and preserves a meaningful event baseline', () => {
  const store = new RosterStore(':memory:'), value = record(); store.insert(value);
  const baseline = idleSignal({ ...value.observation, taskId: value.task.taskId });
  assert.equal(store.sleep(value, baseline), false);
  store.claimLease('idle-monitor', 'owner', 60000); store.claimLease('idle-monitor:ready', 'owner', 60000);
  assert.equal(store.sleep(value, baseline), true);
  assert.equal(store.get(value.agentId).sleep.signal, baseline);
  const stalePoll = store.get(value.agentId);
  assert.equal(idleSignal({ ...value.observation, taskId: value.task.taskId, updatedAt: 'later' }), baseline);
  assert.notEqual(idleSignal({ ...value.observation, taskId: value.task.taskId, reports: [{ id: 'r', final: false }] }), baseline);
  assert.equal(store.wake(value.agentId, 'wrong-task'), false);
  assert.equal(store.wake(value.agentId, value.task.taskId), true);
  store.save(stalePoll);
  assert.equal(store.get(value.agentId).sleep, undefined);
  store.close();
});
