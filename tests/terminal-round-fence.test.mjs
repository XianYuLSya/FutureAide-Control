// A released/failed round must never send a turn again, and nothing queued is sent after
// its own six hours. These cases drive the real shared state machine against a stand-in
// Codex backend, starting from the records a live roster was found in (release-315: a
// failed round whose thread is gone, no dispatch, an undelivered legacy message).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createScopedAgents, terminalRound } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SIX_HOURS = 6 * 60 * 60 * 1000;
const ago = ms => new Date(Date.now() - ms).toISOString();

function fakeCodex({ onDeliver, onModel, onReceipt } = {}) {
  const sends = [];
  const methods = ['probe', 'create', 'beginTask', 'observe', 'history', 'answer', 'deliver', 'receipt',
    'turn', 'models', 'model', 'selectModel', 'cancel', 'destroy', 'cursor'];
  const backend = {
    get observes() { return backend.__observes; },
    __observes: 0,
    target: 'codex-desktop', labels: { host: 'Codex Desktop', bridge: 'The Codex Desktop bridge' }, requiredMethods: methods,
    async probe() { return { identity: { application: 'codex-desktop' }, methods, treeProtocol: 1, reportProtocol: 1, evidence: 'fake' }; },
    async create() { return { sessionId: 'session-r', modelRequestsStarted: 0 }; },
    async beginTask() { return { treeProtocol: 1, reportProtocol: 1, throughSeq: 0 }; },
    async model() { return onModel?.(); },
    async deliver(request) {
      // The adapter's own asynchronous preparation happens here, before it writes.
      if (onDeliver) await onDeliver(request);
      sends.push(request);
      return { accepted: true, status: 'accepted', afterSeq: 0 };
    },
    async cursor() { return { throughSeq: 0 }; },
    async turn() { return { state: 'running' }; },
    async receipt(request) { return onReceipt?.(request); },
    async observe() { backend.__observes += 1; return { sessionId: 'session-x', taskId: 'task-x', running: false, throughSeq: 0,
      questions: [], reports: [], changes: [], coverage: {}, tree: { settled: true, running: false, nodes: [] } }; },
    async models() { return { models: [], defaultModel: null }; },
    async selectModel() { return { accepted: false }; },
    async history() { return { messages: [], hasMore: false }; },
    async answer() { return { consumedQuestionIds: [] }; },
    async cancel() { return { cancelRequested: true }; },
    async destroy() { return { destroyed: true }; },
  };
  return { backend, sends };
}

const round = (overrides = {}) => ({
  agentId: 'agent-r', ownerId: 'owner-r', name: 'helper', sessionId: 'session-r', target: 'codex-desktop',
  lifetime: 'persistent', workspace, created: true, createdAt: ago(60000), updatedAt: ago(60000), history: [],
  state: 'running',
  task: { taskId: 'task-r', message: 'the original body', state: 'running', startedAt: ago(60000),
    dispatches: [], answers: [], reports: [] },
  observation: { questions: [], tree: { settled: false, running: false } },
  ...overrides,
});

async function fixture(options = {}) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'fence-'));
  const store = new RosterStore(':memory:');
  const codex = fakeCodex(options);
  const notices = [];
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store,
    clientFactory: () => { throw new Error('no DSH host is needed for these cases'); },
    callCodex: async (threadId, tool, args) => {
      if (tool === 'read_thread') return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } };
      notices.push(args.prompt);
      return { accepted: true };
    },
    backendAdapters: { 'codex-desktop': async () => codex.backend },
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  return { service, store, codex, notices };
}

test('a failed round whose thread is gone sends nothing, even with an old message owed', async () => {
  const f = await fixture();
  try {
    // release-315 as it was found: failed, English missing-thread error, no dispatch and no
    // newer marker, one delivered failure notice, plus a message an older build consumed
    // without recording a notice.
    const record = round({
      state: 'failed',
      error: { code: 'codex-thread-not-found', message: 'thread not found' },
      task: { taskId: 'task-r', message: 'the original body', state: 'failed', startedAt: ago(7200000),
        dispatches: [], answers: [],
        reports: [{ id: 'report-failure', failure: true, message: 'failed earlier',
          delivery: { id: 'notice-failure', state: 'delivered', createdAt: ago(7000000) } }] },
    });
    f.store.insert(record);
    f.store.enqueueSubmission({ id: 'legacy-1', ownerId: record.ownerId, agentId: record.agentId,
      taskId: 'task-r', kind: 'report', message: 'older round text', created: ago(7100000) });
    f.store.db.prepare("UPDATE submissions SET state='consumed', consumed=?, delivery=NULL WHERE id='legacy-1'")
      .run(ago(7000000));

    assert.equal(terminalRound(f.store.get(record.agentId)), 'failed', 'the missing thread makes the round terminal');
    await f.service.poll(record.agentId);

    assert.equal(f.codex.sends.length, 0, 'nothing was sent for the finished round');
    const after = f.store.get(record.agentId);
    assert.equal(after.state, 'failed', 'the round stays failed');
    assert.equal(after.task.state, 'failed');
    assert.equal(after.task.treeUnavailable, 'codex-thread-not-found', 'the legacy shape gains the marker');
    assert.equal(after.task.message, 'the original body', 'its body is kept');
    assert.equal(after.task.dispatches.length, 0);
    // The message it owed is still written out (this fixture has no owner channel, so its
    // notice stays retryable here); the round itself is closed.
    const [settled] = f.store.submissions(record.agentId, 'task-r');
    assert.ok(settled.delivery !== undefined, 'its notice was written');
    assert.equal(settled.message, 'older round text', 'and its body is kept');
  } finally { f.service.close(); }
});

test('a late ask on a failed round is delivered without reopening it', async () => {
  const f = await fixture();
  try {
    const record = round({ state: 'failed',
      error: { code: 'codex-thread-not-found', message: 'thread not found' },
      task: { taskId: 'task-r', message: 'the original body', state: 'failed', startedAt: ago(7200000),
        dispatches: [], answers: [], reports: [] } });
    f.store.insert(record);
    f.store.enqueueSubmission({ id: 'late-ask', ownerId: record.ownerId, agentId: record.agentId,
      taskId: 'task-r', kind: 'ask', message: 'which contract applies?' });

    await f.service.poll(record.agentId);

    const after = f.store.get(record.agentId);
    assert.equal(f.codex.sends.length, 0, 'the question never becomes a turn');
    assert.equal(after.state, 'failed', 'the round does not reopen as awaiting_input');
    // A round whose thread is gone takes no new question into its task, but the question is
    // still written out as a notice; the round itself stays finished.
    const [asked] = f.store.submissions(record.agentId, 'task-r');
    assert.ok(asked.delivery !== undefined, 'and its notice is written, not dropped');
  } finally { f.service.close(); }
});

test('a task never accepted within six hours expires once, keeping its body', async () => {
  const f = await fixture();
  try {
    const record = round({ state: 'running',
      task: { taskId: 'task-r', message: 'the original body', state: 'running', startedAt: ago(SIX_HOURS + 60000),
        dispatches: [], answers: [], reports: [] } });
    f.store.insert(record);

    await f.service.poll(record.agentId);

    const after = f.store.get(record.agentId);
    assert.equal(f.codex.sends.length, 0, 'the stale task is not sent');
    assert.equal(after.state, 'failed');
    assert.equal(after.task.state, 'failed');
    assert.equal(after.task.expired.reason, 'dispatch-expired');
    assert.equal(after.task.expired.startedAt, record.task.startedAt, 'aged from its own start');
    assert.equal(after.task.message, 'the original body', 'the body is kept');
    assert.equal(after.task.expired.reason, 'dispatch-expired', 'the list carries the reason, no extra notice');
  } finally { f.service.close(); }
});

test('a fresh task inside the window is still dispatched', async () => {
  const f = await fixture();
  try {
    const record = round();
    f.store.insert(record);
    await f.service.poll(record.agentId);
    assert.equal(f.codex.sends.length, 1, 'a live round still gets its first turn');
  } finally { f.service.close(); }
});

test('an expired queued supplement is closed without ending the running task', async () => {
  const f = await fixture();
  try {
    const record = round({ state: 'running',
      task: { taskId: 'task-r', message: 'the original body', state: 'running', startedAt: ago(7200000),
        dispatches: [{ requestId: 'request-main', kind: 'task', state: 'running', accepted: true, afterSeq: 0 }],
        answers: [], reports: [] } });
    f.store.insert(record);
    f.store.enqueueSupplement(record, 'request-old', 'a supplement nobody sent', undefined);
    f.store.db.prepare("UPDATE supplements SET created=? WHERE requestId='request-old'").run(ago(SIX_HOURS + 60000));

    await f.service.poll(record.agentId);

    const [supplement] = f.store.supplements(record.agentId);
    assert.equal(supplement.status, 'blocked');
    assert.equal(supplement.reason, 'dispatch-expired');
    assert.equal(supplement.message, 'a supplement nobody sent', 'its body is kept');
    const after = f.store.get(record.agentId);
    assert.equal(after.task.state, 'running', 'the running task is not ended by a supplement');
    assert.equal(after.task.reports.some(report => report.failure === true), false, 'no extra notice for it');
    assert.equal(after.expired.latest.reason, 'dispatch-expired');
    assert.equal(after.expired.count, 1);
    assert.equal(f.codex.sends.length, 0, 'the expired supplement is not sent');

    // The reason is on the record in a bounded shape; `list` surfaces it at its own top
    // level (tool-view passes `expired` through).
    assert.equal(after.expired.latest.reason, 'dispatch-expired');
    assert.equal(after.expired.latest.kind, 'supplement');
    assert.equal(after.expired.count, 1);
  } finally { f.service.close(); }
});

test('an adapter that refuses at its own last moment seals the input and stops', async () => {
  // The adapter waits inside its own preparation (host lock, state reads, preflight); by the
  // time it asks the shared gate the task has crossed six hours. It proves nothing was
  // written, so this one input is sealed and the round is not sent again.
  let f;
  f = await fixture({ onDeliver: async request => {
    if (request.kind !== 'task') return;
    f.store.db.prepare("UPDATE agents SET body=json_set(body,'$.task.startedAt',?) WHERE id=?")
      .run(ago(SIX_HOURS + 60000), 'agent-r');
    const reason = request.writeBlockReason?.();
    if (reason) throw Object.assign(new Error(reason), { code: reason, terminal: true, notSent: true });
  } });
  try {
    const record = round();
    f.store.insert(record);
    await f.service.poll(record.agentId);

    assert.equal(f.codex.sends.length, 0, 'nothing was written');
    const after = f.store.get(record.agentId);
    assert.equal(after.state, 'failed');
    assert.equal(after.task.state, 'failed');
    assert.equal(after.task.expired.reason, 'dispatch-expired');
    assert.equal(after.task.message, 'the original body', 'its body is kept');

    await f.service.poll(record.agentId);
    assert.equal(f.codex.sends.length, 0, 'and it is never retried');
  } finally { f.service.close(); }
});

test('a finished round settles an accepted final by reading the tree once', async () => {
  const f = await fixture();
  try {
    // A failed round that is not a missing thread, holding an accepted final whose tree was
    // never confirmed: the terminal branch reads the tree once and settles it, sending nothing.
    const record = round({ state: 'failed', error: { code: 'native-turn-failed', message: 'the turn failed' },
      task: { taskId: 'task-r', message: 'the original body', state: 'failed', startedAt: ago(60000),
        dispatches: [{ requestId: 'request-main', kind: 'task', state: 'failed', accepted: true, afterSeq: 0 }],
        answers: [],
        reports: [{ id: 'report-final', final: true, message: 'the final answer',
          delivery: { id: 'notice-final', state: 'delivered', createdAt: ago(30000) } }] } });
    f.store.insert(record);

    await f.service.poll(record.agentId);

    const after = f.store.get(record.agentId);
    assert.equal(f.codex.sends.length, 0, 'no new turn is opened for a finished round');
    assert.equal(f.codex.backend.observes, 1, 'the tree is read once for the final, read-only');
    assert.equal(after.state, 'failed', 'and the round keeps the state it had');
    assert.equal(after.task.message, 'the original body');
  } finally { f.service.close(); }
});

test('an expired supplement reads back its accepted native receipt', async () => {
  const f = await fixture({ onReceipt: ({ requestId }) =>
    requestId === 'request-old' ? { status: 'accepted', afterSeq: 1 } : undefined });
  try {
    const record = round({ state: 'running',
      task: { taskId: 'task-r', message: 'the original body', state: 'running', startedAt: ago(7200000),
        dispatches: [{ requestId: 'request-main', kind: 'task', state: 'running', accepted: true, afterSeq: 0 },
          { requestId: 'request-old', kind: 'supplement', state: 'sending', afterSeq: 0 }],
        answers: [], reports: [] } });
    f.store.insert(record);
    f.store.enqueueSupplement(record, 'request-old', 'text that did arrive', undefined);
    f.store.db.prepare("UPDATE supplements SET created=?, status='sending' WHERE requestId='request-old'")
      .run(ago(SIX_HOURS + 60000));

    await f.service.poll(record.agentId);

    // Accepted evidence keeps its place: the row leaves the queue as accepted, never sealed
    // with an expiry reason, and nothing is sent for it again.
    assert.equal(f.store.supplement('request-old').status, 'accepted');
    const after = f.store.get(record.agentId);
    assert.equal(after.task.dispatches.find(entry => entry.requestId === 'request-old').accepted, true);
    assert.equal(f.codex.sends.length, 0, 'and nothing is sent again');
  } finally { f.service.close(); }
});

test('model preparation cannot write an old task back over a successor', async () => {
  let f;
  f = await fixture({ onModel: () => {
    f.store.db.prepare("UPDATE agents SET body=json_set(body,'$.task.taskId','task-next') WHERE id=?")
      .run('agent-r');
  } });
  try {
    f.store.insert(round());
    await f.service.poll('agent-r');
    assert.equal(f.store.get('agent-r').task.taskId, 'task-next');
    assert.equal(f.codex.sends.length, 0);
  } finally { f.service.close(); }
});

test('an adapter refusal after the round moved on writes nothing back', async () => {
  let f;
  f = await fixture({ onDeliver: async request => {
    if (request.kind !== 'task') return;
    // The round is replaced while the adapter prepares its write.
    f.store.db.prepare("UPDATE agents SET body=json_set(json_set(body,'$.task.taskId','task-next'),'$.state','running') WHERE id=?")
      .run('agent-r');
    const reason = request.writeBlockReason?.();
    if (reason) throw Object.assign(new Error(reason), { code: reason, terminal: true, notSent: true });
  } });
  try {
    const record = round();
    f.store.insert(record);
    await f.service.poll(record.agentId);

    const after = f.store.get(record.agentId);
    assert.equal(f.codex.sends.length, 0, 'nothing was written');
    assert.equal(after.task.taskId, 'task-next', 'the newer round is not overwritten by the stale copy');
    assert.equal(after.state, 'running');
  } finally { f.service.close(); }
});

test('an automatic tree cleanup keeps expired text, the explicit delete still removes it', async () => {
  const f = await fixture();
  try {
    const root = { ...round(), agentId: 'root-a', name: 'root' };
    const child = { ...round(), agentId: 'child-a', name: 'child', sessionId: 'session-c', parentAgentId: 'root-a',
      task: { taskId: 'task-c', message: 'child body', state: 'running', startedAt: ago(60000), dispatches: [], answers: [], reports: [] } };
    f.store.insert(root);
    f.store.insert(child, { requireOpenParent: true });
    f.store.enqueueSupplement(child, 'request-expired', 'the child text that expired', undefined);
    f.store.db.prepare("UPDATE supplements SET created=?, status='blocked', reason='dispatch-expired' WHERE requestId='request-expired'")
      .run(ago(SIX_HOURS + 60000));

    // A blocked supplement anywhere in the tree is the only copy left.
    assert.deepEqual({ ...f.store.autoCleanupHold('root-a') }, { pending: 0, blocked: 1 });
    assert.equal(f.store.claimAutoCleanup(root), false, 'the tree is kept while that text exists');
    // An explicit delete is the caller's own authorization and still works.
    f.store.remove(root);
    assert.equal(f.store.get('root-a'), undefined);
  } finally { f.service.close(); }
});
