import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { RosterStore } from '../src/roster-store.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agent = (id, name) => ({
  agentId: `agent-${id.repeat(32)}`, ownerId: 'owner-test', sessionId: `session-${id}`,
  name, lifetime: 'persistent', workspace, state: 'running', created: true,
  task: { taskId: `task-${id}`, state: 'running', dispatches: [] },
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [],
});

async function directory() {
  const base = path.join(workspace, '.runtime', 'tests', 'roster-selection');
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, 'run-'));
}

test('queued supplements freeze an explicit selection or the live pin', async () => {
  const store = new RosterStore(':memory:');
  try {
    const record = agent('a', 'artist');
    store.insert(record);
    assert.equal(store.enqueueSupplement(record, 'request-explicit', 'one',
      { provider: 'p', model: 'full-model', reasoningEffort: 'high' }), true);
    assert.deepEqual(store.supplements(record.agentId)[0].selection,
      { provider: 'p', model: 'full-model', reasoningEffort: 'high' });

    record.modelPin = { provider: 'p', model: 'pinned-model', reasoningEffort: 'low' };
    store.save(record);
    assert.equal(store.enqueueSupplement(record, 'request-pin', 'two', undefined, { usePinnedModel: true }), true);
    assert.deepEqual(store.supplements(record.agentId).at(-1).selection,
      { provider: 'p', model: 'pinned-model', reasoningEffort: 'low' },
      'the SQL copies the pin at enqueue time');

    const noPin = agent('b', 'other');
    store.insert(noPin);
    assert.equal(store.enqueueSupplement(noPin, 'request-none', 'three', undefined, { usePinnedModel: true }), true);
    assert.equal(store.supplements(noPin.agentId)[0].selection, undefined,
      'no pin leaves the input on the target default');
  } finally { store.close(); }
});

test('an explicit pin and its queued supplement commit or roll back together', async () => {
  const store = new RosterStore(':memory:');
  try {
    const record = agent('c', 'writer');
    record.modelPin = { provider: 'p', model: 'old-model' };
    store.insert(record);
    record.modelPin = { provider: 'p', model: 'new-model', reasoningEffort: 'high' };
    assert.equal(store.enqueueSupplement(record, 'request-atomic', 'do it',
      { provider: 'p', model: 'new-model', reasoningEffort: 'high' }, { saveRecord: true }), true);
    assert.deepEqual(store.get(record.agentId).modelPin,
      { provider: 'p', model: 'new-model', reasoningEffort: 'high' });
    assert.deepEqual(store.supplements(record.agentId)[0].selection,
      { provider: 'p', model: 'new-model', reasoningEffort: 'high' });

    // Make the INSERT SELECT fail (creating is not a supplement state). The pin
    // write in the same transaction must roll back with it. `idle` would be
    // promoted back to running by save() while a supplement is queued.
    record.state = 'creating';
    record.modelPin = { provider: 'p', model: 'rejected-model' };
    assert.equal(store.enqueueSupplement(record, 'request-rollback', 'no',
      { provider: 'p', model: 'rejected-model' }, { saveRecord: true }), false);
    assert.deepEqual(store.get(record.agentId).modelPin,
      { provider: 'p', model: 'new-model', reasoningEffort: 'high' });
    assert.equal(store.supplements(record.agentId).some(item => item.requestId === 'request-rollback'), false);
  } finally { store.close(); }
});

test('a Claude CLI callback fences earlier and later queue writes at final submission', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = { ...agent('d', 'headless'), target: 'claude-cli' };
    const { taskId } = record.task;
    record.task.dispatches.push({ requestId: 'current-input', kind: 'supplement', state: 'sending' });
    store.insert(record);
    const submit = final => store.submitParentMessage(record.agentId, { kind: 'report', message: 'work status', final },
      { taskId, requestId: 'current-input' });

    assert.equal(store.enqueueSupplement(record, 'current-input', 'already being read by this turn'), true);
    store.setSupplement('current-input', 'sending');
    assert.equal(store.enqueueSupplement(record, 'later-input', 'the next turn will receive this'), true);
    assert.equal(submit(false).accepted, true, 'progress reports can pass while input is pending');
    for (const status of ['queued', 'sending', 'unknown']) {
      store.setSupplement('later-input', status);
      assert.throws(() => submit(true), { code: 'supplement-undelivered' });
    }
    assert.equal(store.submissions(record.agentId, taskId).some(item => item.final), false);

    store.setSupplement('later-input', 'blocked', 'final-submitted');
    assert.equal(submit(true).accepted, true, 'the current input and a historical blocked input do not prevent final');
    const lateSelection = { provider: 'claude-cli', model: 'claude-sonnet-5-5', reasoningEffort: 'high' };
    record.modelPin = lateSelection;
    assert.throws(() => store.enqueueSupplement(record, 'too-late', 'arrives after final was submitted', lateSelection,
      { saveRecord: true }), { code: 'final-already-submitted' }, 'the final inbox row closes the queue before it is absorbed');
    assert.equal(store.get(record.agentId).modelPin, undefined);
    assert.equal(store.supplement('too-late'), undefined);
    assert.equal(store.supplement('later-input').status, 'blocked');
  } finally { store.close(); }
});

test('an older roster gains the selection column without losing queued rows', async () => {
  const dir = await directory();
  const file = path.join(dir, 'roster.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE supplements (requestId TEXT PRIMARY KEY, owner TEXT NOT NULL, agent TEXT NOT NULL,
    session TEXT NOT NULL, task TEXT NOT NULL, message TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, created TEXT NOT NULL);
    INSERT INTO supplements(requestId,owner,agent,session,task,message,status,created)
      VALUES ('legacy','owner-test','agent-old','session-old','task-old','keep me','queued','2026-01-01T00:00:00.000Z');`);
  old.close();
  for (let pass = 0; pass < 2; pass++) {
    const store = new RosterStore(file);
    try {
      const columns = store.db.prepare('PRAGMA table_info(supplements)').all().map(row => row.name);
      for (const column of ['selection', 'mode', 'selectionExplicit', 'receipt']) assert.ok(columns.includes(column));
      const row = store.db.prepare("SELECT message,selection,mode,selectionExplicit,receipt FROM supplements WHERE requestId='legacy'").get();
      assert.equal(row.message, 'keep me');
      assert.equal(row.selection, null);
      const [queued] = store.supplements('agent-old');
      assert.equal(queued.mode, undefined, 'an old row keeps the old target behaviour');
      assert.equal(queued.selectionExplicit, undefined);
      assert.equal(queued.receipt, undefined);
      const [input] = store.supplementInputs('agent-old', 'task-old');
      assert.equal(input.message, 'keep me');
      assert.equal(input.status, 'queued');
      assert.equal(input.delivery, 'local-pending');
      assert.equal(input.accepted, false);
      assert.equal(input.queued, true);
      assert.equal(input.createdAt, '2026-01-01T00:00:00.000Z');
    } finally { store.close(); }
  }
});

test('a queued input keeps its mode, explicit-selection flag and receipt', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = { ...agent('e', 'planner'), target: 'codex-desktop' };
    store.insert(record);
    const receipt = { delivery: 'after-current', accepted: false, queued: true, afterTurnId: 'turn-a' };
    assert.equal(store.enqueueSupplement(record, 'request-queue', 'read this next', undefined,
      { mode: 'queue', selectionExplicit: false, receipt }), true);
    const [queued] = store.supplements(record.agentId);
    assert.equal(queued.mode, 'queue');
    assert.equal(queued.selectionExplicit, false);
    assert.deepEqual(queued.receipt, receipt);
    const one = store.supplement('request-queue');
    assert.equal(one.mode, 'queue');
    assert.equal(one.selectionExplicit, false);
    assert.deepEqual(one.receipt, receipt);
    assert.equal(one.message, 'read this next');

    // An explicit model is an explicit selection unless the caller says otherwise.
    assert.equal(store.enqueueSupplement(record, 'request-steer', 'look here',
      { provider: 'p', model: 'm' }, { mode: 'steer' }), true);
    assert.equal(store.supplements(record.agentId).at(-1).selectionExplicit, true);

    // Illegal modes are refused before anything is written.
    assert.throws(() => store.enqueueSupplement(record, 'request-bad', 'no', undefined, { mode: 'later' }),
      { code: 'invalid-mode' });
    assert.equal(store.supplement('request-bad'), undefined);
  } finally { store.close(); }
});

test('setSupplement merges a receipt into the one already stored', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = { ...agent('f', 'dispatcher'), target: 'codex-desktop' };
    store.insert(record);
    store.enqueueSupplement(record, 'request-r', 'do it', undefined, { mode: 'queue',
      receipt: { delivery: 'after-current', accepted: false, queued: true, afterTurnId: 'turn-a' } });
    assert.equal(store.setSupplement('request-r', 'accepted', null,
      { delivery: 'new-turn', accepted: true, queued: false, turnId: 'turn-b' }), true);
    const accepted = store.supplement('request-r');
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.reason, null);
    assert.deepEqual(accepted.receipt, { delivery: 'new-turn', accepted: true, queued: false,
      afterTurnId: 'turn-a', turnId: 'turn-b' }, 'the later receipt step keeps what the earlier one knew');

    store.setSupplement('request-r', 'blocked', 'task-cancelled');
    assert.deepEqual(store.supplement('request-r').receipt, accepted.receipt,
      'a status-only update leaves the receipt alone');
    assert.equal(store.setSupplement('request-missing', 'blocked'), false);
  } finally { store.close(); }
});

test('inspect sees every input of a round, accepted ones included', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = { ...agent('g', 'foreman'), target: 'codex-desktop' };
    store.insert(record);
    store.enqueueSupplement(record, 'request-first', 'round one text', undefined, { mode: 'queue' });
    record.task = { taskId: 'task-second', state: 'running', dispatches: [] };
    store.save(record);
    store.enqueueSupplement(record, 'request-second', 'round two text', undefined, { mode: 'steer' });
    store.setSupplement('request-second', 'accepted', null,
      { delivery: 'current-turn', accepted: true, queued: false, turnId: 'turn-a' });
    store.enqueueSupplement(record, 'request-old-accepted', 'accepted with no receipt', undefined, { mode: 'steer' });
    store.setSupplement('request-old-accepted', 'accepted');

    assert.deepEqual(store.supplements(record.agentId).map(item => item.requestId), ['request-first'],
      'the work queue hides accepted inputs');
    const inputs = store.supplementInputs(record.agentId, 'task-second');
    assert.deepEqual(inputs.map(item => item.requestId), ['request-second', 'request-old-accepted']);
    const [routed, legacy] = inputs;
    assert.equal(routed.mode, 'steer');
    assert.equal(routed.delivery, 'current-turn');
    assert.equal(routed.accepted, true);
    assert.equal(routed.queued, false);
    assert.equal(routed.turnId, 'turn-a');
    assert.equal(routed.status, 'accepted');
    assert.equal(routed.message, 'round two text');
    assert.equal(typeof routed.createdAt, 'string');
    assert.equal(legacy.accepted, true);
    assert.equal(legacy.delivery, 'accepted-route-unknown',
      'accepted alone does not claim which turn carried the input');
    assert.equal(legacy.turnId, undefined);
    assert.equal(legacy.queued, false);
    assert.deepEqual(store.supplementInputs(record.agentId).map(item => item.requestId),
      ['request-first', 'request-second', 'request-old-accepted'], 'no round filter lists every round');
  } finally { store.close(); }
});

test('a queued Codex input holds the final until native acceptance or a settled outcome', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = { ...agent('h', 'chief'), target: 'codex-desktop' };
    store.insert(record);
    const submit = final => store.submitParentMessage(record.agentId, { kind: 'report', message: 'done', final });
    store.enqueueSupplement(record, 'request-q', 'one more change', undefined, { mode: 'queue' });
    assert.throws(() => submit(true), { code: 'supplement-undelivered' });
    assert.equal(submit(false).accepted, true, 'a progress report can pass while input is pending');
    store.setSupplement('request-q', 'accepted', null,
      { delivery: 'new-turn', accepted: true, queued: false, turnId: 'turn-b' });
    assert.equal(submit(true).accepted, true, 'native acceptance evidence lets the final converge');
  } finally { store.close(); }
});

test('one accepted input never lets another undecided input through', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = { ...agent('i', 'chief2'), target: 'codex-desktop' };
    store.insert(record);
    const submit = final => store.submitParentMessage(record.agentId, { kind: 'report', message: 'done', final });
    store.enqueueSupplement(record, 'request-ok', 'already accepted', undefined, { mode: 'steer',
      receipt: { delivery: 'current-turn', accepted: true, queued: false, turnId: 'turn-a' } });
    store.enqueueSupplement(record, 'request-waiting', 'still waiting', undefined, { mode: 'queue' });
    assert.throws(() => submit(true), { code: 'supplement-undelivered' },
      'the accepted input is not evidence for the undecided one');
    store.setSupplement('request-waiting', 'blocked', 'task-cancelled');
    assert.equal(submit(true).accepted, true, 'a settled input does not hold the final for ever');
  } finally { store.close(); }
});

test('native acceptance recorded before the receipt still lets the Codex final through', () => {
  const store = new RosterStore(':memory:');
  try {
    // The target recorded the request as accepted; the monitor has not written the receipt.
    const backend = { ...agent('l', 'backend-evidence'), target: 'codex-desktop' };
    store.insert(backend);
    store.enqueueSupplement(backend, 'request-native', 'already in the new turn', undefined, { mode: 'queue' });
    store.saveBackendState(backend.agentId, { requests: { 'request-native': {
      requestId: 'request-native', taskId: backend.task.taskId, status: 'accepted', turnId: 'turn-b' } } });
    assert.equal(store.supplement('request-native').receipt, undefined, 'the receipt is still missing');
    assert.equal(store.submitParentMessage(backend.agentId,
      { kind: 'report', message: 'done', final: true }).accepted, true);

    // The same acceptance already on the task's dispatch is evidence too.
    const dispatched = { ...agent('m', 'dispatch-evidence'), target: 'codex-desktop' };
    store.insert(dispatched);
    store.enqueueSupplement(dispatched, 'request-dispatch', 'already steered', undefined, { mode: 'steer' });
    dispatched.task.dispatches.push({ requestId: 'request-dispatch', kind: 'supplement', accepted: true });
    store.save(dispatched);
    assert.equal(store.supplement('request-dispatch').receipt, undefined);
    assert.equal(store.submitParentMessage(dispatched.agentId,
      { kind: 'report', message: 'done', final: true }).accepted, true);

    // Evidence for one input never vouches for another undecided input.
    const mixed = { ...agent('n', 'mixed-evidence'), target: 'codex-desktop' };
    store.insert(mixed);
    store.enqueueSupplement(mixed, 'request-accepted', 'accepted', undefined, { mode: 'steer' });
    store.enqueueSupplement(mixed, 'request-undecided', 'undecided', undefined, { mode: 'queue' });
    store.saveBackendState(mixed.agentId, { requests: { 'request-accepted': {
      requestId: 'request-accepted', taskId: mixed.task.taskId, status: 'accepted', turnId: 'turn-c' } } });
    assert.throws(() => store.submitParentMessage(mixed.agentId,
      { kind: 'report', message: 'done', final: true }), { code: 'supplement-undelivered' });
    store.setSupplement('request-undecided', 'blocked', 'task-cancelled');
    assert.equal(store.submitParentMessage(mixed.agentId,
      { kind: 'report', message: 'done', final: true }).accepted, true);
  } finally { store.close(); }
});

test('acceptance recorded for another task does not release this final', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = { ...agent('o', 'stale-evidence'), target: 'codex-desktop' };
    store.insert(record);
    store.enqueueSupplement(record, 'request-stale', 'stale evidence', undefined, { mode: 'queue' });
    store.saveBackendState(record.agentId, { requests: { 'request-stale': {
      requestId: 'request-stale', taskId: 'task-another-round', status: 'accepted', turnId: 'turn-z' } } });
    assert.throws(() => store.submitParentMessage(record.agentId,
      { kind: 'report', message: 'done', final: true }), { code: 'supplement-undelivered' });
  } finally { store.close(); }
});

test('a pending input of another round does not hold this final', () => {
  const store = new RosterStore(':memory:');
  try {
    const record = { ...agent('j', 'chief3'), target: 'codex-desktop' };
    store.insert(record);
    store.enqueueSupplement(record, 'request-old-round', 'older round input', undefined, { mode: 'queue' });
    record.task = { taskId: 'task-current', state: 'running', dispatches: [] };
    store.save(record);
    assert.equal(store.submitParentMessage(record.agentId,
      { kind: 'report', message: 'current task done', final: true }).accepted, true);
    assert.equal(store.supplement('request-old-round').status, 'queued',
      'the old row keeps its own reason for the round it belongs to');
  } finally { store.close(); }
});

test('a supplement and a final on two connections settle in the order they commit', async () => {
  const dir = await directory();
  const file = path.join(dir, 'roster.sqlite');
  const first = new RosterStore(file);
  const second = new RosterStore(file);
  try {
    const record = { ...agent('k', 'two-connections'), target: 'codex-desktop' };
    first.insert(record);
    assert.equal(first.enqueueSupplement(record, 'request-before', 'pending text', undefined, { mode: 'queue' }), true);
    assert.throws(() => second.submitParentMessage(record.agentId,
      { kind: 'report', message: 'done', final: true }), { code: 'supplement-undelivered' });

    first.setSupplement('request-before', 'blocked', 'task-cancelled');
    assert.equal(second.submitParentMessage(record.agentId,
      { kind: 'report', message: 'done', final: true }).accepted, true);
    assert.equal(first.get(record.agentId).task.reports, undefined,
      'the final is only in submissions, not absorbed onto the task');
    assert.throws(() => first.enqueueSupplement(record, 'request-after', 'after the final'),
      { code: 'final-already-submitted' });
    assert.equal(first.supplement('request-after'), undefined);
  } finally { first.close(); second.close(); }
});
