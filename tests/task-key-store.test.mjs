import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RosterStore } from '../src/roster-store.mjs';

const record = () => ({ agentId: 'old', ownerId: 'owner', name: 'same', sessionId: 'session', state: 'completed',
  task: { taskId: 'round', requestId: 'request', reports: [{ id: 'submission:final', final: true,
    message: 'private body', delivery: { state: 'delivered', deliveredAt: '2026-11-22T00:00:00.000Z' } }] } });

test('receipt survives cleanup, restart and same-name creation with owner isolation and expiry', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-key-'));
  const file = path.join(dir, 'test.sqlite');
  let store = new RosterStore(file);
  try {
    const old = record(); store.insert(old);
    const key = store.saveTaskKey('owner', 'old', 'request', 'round');
    store.remove(old, { deliveredReceipt: true });
    store.close(); store = new RosterStore(file);
    store.insert({ ...record(), agentId: 'new', task: { taskId: 'new-round', reports: [] } });
    const receipt = store.resolveTaskKey('owner', key);
    assert.equal(receipt.taskId, 'round');
    assert.equal(receipt.receipt.finalSubmissionId, 'final');
    assert.equal(JSON.stringify(receipt).includes('private body'), false);
    assert.equal(store.resolveTaskKey('other', key), null);
    store.db.prepare('UPDATE task_keys SET expiresAt=? WHERE key=?').run('2000-01-01T00:00:00.000Z', key);
    assert.equal(store.resolveTaskKey('owner', key), null);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_keys WHERE key=?').get(key).n, 0);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('fault after receipt rolls back both receipt and deletion', () => {
  const store = new RosterStore(':memory:');
  try {
    const old = record(); store.insert(old);
    const key = store.saveTaskKey('owner', 'old', 'request', 'round');
    store.db.exec("CREATE TRIGGER fail_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => store.remove(old, { deliveredReceipt: true }), /injected/);
    assert.ok(store.get('old'));
    assert.equal(store.resolveTaskKey('owner', key).receipt, null);
  } finally { store.close(); }
});

test('busy checkpoint keeps exactly one receipt through explicit cleanup retry', () => {
  const store = new RosterStore(':memory:');
  try {
    const old = record(); store.insert(old);
    const key = store.saveTaskKey('owner', 'old', 'request', 'round');
    const prepare = store.db.prepare.bind(store.db);
    store.db.prepare = sql => /wal_checkpoint/i.test(sql) ? { get: () => ({ busy: 1 }) } : prepare(sql);
    assert.throws(() => store.remove(old, { deliveredReceipt: true }), /cleanup is still pending/);
    store.db.prepare = prepare;
    const marker = store.get('old');
    assert.equal(marker.state, 'cleanup_failed');
    store.remove(marker);
    assert.equal(store.resolveTaskKey('owner', key).receipt.finalSubmissionId, 'final');
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM task_keys').get().n, 1);
  } finally { store.close(); }
});

test('manual deletion and unconfirmed final never create delivery receipts', () => {
  const store = new RosterStore(':memory:');
  try {
    const old = record(); old.task.reports[0].delivery.state = 'pending'; store.insert(old);
    const key = store.saveTaskKey('owner', 'old', 'request', 'round');
    store.remove(old, { deliveredReceipt: true });
    assert.equal(store.resolveTaskKey('owner', key), null);
  } finally { store.close(); }
});

test('queued request binds only once to its actual task', () => {
  const store = new RosterStore(':memory:');
  try {
    const key = store.saveTaskKey('owner', 'old', 'request', null);
    assert.equal(store.resolveTaskKey('owner', key).taskId, null);
    assert.equal(store.saveTaskKey('owner', 'old', 'request', 'actual'), key);
    assert.equal(store.resolveTaskKey('owner', key).taskId, 'actual');
    assert.throws(() => store.saveTaskKey('owner', 'old', 'request', 'other'), /cannot be rebound/);
  } finally { store.close(); }
});


test('answer intent and task key roll back together on key failure', () => {
  const store = new RosterStore(':memory:');
  try {
    const old = record(); old.state = 'running'; old.task.state = 'running'; old.task.reports = [];
    store.insert(old);
    const updated = structuredClone(old);
    updated.task.answers = [{ answerId: 'answer-request', message: 'choice' }];
    store.db.exec("CREATE TRIGGER fail_answer_key BEFORE INSERT ON task_keys WHEN NEW.request='answer-request' BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => store.saveAnswerWithTaskKey(updated, 'answer-request'), /injected/);
    assert.equal(store.get(old.agentId).task.answers, undefined);
    assert.equal(store.db.prepare("SELECT count(*) AS n FROM task_keys WHERE request='answer-request'").get().n, 0);
  } finally { store.close(); }
});


test('live task key reads do not request the WAL writer lock', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'task-key-read-'));
  const file = path.join(dir, 'test.sqlite');
  const store = new RosterStore(file);
  const writer = new DatabaseSync(file);
  try {
    const key = store.saveTaskKey('owner', 'agent', 'request', 'task');
    store.db.exec('PRAGMA busy_timeout=50');
    writer.exec('BEGIN IMMEDIATE');
    assert.equal(store.resolveTaskKey('owner', key).taskId, 'task');
    writer.exec('ROLLBACK');
  } finally { writer.close(); store.close(); rmSync(dir, { recursive: true, force: true }); }
});


test('queued key captures its event baseline when bound, before later submissions', () => {
  const store = new RosterStore(':memory:');
  try {
    const current = record(); current.state = 'running'; current.task.state = 'running'; current.task.reports = [];
    store.insert(current);
    const key = store.saveTaskKey('owner', 'old', 'queued', null);
    store.enqueueSubmission({ id: 'before-bind', ownerId: 'owner', agentId: 'old', taskId: 'round', kind: 'report', message: 'old' });
    assert.equal(store.saveTaskKey('owner', 'old', 'queued', 'round'), key);
    store.enqueueSubmission({ id: 'after-bind', ownerId: 'owner', agentId: 'old', taskId: 'round', kind: 'report', message: 'new' });
    const mapping = store.resolveTaskKey('owner', key);
    assert.equal(mapping.baseline.count, 1);
    assert.deepEqual(store.submissionsInOrder('old', 'round', mapping.baseline.count).map(row => row.id), ['after-bind']);
  } finally { store.close(); }
});


test('delivery receipt retains a failed answer reason for its request key', () => {
  const store = new RosterStore(':memory:');
  try {
    const old = record(); old.task.answers = [{ answerId: 'failed-answer', undelivered: 'final-submitted' }];
    store.insert(old); const key = store.saveTaskKey('owner', 'old', 'failed-answer', 'round');
    store.remove(old, { deliveredReceipt: true });
    assert.equal(store.resolveTaskKey('owner', key).failureReason, 'final-submitted');
  } finally { store.close(); }
});


test('legacy native questions migrate before observation disappears and cleanup removes their text', () => {
  const store = new RosterStore(':memory:');
  try {
    const old = record(); old.observation = { questions: [{ id: 'legacy-q', state: 'pending', message: 'private native question' }] };
    store.insert(old);
    const key = store.saveTaskKey('owner', 'old', 'request', 'round');
    const changed = store.get('old'); changed.observation = { questions: [] }; store.save(changed);
    assert.equal(store.get('old').task.nativeQuestions[0].message, 'private native question');
    store.remove(changed, { deliveredReceipt: true });
    const receipt = store.resolveTaskKey('owner', key);
    assert.equal(receipt.receipt.finalSubmissionId, 'final');
    assert.doesNotMatch(JSON.stringify(receipt), /private native question/);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM agent_history WHERE agent=?').get('old').n, 0);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM agents WHERE id=?').get('old').n, 0);
  } finally { store.close(); }
});
