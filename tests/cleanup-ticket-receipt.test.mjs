import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RosterStore } from '../src/roster-store.mjs';
import { readRosterTree, claimRosterTree, recordRosterStep, completeRosterTicket, readRosterTicket, voidRosterRecipient } from '../src/cleanup-roster-transaction.mjs';

function fixture(delivered = true) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-receipt-'));
  const file = path.join(dir, 'roster.sqlite');
  const store = new RosterStore(file);
  store.saveOwner({ ownerId: 'owner', workspace: dir });
  const record = { agentId: 'old', ownerId: 'owner', name: 'same', sessionId: 's', state: 'completed', lifetime: 'once',
    task: { taskId: 'round', reports: delivered ? [{ id: 'submission:done', final: true, delivery: { state: 'delivered' } }] : [] } };
  store.insert(record);
  const key = store.saveTaskKey('owner', 'old', 'request', 'round');
  const tree = readRosterTree(file, 'old');
  claimRosterTree(file, { rootId: 'old', fingerprint: tree.fingerprint, ticketId: 'ticket' });
  recordRosterStep(file, 'ticket', 'old', 'native-complete', { removed: true });
  recordRosterStep(file, 'ticket', 'old', 'private-complete', { removed: true });
  return { file, store, key, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('ticket without delivered final removes the key without inventing a receipt', () => {
  const f = fixture(false);
  try { completeRosterTicket(f.file, 'ticket'); assert.equal(f.store.resolveTaskKey('owner', f.key), null); }
  finally { f.close(); }
});

test('ticket rolls back receipt, deletion and ticket status together on failure', () => {
  const f = fixture();
  try {
    f.store.db.exec("CREATE TRIGGER fail_ticket_delete BEFORE DELETE ON agents BEGIN SELECT RAISE(ABORT,'injected'); END");
    assert.throws(() => completeRosterTicket(f.file, 'ticket'), /injected/);
    assert.ok(f.store.get('old'));
    assert.equal(f.store.resolveTaskKey('owner', f.key).receipt, null);
    assert.equal(readRosterTicket(f.file, 'ticket').status, 'claimed');
  } finally { f.close(); }
});

test('old roster without task_keys completes the ticket unchanged', () => {
  const f = fixture();
  try {
    f.store.db.exec('DROP TABLE task_keys');
    assert.deepEqual(completeRosterTicket(f.file, 'ticket'), { completed: true });
    assert.equal(f.store.get('old'), undefined);
  } finally { f.close(); }
});

for (const viaTicket of [false, true]) test(`all keyed rounds and input failures survive ${viaTicket ? 'ticket' : 'store'} cleanup`, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'receipt-rounds-'));
  const file = path.join(dir, 'roster.sqlite'), store = new RosterStore(file);
  try {
    store.saveOwner({ ownerId: 'owner', workspace: dir });
    const current = { agentId: 'old', ownerId: 'owner', name: 'same', sessionId: 's', state: 'running', lifetime: 'once',
      task: { taskId: 'current', reports: [], dispatches: [] } };
    store.insert(current);
    const oldKey = store.saveTaskKey('owner', 'old', 'old-request', 'historical');
    const key = store.saveTaskKey('owner', 'old', 'current-request', 'current');
    const submissionKey = store.saveTaskKey('owner', 'old', 'submission-request', 'submission-round');
    store.enqueueSubmission({ id: 'delivered-old', ownerId: 'owner', agentId: 'old', taskId: 'submission-round', kind: 'report', message: 'private', final: true, created: '2026-01-01T00:00:00.000Z' });
    store.saveSubmissionDelivery('delivered-old', { state: 'delivered', deliveredAt: '2026-01-02T00:00:00.000Z' });
    store.appendHistory('old', { taskId: 'historical', reports: [{ id: 'older', final: true, delivery: { state: 'delivered' } }] });
    store.appendHistory('old', { taskId: 'historical', reports: [{ id: 'latest', final: true, delivery: { state: 'delivered' } }] });
    assert.equal(store.enqueueSupplement(current, 'blocked', 'private', undefined, { mode: 'steer' }), true);
    const blocked = store.taskKeyForRequest('owner', 'blocked');
    store.setSupplement('blocked', 'blocked', 'dispatch-expired');
    current.task.reports = [{ id: 'current-final', final: true, delivery: { state: 'delivered' } }]; store.save(current);
    if (viaTicket) {
      const tree = readRosterTree(file, 'old'); claimRosterTree(file, { rootId: 'old', fingerprint: tree.fingerprint, ticketId: 't' });
      recordRosterStep(file, 't', 'old', 'native-complete', { removed: true });
      recordRosterStep(file, 't', 'old', 'private-complete', { removed: true });
      completeRosterTicket(file, 't');
    } else store.remove(current, { deliveredReceipt: true });
    assert.equal(store.resolveTaskKey('owner', oldKey).receipt.finalSubmissionId, 'latest');
    assert.equal(store.resolveTaskKey('owner', key).receipt.finalSubmissionId, 'current-final');
    assert.equal(store.resolveTaskKey('owner', submissionKey).receipt.finalSubmissionId, 'delivered-old');
    assert.equal(store.resolveTaskKey('owner', blocked).failureReason, 'dispatch-expired');
    assert.equal(store.resolveTaskKey('owner', blocked).receipt, null);
    assert.equal(store.resolveTaskKey('other', oldKey), null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('recipient void keeps blocked request failure without a delivered final', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'receipt-void-'));
  const file = path.join(dir, 'roster.sqlite'), store = new RosterStore(file);
  try {
    store.saveOwner({ ownerId: 'owner', workspace: dir });
    const current = { agentId: 'a', ownerId: 'owner', name: 'same', sessionId: 's', state: 'running',
      task: { taskId: 'round', reports: [], dispatches: [] } };
    store.insert(current);
    assert.equal(store.enqueueSupplement(current, 'queued', 'private', undefined, { mode: 'queue' }), true);
    const key = store.taskKeyForRequest('owner', 'queued');
    const tree = readRosterTree(file, 'a'); claimRosterTree(file, { rootId: 'a', fingerprint: tree.fingerprint, ticketId: 'void' });
    voidRosterRecipient(file, 'void', 'owner');
    recordRosterStep(file, 'void', 'a', 'native-complete', { removed: true });
    recordRosterStep(file, 'void', 'a', 'private-complete', { removed: true });
    completeRosterTicket(file, 'void');
    const result = store.resolveTaskKey('owner', key);
    assert.equal(result.failureReason, 'recipient-deleted');
    assert.equal(result.receipt, null);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
