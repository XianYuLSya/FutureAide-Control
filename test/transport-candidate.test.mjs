import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RosterStore } from '../src/roster-store.mjs';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { readRosterTree, claimRosterTree, verifyRosterTicket } from '../src/cleanup-roster-transaction.mjs';

test('real queue head is discovered and mixed business waits survive recovery', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'futureaide-candidate-'));
  const store = new RosterStore(path.join(root, 'roster.sqlite'));
  const wakes = [];
  const service = createScopedAgents({ stateDirectory: root }, { store, onWorkQueued: id => wakes.push(id) });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  const future = Date.now() + 300000;
  const record = { agentId: 'a', ownerId: 'o', name: 'n', sessionId: 's', target: 'codex-desktop', state: 'reconnecting',
    error: { code: 'codex-native-rpc-timeout' }, nextAttemptAt: future, transportNextAttemptAt: future,
    task: { taskId: 't', state: 'running', dispatches: [{ requestId: 'first', state: 'running', accepted: true },
      { requestId: 'd', state: 'retrying', accepted: false, error: { code: 'codex-native-rpc-timeout' }, nextAttemptAt: future, transportNextAttemptAt: future }] } };
  store.insert(record);
  assert.equal(store.enqueueSupplement(record, 'q', 'queued message', undefined, { mode: 'queue' }), true);
  await service.transportRecovered({ faultSequence: 1 });
  const actual = store.get('a');
  assert.equal(actual.nextAttemptAt, future);
  assert.equal(actual.task.dispatches[1].nextAttemptAt, future);
  assert.equal(actual.transportNextAttemptAt, undefined);
  assert.equal(actual.task.dispatches[1].transportNextAttemptAt, undefined);
  assert.deepEqual(wakes, ['a']);
  assert.ok(store.transportCandidates().includes('a'));
  assert.equal(store.transportCandidates({ probe: true }).length, 0);
  await service.transportRecovered({ faultSequence: 2 });
  assert.equal(store.get('a').nextAttemptAt, future);
  assert.equal(store.get('a').task.dispatches[1].nextAttemptAt, future);
  actual.error = { code: 'agent-busy' }; actual.task.dispatches[1].error = { code: 'agent-busy' }; store.save(actual);
  assert.equal(store.transportCandidates({ probe: true }).length, 0);
  actual.task.dispatches[0].state = 'completed';
  assert.equal(store.save(actual, { dispatch: true }), true);
});
test('busy name does not block the other recovery candidates and is retried', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'futureaide-busy-'));
  const store = new RosterStore(path.join(root, 'roster.sqlite'));
  const wakes = [];
  const service = createScopedAgents({ stateDirectory: root }, { store, onWorkQueued: id => wakes.push(id) });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  for (const id of ['a', 'b']) store.insert({ agentId: id, ownerId: 'o', name: id, target: 'codex-desktop',
    state: 'reconnecting', error: { code: 'codex-native-rpc-timeout' }, nextAttemptAt: Date.now() + 300000,
    task: { taskId: id, state: 'running', dispatches: [] } });
  let release, locked;
  const ready = new Promise(resolve => { locked = resolve; });
  const held = store.locked('a', async () => { locked(); await new Promise(resolve => { release = resolve; }); });
  await ready;
  await service.transportRecovered({ faultSequence: 1 });
  assert.ok(wakes.includes('b'));
  assert.equal(store.get('b').nextAttemptAt, undefined);
  release(); await held;
  const deadline = Date.now() + 3000;
  while (store.get('a').nextAttemptAt !== undefined && Date.now() < deadline) await new Promise(r => setTimeout(r, 50));
  assert.equal(store.get('a').nextAttemptAt, undefined);
});

test('legacy report delivery releases its transport delay and retains its own report deadline', async t => {
  const store = new RosterStore(':memory:');
  const wakes = [];
  const service = createScopedAgents({ stateDirectory: os.tmpdir() }, { store, onWorkQueued: id => wakes.push(id) });
  t.after(() => service.close());
  const deadline = Date.now() + 300000;
  store.insert({ agentId: 'a', ownerId: 'owner', name: 'reporter', target: 'codex-desktop', state: 'delivery_pending',
    nextAttemptAt: deadline, error: { code: 'codex-native-rpc-closed' },
    task: { taskId: 'task', result: 'done', reports: [{ delivery: { state: 'pending', nextAttemptAt: deadline } }] } });
  assert.deepEqual(store.transportCandidates({ probe: true }), ['a']);
  await service.transportRecovered({ faultSequence: 2 });
  assert.deepEqual(wakes, ['a']);
  assert.equal(store.get('a').nextAttemptAt, undefined);
  assert.equal(store.get('a').task.reports[0].delivery.nextAttemptAt, deadline);
});

test('a cleanup claim between candidate selection and recovery leaves the archived name alone', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'futureaide-claimed-'));
  const file = path.join(root, 'roster.sqlite');
  const store = new RosterStore(file);
  const wakes = [];
  const service = createScopedAgents({ stateDirectory: root }, { store, onWorkQueued: id => wakes.push(id) });
  t.after(async () => { service.close(); await rm(root, { recursive: true, force: true }); });
  store.saveOwner({ ownerId: 'owner', workspace: root });
  store.insert({ agentId: 'a', ownerId: 'owner', name: 'claimed', sessionId: 's', target: 'codex-desktop',
    state: 'reconnecting', error: { code: 'codex-native-rpc-closed' }, nextAttemptAt: Date.now() + 300000 });
  const pending = store.transportCandidates();
  assert.deepEqual(pending, ['a']);
  claimRosterTree(file, { rootId: 'a', fingerprint: readRosterTree(file, 'a').fingerprint, ticketId: 'ticket' });
  assert.deepEqual(store.transportCandidates({ probe: true }), []);
  assert.deepEqual(store.transportCandidates(), []);
  await service.transportRecovered({ faultSequence: 1 }, pending);
  assert.deepEqual(wakes, []);
  assert.equal(store.get('a').closed, true);
  assert.equal(verifyRosterTicket(file, 'ticket').valid, true);
});
