import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RosterStore } from '../src/roster-store.mjs';
import { readRosterTree, claimRosterTree, recordRosterStep, completeRosterTicket, readRosterTicket } from '../src/cleanup-roster-transaction.mjs';

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
