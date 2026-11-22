import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RosterStore } from '../src/roster-store.mjs';
import { createRosterCleanup } from '../src/cleanup-roster.mjs';
import { readRosterTree, claimRosterTree, readRosterTicket, listRosterTickets, verifyRosterTicket, releaseRosterTicket, readRosterArchives } from '../src/cleanup-roster-transaction.mjs';

function fixture() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'roster-claim-'));
  const file = path.join(dir, 'roster.sqlite');
  const store = new RosterStore(file);
  store.saveOwner({ ownerId: 'o', workspace: 'w' });
  store.insert({ agentId: 'a', ownerId: 'o', name: '根', sessionId: 's', state: 'idle', task: { taskId: 't', reports: [{ id: 'r', message: '原文\n中文 🐟', final: true }] } });
  store.insert({ agentId: 'b', ownerId: 'o', name: '子', parentAgentId: 'a', sessionId: 'child', state: 'idle' });
  store.enqueueSubmission({ id: 'q', ownerId: 'o', agentId: 'a', taskId: 't', kind: 'ask', message: '问题\n原文', created: '2026-01-01T00:00:00.000Z' });
  return { dir, file, store, close() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('claim archives exact text, closes all members, survives stale save and restart', () => {
  const f = fixture();
  try {
    const old = f.store.get('a');
    const before = readRosterTree(f.file, 'a');
    const ticket = claimRosterTree(f.file, { rootId: 'a', fingerprint: before.fingerprint, ticketId: 'ticket' });
    assert.equal(ticket.status, 'claimed');
    assert.deepEqual(JSON.parse(ticket.tree_ids), ['a', 'b']);
    assert.equal(f.store.get('a').closed, true);
    assert.equal(f.store.get('b').closed, true);
    assert.notEqual(f.store.get('a').state, 'cleaning');
    assert.throws(() => f.store.submitParentMessage('a', { kind: 'report', message: 'late' }), /no active managed task/);
    assert.equal(f.store.requestCleanup(old), false);
    assert.equal(f.store.saveBackendState('a',{requests:{new:{status:'accepted'}}}), false);
    assert.throws(() => f.store.insert({ agentId: 'c', ownerId: 'o', name: 'c', parentAgentId: 'a' }, { requireOpenParent: true }), /closed/);
    old.state = 'cleaning'; old.extra = 'stale-save';
    assert.throws(() => f.store.save(old), /cleanup ticket/);
    assert.equal(f.store.get('a').closed, true);
    assert.equal(f.store.get('a').cleanupRosterTicket, 'ticket');
    assert.equal(f.store.get('a').state, 'idle');
    assert.equal(readRosterArchives(f.file, { name: '根', originalId: 'q' })[0].payload.message, '问题\n原文');
    assert.equal(readRosterArchives(f.file, { name: '根' }).find(row => row.source === 'embedded-message').payload.message, '原文\n中文 🐟');
    assert.equal(readRosterTicket(f.file, 'ticket').status, 'claimed');
    assert.equal(listRosterTickets(f.file).length, 1);
    assert.equal(verifyRosterTicket(f.file, 'ticket').valid, true);
    assert.equal(claimRosterTree(f.file, { rootId: 'a', fingerprint: before.fingerprint, ticketId: 'ticket' }).status, 'claimed');
    assert.equal(releaseRosterTicket(f.file, 'ticket').status, 'released');
    assert.equal(releaseRosterTicket(f.file, 'ticket').status, 'released');
    assert.equal(f.store.get('a').closed, undefined);
    assert.equal(f.store.get('a').extra, undefined);
  } finally { f.close(); }
});

test('a live name lease prevents the tree claim', () => {
  const f=fixture();
  try {
    const tree=readRosterTree(f.file,'a');
    f.store.claimLease('b','worker',60000);
    assert.throws(() => claimRosterTree(f.file,{rootId:'a',fingerprint:tree.fingerprint,ticketId:'lease'}),/tree-lease-held/);
    assert.equal(f.store.get('a').closed,undefined);
  } finally { f.close(); }
});

test('restart verification detects changed tree and damaged archive', () => {
  const f = fixture();
  try {
    const tree = readRosterTree(f.file, 'a');
    claimRosterTree(f.file, { rootId: 'a', fingerprint: tree.fingerprint, ticketId: 'ticket' });
    assert.equal(verifyRosterTicket(f.file, 'ticket').valid, true);
    f.store.db.prepare("UPDATE submissions SET message='late' WHERE id='q'").run();
    assert.equal(verifyRosterTicket(f.file, 'ticket').reason, 'claimed-tree-changed');
    f.store.db.prepare("UPDATE submissions SET message='问题\n原文' WHERE id='q'").run();
    f.store.db.prepare("UPDATE cleanup_archives SET payload='damaged' WHERE source='submission'").run();
    assert.equal(verifyRosterTicket(f.file, 'ticket').reason, 'archive-verification-failed');
    assert.throws(() => readRosterArchives(f.file), /archive-hash-mismatch/);
  } finally { f.close(); }
});

test('preview fingerprint can be claimed without a second inconsistent snapshot', async () => {
  const f = fixture();
  try {
    const engine = createRosterCleanup({ stateDirectory: f.dir });
    const preview = await engine.inventory();
    assert.equal(preview.complete, true);
    const item = preview.items.find(entry => entry.agentId === 'a');
    assert.equal(engine.claim(item, { ticketId: 'preview' }).status, 'claimed');
    assert.equal(engine.verifyTicket('preview').valid, true);
  } finally { f.close(); }
});

test('changed tree, changed inbox and archive conflicts roll back all closure', () => {
  const f = fixture();
  try {
    const stale = readRosterTree(f.file, 'a');
    f.store.insert({ agentId: 'c', ownerId: 'o', name: 'c', parentAgentId: 'b', state: 'idle' });
    assert.throws(() => claimRosterTree(f.file, { rootId: 'a', fingerprint: stale.fingerprint, ticketId: 'stale' }), /fingerprint-changed/);
    const beforeInput = readRosterTree(f.file, 'a');
    f.store.enqueueSubmission({ id: 'q2', ownerId: 'o', agentId: 'b', taskId: 't', kind: 'report', message: 'new', created: '2026-01-01T00:00:00.000Z' });
    assert.throws(() => claimRosterTree(f.file, { rootId: 'a', fingerprint: beforeInput.fingerprint, ticketId: 'input' }), /fingerprint-changed/);
    const clean = readRosterTree(f.file, 'a');
    claimRosterTree(f.file, { rootId: 'a', fingerprint: clean.fingerprint, ticketId: 'one' });
    releaseRosterTicket(f.file, 'one');
    f.store.db.prepare("UPDATE submissions SET message='different' WHERE id='q'").run();
    const changed = readRosterTree(f.file, 'a');
    assert.throws(() => claimRosterTree(f.file, { rootId: 'a', fingerprint: changed.fingerprint, ticketId: 'two' }), /archive-conflict/);
    assert.equal(f.store.get('a').closed, undefined);
    assert.equal(readRosterTicket(f.file, 'two'), undefined);
  } finally { f.close(); }
});
