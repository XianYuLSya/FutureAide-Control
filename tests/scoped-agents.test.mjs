import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScopedAgents, finalReminderDue } from '../src/scoped-agents.mjs';
import { FINAL_REPORT_REMINDER } from '../src/report-contract.mjs';
import { monitorSpawn } from '../src/shared-monitor.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const extra = threadId => ({ _meta: { threadId } });
// Retire the shared listener's leases whatever holder claimed them.
const stopMonitor = store => store.db.prepare('DELETE FROM leases WHERE key IN (?,?)').run('idle-monitor', 'idle-monitor:ready');

async function fixture({ startSharedMonitor, monitorFailureGraceMs, beforeSend, beforeNotice, beforeModels, captureFiles,
  callCodex: callCodexOverride } = {}) {
  const base = path.join(workspace, 'clean', 'scoped-tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'run-'));
  const store = new RosterStore(':memory:');
  const sessions = new Map();
  const sends = [], notices = [], removed = [], workers = [], reads = [], cancellations = [], beginnings = [], historyRequests = [];
  let offline = false, notificationMode = 'ok', statusCalls = 0, catalogCalls = 0, cursorCalls = 0;
  let defaultModel = { provider: 'fixture', model: 'test' };
  let catalogOverride;
  const selections = [];
  const api = {
    async connectionIdentity() { if (offline) throw new Error('DSH offline'); return { application: 'dsh', dataRoot: path.join(stateDirectory, 'native') }; },
    async hostStatus() { return { treeProtocol: 1, reportProtocol: 1, methods: ['managedCreate', 'managedBeginTask', 'managedStatus', 'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy'] }; },
    async managedCreate(input) {
      if (!sessions.has(input.sessionId)) sessions.set(input.sessionId, { ...input, model: { provider: 'fixture', model: 'test' }, running: false, seq: 0, questions: [], changes: [], turns: new Map() });
      return { ...sessions.get(input.sessionId), modelRequestsStarted: 0 };
    },
    async managedBeginTask(input) {
      assert.equal(input.treeProtocol, 1); assert.equal(input.reportProtocol, 1);
      beginnings.push(input);
      const s = sessions.get(input.sessionId);
      if (s.taskId !== input.taskId) Object.assign(s, { taskId: input.taskId, questions: [], changes: [], cancelled: false });
      return { taskId: s.taskId, treeProtocol: 1, reportProtocol: 1, currentModel: s.model, throughSeq: s.seq };
    },
    async managedStatus(input) {
      assert.equal(input.treeProtocol, 1); assert.equal(input.reportProtocol, 1);
      statusCalls++;
      const s = sessions.get(input.sessionId);
      return { sessionId: s.sessionId, taskId: s.taskId, currentModel: s.model, running: s.running, questions: s.questions, reportProtocol: 1, reports: s.reports ?? [],
        changes: s.changes, coverage: 'files written by this agent', activity: s.running ? 'writing' : 'idle', throughSeq: s.seq,
        tree: { settled: !s.running, running: s.running,
          nodes: [{ sessionId: s.sessionId, parentSessionId: null, name: 'native root', status: s.running ? 'running' : 'idle',
            activity: s.running ? 'writing' : 'idle', changes: s.changes, coverage: 'root writes' }, ...(s.descendants ?? [])], ...s.tree } };
    },
    async historyCursor(sessionId) { cursorCalls++; return { throughSeq: sessions.get(sessionId).seq }; },
    async managedSession(input) { const s = sessions.get(input.sessionId); return {
      projections: { asOfSeq: s.seq, values: { modelSelection: { next: s.model } } } }; },
    async readSession(sessionId) {
      reads.push(sessionId);
      const s = sessions.get(sessionId), events = [];
      for (const [requestId, turn] of s.turns) {
        events.push({ seq: turn.afterSeq, type: 'turn/start', data: { turn: requestId } },
          { seq: turn.afterSeq + 1, type: 'user/message', data: { role: 'user', source: { rpcId: requestId }, content: [] } });
        for (const message of turn.messages ?? []) events.push({ seq: message.seq, type: 'assistant/message',
          data: { role: 'assistant', content: [{ type: 'text', text: message.text }] } });
        if (turn.state === 'ended') events.push({ seq: turn.endSeq, type: 'turn/end', data: { turn: requestId, reason: turn.completionReason } });
      }
      return { records: events.map(event => ({ type: 'event', event })), hasMore: false };
    },
    async managedAnswer(input) {
      const s = sessions.get(input.sessionId);
      s.answers ??= new Map();
      if (s.answers.has(input.answerId)) return s.answers.get(input.answerId);
      const pending = s.questions.filter(question => question.state === 'pending');
      pending.forEach(question => { question.state = 'answered'; });
      const result = { consumedQuestionIds: pending.map(question => question.id), continuation: `Answer: ${input.message}` };
      s.answers.set(input.answerId, result);
      return result;
    },
    async managedCancel(input) {
      cancellations.push(input);
      const s = sessions.get(input.sessionId); s.running = false;
      s.questions.forEach(question => { question.state = 'cancelled'; });
      return { cancelled: true, cancelRequested: true };
    },
    async managedDestroy(input) { assert.equal(input.treeProtocol, 1); assert.equal(input.reportProtocol, 1); sessions.delete(input.sessionId); removed.push(input.sessionId); return { destroyed: true }; },
  };
  // Shared native event fixture; managedHistory does not use the ordinary API
  // method, which a running descendant is allowed to reject as agent-busy.
  const nativeHistory = api.readSession;
  api.managedHistory = async input => {
    assert.equal(input.treeProtocol, 1); assert.equal(input.reportProtocol, 1);
    historyRequests.push(input);
    const page = await nativeHistory(input.targetSessionId);
    return { events: page.records.map(record => record.event) };
  };
  const controlFactory = () => ({
    async models() {
      catalogCalls++;
      if (beforeModels) await beforeModels();
      return catalogOverride ?? { default: { ...defaultModel }, routableProviders: [defaultModel.provider],
        groups: [{ id: defaultModel.provider, models: [{ id: defaultModel.model, reasoningEfforts: ['off', 'high', 'max'] }] }] };
    },
    async selectModel(input) {
      selections.push(input);
      sessions.get(input.sessionId).model = Object.fromEntries(['provider', 'model', 'reasoningEffort']
        .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
      return { accepted: true };
    },
    async send(input) {
      if (beforeSend) await beforeSend(input);
      const s = sessions.get(input.sessionId);
      const afterSeq = s.seq;
      s.running = true; s.seq += 1;
      s.turns.set(input.requestId, { afterSeq, state: 'running' });
      sends.push(input);
      return { accepted: true, afterSeq };
    },
    async wait(input) {
      const s = sessions.get(input.sessionId);
      const turn = s.turns.get(input.requestId);
      return { ...turn, messages: turn.messages?.map(message => ({ ...message, text: message.text.slice(0, 8000), textTruncated: message.text.length > 8000 })), afterSeq: input.afterSeq ?? turn?.afterSeq,
        correlation: 'request-id', sessionId: s.sessionId };
    },
    async read() { return { messages: [] }; },
  });
  const callCodex = async (threadId, tool, args) => {
    if (tool === 'read_thread') return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace },
      turns: args.includeOutputs ? notices.filter(notice => notice.threadId === threadId) : [] };
    if (beforeNotice) await beforeNotice();
    if (notificationMode === 'native-rejected') { notices.push({ threadId, prompt: args.prompt }); return { isError: true, content: [{ type: 'text', text: 'direct app-server input is not allowed for multi-agent v2 sub-agents' }] }; }
    if (notificationMode === 'reject') return { isError: true };
    notices.push({ threadId, prompt: args.prompt });
    if (notificationMode === 'unknown') throw new Error('Lost delivery acknowledgement');
    return { accepted: true };
  };
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json') }, {
    store, clientFactory: () => api, controlFactory, callCodex: callCodexOverride ?? callCodex,
    // The fixture monitor announces itself exactly like the real worker does.
    startSharedMonitor: startSharedMonitor ?? ((...args) => {
      if (store.lease('idle-monitor')?.expires > Date.now()) return true;
      workers.push(args);
      store.claimLease('idle-monitor', 'fixture-monitor', 60000);
      store.claimLease('idle-monitor:ready', 'fixture-monitor', 60000);
      return true;
    }),
    ...(captureFiles ? { captureFiles } : {}),
    ...(monitorFailureGraceMs !== undefined ? { monitorFailureGraceMs } : {}), removeTree: async directory => { removed.push(directory); },
  });
  const record = (name = 'artist', thread = A) => store.named(ownerIdFor(thread), name);
  function finish(name = 'artist', reply = '完成', thread = A) {
    const r = record(name, thread), s = sessions.get(r.sessionId);
    s.running = false; s.seq += 2;
    for (const [id, turn] of s.turns) if (turn.state !== 'ended') s.turns.set(id, { ...turn, state: 'ended', endSeq: s.seq,
      completionReason: { kind: 'completed' }, messages: [{ seq: s.seq - 1, role: 'assistant', text: reply }] });
  }
  function report(message = '完成', final = true, name = 'artist') {
    const r = record(name), session = sessions.get(r.sessionId);
    session.reports ??= [];
    session.reports.push({ id: 'explicit-' + session.reports.length, taskId: r.task.taskId, message, final, createdAt: new Date().toISOString() });
  }
  // A turn that ends without a final report now earns one reminder, so a test that
  // wants the settled awaiting_report state lets that reminder turn end too.
  async function settle(name = 'artist', reply = 'done') {
    finish(name, reply);
    await service.poll(record(name).agentId);
    finish(name, reply);
    await service.poll(record(name).agentId);
  }
  return { report, service, store, sessions, api, controlFactory, sends, notices, removed, workers, reads, cancellations, beginnings, historyRequests, stateDirectory, record, finish, settle,
    offline: value => { offline = value; }, notification: value => { notificationMode = value; }, statusCalls: () => statusCalls,
    defaultModel: value => { defaultModel = value; }, catalog: value => { catalogOverride = value; },
    selections, catalogCalls: () => catalogCalls, cursorCalls: () => cursorCalls };
}

test('default model follows live host for new tasks, supplements and answers without stale roster selection', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    assert.equal(f.catalogCalls(), 0, 'empty creation does not fetch the model catalog');
    const newModel = { provider: 'new-route', model: 'new-model', reasoningEffort: 'max' };
    const record = f.record(); record.model = newModel; f.store.save(record);
    f.defaultModel(newModel);
    await f.service.send({ name: 'artist', message: 'first' }, extra(A));
    assert.equal(f.selections.length, 1, 'migrated roster does not hide the old native model');
    assert.deepEqual(f.sessions.get(record.sessionId).model, newModel);
    await f.service.send({ name: 'artist', message: 'same route' }, extra(A));
    assert.equal(f.selections.length, 1, 'unchanged actual model skips selection');
    f.defaultModel({ provider: 'fixture', model: 'test' });
    await f.service.send({ name: 'artist', message: 'switch back' }, extra(A));
    f.defaultModel(newModel);
    await f.service.send({ name: 'artist', message: 'switch again' }, extra(A));
    assert.equal(f.selections.length, 3);
    assert.equal(new Set(f.selections.map(item => item.requestId)).size, 3, 'each input owns its model receipt');
    assert.equal(f.catalogCalls(), 4);
    assert.equal(f.cursorCalls(), 0, 'begin/status observations supply the cursor');
    f.finish();
    const session = f.sessions.get(record.sessionId);
    session.questions.push({ id: 'question-model', message: 'Continue?', state: 'pending' });
    await f.service.poll(record.agentId);
    f.defaultModel({ provider: 'fixture', model: 'test' });
    await f.service.answer({ name: 'artist', message: 'yes' }, extra(A));
    await f.service.poll(record.agentId);
    assert.equal(f.selections.length, 4);
    assert.equal(f.sends.at(-1).message, 'Answer: yes');
    assert.equal(f.record().task.dispatches.at(-1).kind, 'answer');
    assert.equal(f.cursorCalls(), 0);
  } finally { f.service.close(); }
});

test('default model read failure retries the original saved dispatch before sending any prompt', async () => {
  let fail = true;
  const f = await fixture({ beforeModels: () => {
    if (fail) throw Object.assign(new Error('catalog timed out'), { retryableRead: true });
  } });
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    const receipt = await f.service.send({ name: 'artist', message: 'one task' }, extra(A));
    assert.equal(receipt.retrying, true);
    assert.equal(f.sends.length, 0);
    const original = f.record().task.dispatches[0].requestId;
    fail = false;
    await f.service.poll(f.record().agentId);
    assert.equal(f.sends.length, 1);
    assert.equal(f.sends[0].requestId, original);
    assert.equal(f.record().task.dispatches.length, 1);
  } finally { f.service.close(); }
});

test('model failure is visible in list wait and inspect, notifies once and clears on the next task', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'work' }, extra(A));
    f.finish();
    const r = f.record(), session = f.sessions.get(r.sessionId);
    Object.assign(session.turns.get(r.task.dispatches[0].requestId), { messages: [],
      completionReason: { kind: 'error', error: { code: 'SERVER',
        message: '503: {"code":"no_healthy_account","message":"private upstream detail"}' } } });
    const failed = await f.service.poll(r.agentId);
    assert.equal(failed.state, 'failed');
    assert.deepEqual(failed.error, { source: 'model', code: 'no_healthy_account', httpStatus: 503,
      message: 'The model gateway has no healthy account available.' });
    assert.deepEqual((await f.service.list(extra(A))).items[0].error, failed.error);
    assert.deepEqual((await f.service.wait({ names: ['artist'] }, extra(A))).items[0].error, failed.error);
    assert.deepEqual((await f.service.inspect({ name: 'artist' }, extra(A))).error, failed.error);
    assert.equal(f.record().error, undefined, 'successful observation does not replace model failure with a connection error');
    assert.doesNotMatch(JSON.stringify(f.record()), /private upstream/);
    assert.equal(f.notices.length, 1, 'a confirmed model failure notifies the parent once');
    assert.match(f.notices[0].prompt, /执行失败/);
    assert.match(f.notices[0].prompt, /no_healthy_account/, 'the notice names the failure, not only that it failed');
    assert.match(f.notices[0].prompt, /artist/);
    assert.equal(f.sends.length, 1);
    assert.equal(f.removed.length, 0);

    await f.service.send({ name: 'artist', message: 'new task' }, extra(A));
    assert.notEqual(f.record().task.taskId, r.task.taskId);
    assert.equal((await f.service.list(extra(A))).items[0].error, undefined);
    assert.deepEqual(f.store.historyFor(f.record().agentId)[0].dispatches[0].failure, failed.error);
    f.finish();
    const reminded = await f.service.poll(r.agentId);
    assert.equal(reminded.state, 'running', 'a turn that ends without a final is reminded once');
    f.finish();
    const completed = await f.service.poll(r.agentId);
    assert.equal(completed.state, 'awaiting_report');
    assert.equal(completed.error, undefined);
  } finally { f.service.close(); }
});

test('model failure backfill uses only the inspected original request and does not read history again', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'old task' }, extra(A));
    f.finish();
    const r = f.record(), session = f.sessions.get(r.sessionId);
    Object.assign(session.turns.get(r.task.dispatches[0].requestId), { messages: [],
      completionReason: { kind: 'error', error: { code: 'SERVER', message: '503: {"code":"no_healthy_account"}' } } });
    r.state = r.task.state = r.task.dispatches[0].state = 'failed';
    f.store.save(r);
    const inspection = await f.service.inspect({ name: 'artist' }, extra(A));
    assert.equal(inspection.error.code, 'no_healthy_account');
    assert.equal(f.historyRequests.length, 1);
    assert.equal(f.reads.length, 1);
    assert.deepEqual((await f.service.list(extra(A))).items[0].error, inspection.error);

    await f.service.send({ name: 'artist', message: 'new task' }, extra(A));
    const next = f.record();
    next.state = next.task.state = next.task.dispatches[0].state = 'failed';
    f.store.save(next);
    const unmatched = await f.service.inspect({ name: 'artist' }, extra(A));
    assert.equal(unmatched.error, undefined, 'an older failed turn cannot supply the new request error');
    assert.equal(f.historyRequests.length, 2);
    assert.equal(f.reads.length, 2);
    assert.equal(f.notices.length, 0);
    assert.equal(f.sends.length, 2);
  } finally { f.service.close(); }
});

test('a proven pre-write read failure resumes the original dispatch; historical failed intents remain stopped', async () => {
  let attempts = 0;
  const f = await fixture({ beforeSend: async () => {
    attempts++;
    if (attempts === 1) throw Object.assign(new Error('read timed out'), { code: 'timeout', uncertain: false, retryableRead: true });
  } });
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  const first = await f.service.send({ name: 'artist', message: 'work' }, extra(A));
  assert.equal(first.accepted, false);
  assert.equal(first.retrying, true);
  const prior = f.record();
  assert.equal(prior.task.dispatches[0].state, 'retrying');
  await f.service.poll(prior.agentId);
  assert.equal(f.record().task.taskId, prior.task.taskId);
  assert.equal(f.record().task.dispatches[0].requestId, prior.task.dispatches[0].requestId);
  assert.equal(f.record().task.dispatches[0].accepted, true);
  assert.equal(f.record().task.dispatches[0].error, undefined);
  assert.equal(attempts, 2);
  const saved = f.record(); saved.task.dispatches[0].accepted = false; saved.task.dispatches[0].state = 'failed';
  f.store.save(saved);
  await f.service.poll(saved.agentId);
  assert.equal(attempts, 2);
  f.store.close();
});

test('a dispatch never waits for the workspace snapshot, even when the capture never returns', async () => {
  const f = await fixture({ captureFiles: () => new Promise(() => {}) });
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    let timer;
    const watchdog = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('the dispatch waited for the snapshot')), 5000);
      timer.unref();
    });
    const sent = await Promise.race([f.service.send({ name: 'artist', message: 'work' }, extra(A)), watchdog])
      .finally(() => clearTimeout(timer));
    assert.equal(sent.accepted, true, 'the task was dispatched while the snapshot was still running');
    assert.equal(f.sends.length, 1);
    assert.equal(f.record().task.message, 'work');
  } finally { f.service.close(); }
});

test('settled awaiting-report monitor sleeps and a supplement wakes the same task', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  await f.settle();
  const before = f.record();
  assert.equal(before.state, 'awaiting_report');
  f.store.claimLease('idle-monitor', 'monitor', 60000); f.store.claimLease('idle-monitor:ready', 'monitor', 60000);
  assert.equal(await f.service.trySleep(before.agentId), true);
  assert.equal((await f.service.list(extra(A))).items[0].monitor, 'sleeping');
  const count = f.workers.length;
  await f.service.send({ name: 'artist', message: 'continue' }, extra(A));
  assert.equal(f.record().sleep, undefined, 'a live monitor wakes the same task without another process');
  assert.equal(f.workers.length, count, 'the one shared listener absorbed the wake');
  assert.equal(f.record().task.taskId, before.task.taskId);
  f.service.close();
});

test('a wake after the monitor retires is recovered by restarting one listener', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  await f.settle();
  const before = f.record();
  f.store.claimLease('idle-monitor', 'monitor', 60000); f.store.claimLease('idle-monitor:ready', 'monitor', 60000);
  assert.equal(await f.service.trySleep(before.agentId), true);
  stopMonitor(f.store);
  const count = f.workers.length;
  assert.equal(await f.service.wake(before.agentId, before.task.taskId), true);
  assert.equal(f.workers.length, count + 1, 'exactly one listener is restarted for the pending wake');
  assert.equal(f.record().sleep, undefined);
  assert.equal(f.record().task.taskId, before.task.taskId);
  f.service.close();
});

test('a sleeping name is never polled twice and keeps the same task across a monitor restart', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  await f.settle();
  const before = f.record();
  f.store.claimLease('idle-monitor', 'monitor', 60000); f.store.claimLease('idle-monitor:ready', 'monitor', 60000);
  assert.equal(await f.service.trySleep(before.agentId), true);
  assert.equal(await f.service.monitorScan().catch(() => undefined), false, 'a sleeping name is not polled');
  stopMonitor(f.store);
  const count = f.workers.length;
  await f.service.wake(before.agentId, before.task.taskId);
  assert.equal(f.workers.length, count + 1);
  assert.equal(f.record().sleep, undefined);
  assert.equal(f.record().task.taskId, before.task.taskId);
  assert.equal(f.sends.filter(send => send.message === 'initial').length, 1, 'the original dispatch was never repeated');
  assert.equal(f.sends.length, 2, 'the task and its one reminder, nothing more');
  f.service.close();
});

test('a stale sleep marker from an older client wakes the newer task in the same session', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  await f.settle();
  const before = f.record();
  f.store.claimLease('idle-monitor', 'monitor', 60000); f.store.claimLease('idle-monitor:ready', 'monitor', 60000);
  assert.equal(await f.service.trySleep(before.agentId), true);
  const oldClient = f.record(); oldClient.task.taskId = 'task-new'; oldClient.state = 'running'; f.store.save(oldClient);
  stopMonitor(f.store);
  const count = f.workers.length;
  assert.equal(await f.service.wake(before.agentId, before.task.taskId), true);
  assert.equal(f.workers.length, count + 1);
  assert.equal(f.record().task.taskId, 'task-new');
  assert.equal(f.record().sleep, undefined);
  f.service.close();
});

test('a lost shared monitor keeps the task durable and sweeps in process instead of spawning', async () => {
  let ready = true;
  const f = await fixture({ startSharedMonitor: async () => ready, monitorFailureGraceMs: 0 });
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  await f.settle();
  const before = f.record();
  f.store.claimLease('idle-monitor', 'monitor', 60000); f.store.claimLease('idle-monitor:ready', 'monitor', 60000);
  assert.equal(await f.service.trySleep(before.agentId), true);
  stopMonitor(f.store);
  ready = false;
  const count = f.workers.length;
  assert.equal(await f.service.ensureIdleMonitor(), true, 'the degraded sweep runs in this process');
  assert.equal(f.workers.length, count, 'no process is spawned per name');
  assert.equal(f.record().sleep.taskId, before.task.taskId, 'the sleeping baseline is kept for a later attempt');
  await f.service.wake(before.agentId, before.task.taskId);
  assert.equal(f.record().error.code, 'monitor-unavailable');
  assert.equal(f.record().sleep.taskId, before.task.taskId);
  f.service.close();
});

test('a failed wake spawn retains the sleeping baseline for another attempt', async () => {
  let fail = false;
  const f = await fixture({ startSharedMonitor: async () => { if (fail) throw new Error('spawn failed'); return true; } });
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  await f.settle();
  const before = f.record();
  f.store.claimLease('idle-monitor', 'monitor', 60000); f.store.claimLease('idle-monitor:ready', 'monitor', 60000);
  assert.equal(await f.service.trySleep(before.agentId), true);
  stopMonitor(f.store); fail = true;
  await f.service.wake(before.agentId, before.task.taskId);
  assert.equal(f.record().sleep.taskId, before.task.taskId);
  assert.equal(f.record().error.code, 'operation-failed', 'the spawn failure is recorded, not swallowed');
  assert.equal(f.record().error.message, 'spawn failed');
  f.service.close();
});

test('asynchronous monitor spawn errors retain the task without crashing MCP', async () => {
  let attempts = 0;
  const spawnProcess = () => {
    attempts++;
    const child = new EventEmitter();
    child.unref = () => assert.fail('a failed monitor must not be detached');
    setImmediate(() => child.emit('error', Object.assign(new Error('monitor spawn denied'), { code: 'EACCES' })));
    return child;
  };
  const f = await fixture({ startSharedMonitor: () => monitorSpawn('D:/fixture.json', 'monitor-00000000-0000-4000-8000-000000000000', spawnProcess) });
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    const result = await f.service.send({ name: 'artist', message: 'Retain this task' }, extra(A));
    assert.equal(result.state, 'running');
    assert.equal(result.error.code, 'EACCES');
    assert.equal(f.record().task.message, 'Retain this task');
    assert.equal(f.sends.length, 1);
    await f.service.resume();
    assert.equal(attempts, 2, 'a failed spawn releases its lease for the next attempt');
    assert.equal((await f.service.status(extra(A))).ready, true, 'the service still answers requests');
  } finally { f.service.close(); }

  const child = new EventEmitter();
  child.pid = 99999;
  let detached = false, confirmed = false;
  child.unref = () => { detached = true; };
  const started = monitorSpawn('D:/fixture.json', 'monitor-00000000-0000-4000-8000-000000000000', () => child).then(pid => { confirmed = true; return pid; });
  await Promise.resolve();
  assert.equal(confirmed, false, 'a PID alone does not confirm a successful spawn');
  child.emit('spawn');
  assert.equal(await started, 99999);
  assert.equal(detached, true);
});

test('a delayed monitor spawn failure cannot overwrite concurrent task state or a newer error', async () => {
  // One name per state: a record that has been persisted as `cleaning` can never be
  // moved out of it again (RosterStore.save keeps it cleaning and closed), so the
  // concurrent state under test has to start from a record that is not already
  // closed. Delaying the spawn rejection is what makes the race real.
  const pendingSpawn = () => {
    let reject;
    const promise = new Promise((_resolve, fail) => { reject = fail; });
    return { promise, fail: error => reject(error) };
  };
  for (const state of ['delivery_pending', 'cleaning']) {
    const spawn = pendingSpawn();
    const f = await fixture({ startSharedMonitor: () => spawn.promise });
    try {
      await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
      const initial = f.record(); initial.state = 'running'; f.store.save(initial);
      const resumed = f.service.resume();
      const fresh = f.record(); fresh.state = state;
      fresh.task = { message: `Concurrent ${state}`, result: { reply: 'New result' }, dispatches: [] };
      f.store.save(fresh);
      spawn.fail(Object.assign(new Error('delayed failure'), { code: 'EACCES' }));
      await resumed;
      assert.equal(f.record().state, state, 'the concurrent state survives the late failure');
      assert.equal(f.record().task.result.reply, 'New result');
      assert.equal(f.record().error.code, 'EACCES');
    } finally { f.service.close(); }
  }

  const spawn = pendingSpawn();
  const f = await fixture({ startSharedMonitor: () => spawn.promise });
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    const initial = f.record(); initial.state = 'running'; f.store.save(initial);
    const resumed = f.service.resume();
    const fresh = f.record(); fresh.error = { code: 'new-owner' }; f.store.save(fresh);
    spawn.fail(new Error('old launcher failure'));
    await resumed;
    assert.equal(f.record().error.code, 'new-owner', 'a late failure never masks a newer recorded error');
    assert.equal(f.record().state, 'running', 'the failure writes only its own error field');
    f.store.setError('removed-agent', { code: 'EACCES' });
  } finally { f.service.close(); }
});

test('names and all operations are scoped by native chat metadata; create uses no model turn', async () => {
  const f = await fixture();
  await assert.rejects(f.service.create({ name: 'artist', lifetime: 'persistent' }, {}), /calling chat identity/);
  for (const thread of [A, B]) {
    const value = await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(thread));
    assert.equal(value.modelRequestsStarted, 0);
  }
  assert.equal(f.sends.length, 0);
  assert.notEqual(f.record('artist', A).sessionId, f.record('artist', B).sessionId);
  assert.equal((await f.service.list(extra(A))).items.length, 1);
  await f.service.delete({ name: 'artist' }, extra(A));
  assert.equal((await f.service.list(extra(A))).items.length, 0);
  assert.equal((await f.service.list(extra(B))).items.length, 1);
  assert.deepEqual((await f.service.wait({ names: ['artist'], timeoutSeconds: 0 }, extra(A))).notListed, ['artist']);
  f.service.close();
});

test('run creates a missing name and sends its task in one call', async () => {
  const f = await fixture();
  try {
    const result = await f.service.run({ message: 'draw the diagram' }, extra(A));
    assert.match(result.name, /^助手-[0-9a-f]{4}$/, 'an unnamed run gets a generated name');
    assert.equal(result.created, true);
    assert.equal(result.reused, undefined);
    assert.equal(result.lifetime, 'once');
    assert.equal(result.accepted, true);
    assert.equal(result.state, 'running');
    assert.equal('target' in result, false, 'dsh is the default and is not restated');
    assert.equal(f.record(result.name).task.message, 'draw the diagram');
    assert.equal(f.sends.length, 1, 'one call, one dispatch');
  } finally { f.service.close(); }
});

test('run continues an existing name instead of creating a second one', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    const result = await f.service.run({ name: 'artist', message: 'second task', lifetime: 'persistent', target: 'dsh' }, extra(A));
    assert.equal(result.reused, true);
    assert.equal(result.created, undefined, 'an existing name is never reported as created: false');
    assert.equal(result.lifetime, 'persistent');
    assert.equal(result.accepted, true);
    assert.equal(f.record('artist').task.message, 'second task');
    assert.equal(f.sends.length, 1);
  } finally { f.service.close(); }
});

test('run refuses a target or lifetime that differs from the existing name', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await assert.rejects(f.service.run({ name: 'artist', message: 'x', target: 'codex-desktop' }, extra(A)),
      /already bound to DSH/, 'the refusal names the application this name belongs to');
    await assert.rejects(f.service.run({ name: 'artist', message: 'x', lifetime: 'once' }, extra(A)),
      /already a persistent subagent/);
    assert.equal(f.sends.length, 0, 'nothing was sent to the wrong binding');
    assert.equal(f.record('artist').task, undefined);
  } finally { f.service.close(); }
});

test('run returns a failed creation as-is and never sends into it', async () => {
  const f = await fixture();
  try {
    f.offline(true);
    const result = await f.service.run({ name: 'newcomer', message: 'x' }, extra(A));
    assert.equal(result.created, false);
    assert.ok(result.error, 'the creation failure keeps its own error');
    assert.equal(f.sends.length, 0, 'a name that never connected receives nothing');
    assert.equal(result.name, 'newcomer');
  } finally { f.service.close(); }
});

test('run keeps a created name when the first send throws', async () => {
  const f = await fixture();
  const hostStatus = f.api.hostStatus;
  let probes = 0;
  // Creation probes the host once; the send that follows fails its own probe.
  f.api.hostStatus = async () => { probes += 1;
    if (probes > 1) throw Object.assign(new Error('The DSH host probe failed.'), { code: 'host-probe-failed' });
    return hostStatus(); };
  try {
    const result = await f.service.run({ message: 'x' }, extra(A));
    assert.equal(result.created, true);
    assert.equal(result.accepted, false);
    assert.equal(result.error.code, 'host-probe-failed');
    assert.match(result.name, /^助手-[0-9a-f]{4}$/, 'the generated name is handed back, not lost');
    assert.ok(f.record(result.name), 'the created name stays in this chat’s list');
    assert.equal(f.sends.length, 0);
  } finally { f.service.close(); }
});

test('list reports an exact unconfirmed total although it lists only twelve paths', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'sweep' }, extra(A));
    const record = f.record();
    f.sessions.get(record.sessionId).changes = Array.from({ length: 20 }, (unused, index) => ({
      path: `file-${index}.mjs`, operation: 'update', ...(index < 5 ? { attribution: 'unconfirmed' } : {}) }));
    await f.service.poll(record.agentId);
    const listed = (await f.service.list(extra(A))).items[0];
    assert.equal(listed.changes.count, 20);
    assert.equal(listed.changes.files.length, 12, 'the answer still lists twelve file summaries');
    assert.equal(listed.changes.unconfirmed, 5, 'the unconfirmed total is counted over all 20 paths');
  } finally { f.service.close(); }
});

test('a clipped workspace comparison is reported as truncated coverage', async () => {
  let captures = 0;
  // The baseline is empty; the comparison then finds more paths than one answer may list.
  const captureFiles = async () => {
    captures += 1;
    const files = captures === 1 ? {}
      : Object.fromEntries(Array.from({ length: 210 }, (unused, index) => [`file-${index}.mjs`, { code: ' M', stamp: '1' }]));
    return { available: true, workspace: '/workspace', files };
  };
  const f = await fixture({ captureFiles });
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'sweep' }, extra(A));
    const snapshot = await f.service.changes({ name: 'artist' }, extra(A));
    assert.equal(snapshot.changes.length, 200, 'the comparison is still clipped for the answer');
    assert.equal(snapshot.coverage.workspace.truncated, true, 'and the clipping is stated in coverage');
    assert.ok(snapshot.changes.every(change => change.attribution === 'unconfirmed'));
  } finally { f.service.close(); }
});

test('run names a closing name instead of guessing what send meant', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    f.store.save({ ...f.record(), state: 'cleaning', closed: true });
    await assert.rejects(f.service.run({ name: 'artist', message: 'x' }, extra(A)),
      error => error.code === 'name-closing' && /leaves list/.test(error.message));
    assert.equal(f.sends.length, 0, 'a name on its way out receives nothing');
  } finally { f.service.close(); }
});

test('one-shot asks directly, resumes once, and clears only after confirmed result delivery', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: '画图\n“中文”' }, extra(A));
  const r = f.record(), s = f.sessions.get(r.sessionId);
  s.questions = [{ id: 'question-1', message: '使用什么颜色？', state: 'pending' }];
  f.finish('artist', '等待回答');
  await f.service.poll(r.agentId);
  assert.equal(f.record().state, 'awaiting_input');
  assert.equal(f.removed.length, 0);
  await f.service.answer({ name: 'artist', message: '蓝色' }, extra(A));
  await f.service.poll(r.agentId);
  assert.equal(f.sends.length, 2);
  await f.service.poll(r.agentId);
  assert.equal(f.sends.length, 2);
  s.changes = [{ path: 'art.svg', operation: 'create' }];
  f.finish('artist', '已画好 art.svg'); f.report('已画好 art.svg');
  await f.service.poll(r.agentId);
  assert.equal(f.record(), undefined);
  assert.equal(f.removed[0], r.sessionId);
  assert.match(f.notices.at(-1).prompt, /已画好 art.svg/);
  assert.match(f.notices.at(-1).prompt, /art.svg/);
  f.service.close();
});

test('persistent agents reuse one session and retain earlier task changes', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  const id = f.record().sessionId;
  await f.service.send({ name: 'artist', message: 'first' }, extra(A));
  f.sessions.get(id).changes = [{ path: 'first.svg', operation: 'write' }];
  f.finish(); f.report(); await f.service.poll(f.record().agentId);
  assert.equal(f.record().state, 'idle');
  await f.service.send({ name: 'artist', message: 'second' }, extra(A));
  assert.equal(f.record().sessionId, id);
  assert.deepEqual((await f.service.changes({ name: 'artist', task: 1 }, extra(A))).changes, [{ path: 'first.svg', operation: 'write', agentPath: ['artist'] }]);
  assert.equal(f.removed.length, 0);
  f.service.close();
});

test('cached results can return while DSH is offline; ambiguous delivery is read back without resending', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.report(); f.notification('unknown');
  await f.service.poll(f.record().agentId);
  const r = f.record();
  assert.equal(r.task.reports[0].delivery.state, 'unknown');
  r.task.reports[0].delivery.nextAttemptAt = 0; f.store.save(r);
  const observed = f.statusCalls();
  f.offline(true);
  await f.service.poll(r.agentId);
  assert.equal(f.record().state, 'idle');
  assert.equal(f.statusCalls(), observed);
  assert.equal(f.notices.length, 1);
  f.service.close();
});

test('an unconfirmed notice blocks at thirty minutes and a once name is retained', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.report('keep this body', true); f.notification('unknown');
  await f.service.poll(f.record().agentId);
  const r = f.record();
  const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
  Object.assign(r.task.reports[0].delivery, { attemptedAt: old, nextAttemptAt: 0 });
  f.store.save(r);
  await f.service.poll(r.agentId);
  const kept = f.record('artist');
  assert.notEqual(kept, undefined, 'a blocked one-shot name stays listed');
  assert.equal(kept.state, 'idle');
  assert.equal(kept.task.reports[0].delivery.state, 'blocked');
  assert.equal(kept.task.reports[0].message, 'keep this body');
  assert.equal(f.removed.length, 0);
  f.service.close();
});

test('a final that waited over thirty minutes for its tree is still sent once the tree settles', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  // The helper reports its final while its own turn keeps running (it went on to
  // work through follow-up messages), so the final waits for the tree.
  f.report('final body', true); f.notification('ok');
  await f.service.poll(f.record().agentId);
  const r = f.record();
  assert.equal(r.state, 'running', 'the final waits for the tree');
  const final = r.task.reports.find(report => report.final);
  assert.equal(final.delivery.attemptedAt, undefined, 'nothing was sent yet');
  const old = new Date(Date.now() - 45 * 60 * 1000).toISOString();
  final.createdAt = old;
  final.delivery.createdAt = old;
  f.store.save(r);
  f.finish();
  await f.service.poll(r.agentId);
  const done = f.record();
  assert.equal(done.task.reports.find(report => report.final).delivery.state, 'delivered',
    'a final nobody tried to send is sent, not blocked as unconfirmed');
  assert.equal(done.state, 'idle');
  assert.equal(f.notices.length, 1);
  f.service.close();
});

test('a pending notice older than six hours expires without reaching the chat', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.report('keep this body', true); f.notification('reject');
  await f.service.poll(f.record().agentId);
  const r = f.record();
  assert.equal(r.state, 'delivery_pending');
  const old = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
  Object.assign(r.task.reports[0], { createdAt: old });
  Object.assign(r.task.reports[0].delivery, { createdAt: old, attemptedAt: old, nextAttemptAt: 0 });
  f.store.save(r);
  await f.service.poll(r.agentId);
  const expired = f.record();
  assert.equal(expired.state, 'idle');
  assert.equal(expired.task.reports[0].delivery.state, 'blocked');
  assert.equal(expired.task.reports[0].delivery.error.reason, 'expired');
  assert.equal(expired.task.reports[0].message, 'keep this body', 'the body is retained');
  const listed = (await f.service.list(extra(A))).items[0];
  assert.equal(listed.reports.latest.error.reason, 'expired');
  assert.equal(f.notices.length, 0, 'nothing was sent to the chat');
  f.service.close();
});

test('a missing owner thread blocks the notice with the profile reason', async () => {
  let gone = false;
  const missing = Object.assign(new Error('thread not loaded'), { code: 'codex-thread-not-found', terminal: true });
  const callCodex = async (threadId, tool) => {
    if (tool === 'read_thread') {
      if (gone) throw missing;
      return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } };
    }
    return { accepted: true };
  };
  const f = await fixture({ callCodex });
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.report('keep this body', true); gone = true;
  await f.service.poll(f.record().agentId);
  const record = f.record();
  assert.equal(record.task.reports[0].delivery.state, 'blocked');
  assert.equal(record.task.reports[0].delivery.error.code, 'codex-thread-not-found');
  assert.equal(record.task.reports[0].message, 'keep this body');
  f.service.close();
});

test('a legacy notice without a creation time is expired, never sent', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.report('legacy body', true); f.notification('reject');
  await f.service.poll(f.record().agentId);
  const r = f.record();
  delete r.task.reports[0].createdAt;
  delete r.task.reports[0].delivery.createdAt;
  delete r.task.startedAt;
  f.store.save(r);
  await f.service.poll(r.agentId);
  const expired = f.record();
  assert.equal(expired.task.reports[0].delivery.state, 'blocked');
  assert.equal(expired.task.reports[0].delivery.error.reason, 'expired');
  assert.equal(expired.task.reports[0].message, 'legacy body');
  assert.equal(f.notices.length, 0);
  f.service.close();
});

test('an older unknown notice does not hold back the final report', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.report('progress', false); f.notification('unknown');
  await f.service.poll(f.record().agentId);
  assert.equal(f.record().task.reports[0].delivery.state, 'unknown');
  f.report('final body', true); f.finish(); f.notification('ok');
  const done = await f.service.poll(f.record().agentId);
  assert.equal(done.state, 'idle');
  assert.equal(f.record().task.reports.at(-1).delivery.state, 'delivered');
  assert.equal(f.record().task.reports[0].delivery.state, 'unknown');
  f.service.close();
});

test('failed return does not clear a one-shot session', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.finish(); f.report(); f.notification('reject');
  await f.service.poll(f.record().agentId);
  assert.equal(f.record().state, 'delivery_pending');
  assert.equal(f.removed.length, 0);
  f.service.close();
});

test('native v2 callback rejection is visible, never retried, and preserves the report and recipient', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  f.notification('native-rejected'); f.report('keep this', false);
  await f.service.poll(f.record().agentId);
  await f.service.poll(f.record().agentId);
  assert.equal(f.notices.length, 1);
  assert.equal(f.notices[0].threadId, A);
  assert.equal(f.record().task.reports[0].message, 'keep this');
  assert.equal(f.record().task.reports[0].delivery.state, 'blocked');
  assert.equal((await f.service.list(extra(A))).items[0].callbackError.code, 'native-callback-unavailable');
  assert.equal(f.removed.length, 0);
  f.service.close();
});

test('cancel closes questions without automatic notice or one-shot cleanup', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const r = f.record();
  f.sessions.get(r.sessionId).questions = [{ id: 'q', message: 'question', state: 'pending' }];
  await f.service.cancel({ name: 'artist' }, extra(A));
  await f.service.poll(r.agentId);
  assert.equal(f.record().state, 'cancelled');
  assert.equal(f.notices.length, 0);
  assert.equal(f.removed.length, 0);
  f.service.close();
});

test('cancel bypasses the held operation lock and survives an older snapshot', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const old = f.record(), taskId = old.task.taskId;
  let release; const held = f.store.locked(old.agentId, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  const result = await f.service.cancel({ name: 'artist' }, extra(A));
  assert.equal(result.accepted, true);
  assert.equal(f.cancellations[0].taskId, taskId);
  f.store.save(old);
  assert.equal(f.record().task.cancelRequested, true);
  assert.equal(f.record().task.cancelAccepted, true);
  assert.equal(f.record().task.taskId, taskId);
  assert.equal(f.removed.length, 0);
  release(); await held; f.service.close();
});

test('cancellation and automatic cleanup are decided atomically for the same task', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const record = f.record();
  assert.equal(f.store.requestCancel(record), true);
  assert.equal(f.store.claimAutoCleanup(record), false);
  await f.service.poll(record.agentId);
  assert.equal(f.cancellations.length, 1);
  assert.equal(f.record().task.cancelVerified, true);
  assert.equal(f.removed.length, 0);
  f.service.close();
  const g = await fixture();
  await g.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await g.service.send({ name: 'artist', message: 'task' }, extra(A));
  const other = g.record();
  assert.equal(g.store.claimAutoCleanup(other), true);
  assert.equal(g.store.requestCancel(other), false);
  assert.equal((await g.service.cancel({ name: 'artist' }, extra(A))).accepted, false);
  assert.equal(g.cancellations.length, 0);
  g.service.close();
});

test('cancel intent cannot attach to a replacement task', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const old = f.record(), newer = f.record();
  newer.task.taskId = 'task-replacement'; f.store.save(newer);
  assert.equal(f.store.requestCancel(old), false);
  assert.notEqual(f.record().task.cancelRequested, true);
  assert.equal(f.cancellations.length, 0);
  f.service.close();
});

test('a send already in flight is stopped again after it returns', async () => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ beforeSend: async () => { entered(); await gate; } });
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  const sending = f.service.send({ name: 'artist', message: 'task' }, extra(A));
  await started;
  const cancel = await f.service.cancel({ name: 'artist' }, extra(A));
  assert.equal(cancel.accepted, true);
  assert.equal(f.cancellations.length, 1);
  release(); await sending;
  assert.equal(f.cancellations.length, 2);
  assert.equal(f.record().task.cancelVerified, true);
  assert.equal(f.sessions.get(f.record().sessionId).running, false);
  f.service.close();
});

test('final delivery cannot declare cancellation before the host stop and tree recheck', async () => {
  let releaseNotice, noticeEntered, releaseStop, stopEntered;
  const noticeStarted = new Promise(resolve => { noticeEntered = resolve; });
  const noticeGate = new Promise(resolve => { releaseNotice = resolve; });
  const stopStarted = new Promise(resolve => { stopEntered = resolve; });
  const stopGate = new Promise(resolve => { releaseStop = resolve; });
  const f = await fixture({ beforeNotice: async () => { noticeEntered(); await noticeGate; } });
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const originalCancel = f.api.managedCancel;
  f.api.managedCancel = async input => { stopEntered(); await stopGate; return originalCancel(input); };
  f.finish(); f.report('final', true);
  const polling = f.service.poll(f.record().agentId);
  await noticeStarted;
  const cancellation = f.service.cancel({ name: 'artist' }, extra(A));
  await stopStarted;
  releaseNotice(); await polling;
  assert.equal(f.record().state, 'running');
  assert.equal(f.record().task.cancelRequested, true);
  assert.equal(f.removed.length, 0);
  releaseStop(); await cancellation;
  await f.service.poll(f.record().agentId);
  assert.equal(f.record().state, 'cancelled');
  assert.equal(f.record().task.cancelTreeSettled, true);
  assert.equal(f.removed.length, 0);
  f.service.close();
});

test('a crash before writeOnce starts reuses the original request, without minting another task', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  const r = f.record();
  r.state = 'running';
  r.task = { taskId: 'task-existing', message: 'task', state: 'running', dispatches: [{ requestId: 'request-existing', message: 'task', state: 'sending', afterSeq: 0 }], answers: [] };
  f.sessions.get(r.sessionId).taskId = r.task.taskId; f.store.save(r);
  await f.service.poll(r.agentId);
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].requestId, 'request-existing');
  assert.equal(f.record().task.dispatches.length, 1);
  f.service.close();
});

test('accepted dispatch receipt restores a lost acknowledgement without another send', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const r = f.record(), dispatch = r.task.dispatches[0];
  const key = createHash('sha256').update(JSON.stringify(['send', r.sessionId, dispatch.requestId])).digest('hex');
  const directory = path.join(f.stateDirectory, 'scoped', r.ownerId, r.agentId, 'requests');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${key}.json`), JSON.stringify({ status: 'accepted', afterSeq: dispatch.afterSeq }));
  dispatch.accepted = false; dispatch.state = 'sending'; dispatch.afterSeq = undefined; f.store.save(r);
  f.finish(); f.report(); await f.service.poll(r.agentId);
  assert.equal(f.sends.length, 1);
  assert.equal(f.record().state, 'idle');
  f.service.close();
});

test('monitor lease expiry restarts one shared listener and list does not overwrite task state', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'task' }, extra(A));
  const r = f.record();
  assert.equal(f.workers.length, 1, 'one shared listener for the whole plugin');
  await f.service.list(extra(A)); assert.equal(f.workers.length, 1, 'listing never starts another listener');
  f.store.db.prepare('UPDATE leases SET expires=0 WHERE key IN (?,?)').run('idle-monitor', 'idle-monitor:ready');
  await f.service.list(extra(A));
  assert.equal(f.workers.length, 2);
  assert.equal(f.record().task.dispatches[0].requestId, r.task.dispatches[0].requestId);
  f.service.close();
});

test('resume and monitor health use projections instead of loading the full roster', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'task' }, extra(A));
    f.store.db.prepare('UPDATE leases SET expires=0 WHERE key IN (?,?)').run('idle-monitor', 'idle-monitor:ready');
    const before = f.workers.length;
    f.store.list = () => { throw new Error('full roster must not be loaded'); };
    await f.service.resume();
    assert.equal(f.workers.length, before + 1);
    f.store.db.prepare('UPDATE leases SET expires=0 WHERE key IN (?,?)').run('idle-monitor', 'idle-monitor:ready');
    assert.equal(await f.service.ensureIdleMonitor(), true);
    assert.equal((await f.service.status(extra(A))).agents, 1);
  } finally { f.service.close(); }
});

test('one-shot returns full native text rather than the truncated inspection view', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'long answer' }, extra(A));
  const r = f.record(), reply = '中'.repeat(9000) + '完整结尾';
  f.finish('artist', reply); f.report(reply);
  await f.service.poll(r.agentId);
  assert.ok(f.notices.at(-1).prompt.includes(reply));
  assert.equal(f.record(), undefined);
  f.service.close();
});

test('list retains file summaries while explicit reports contain only submitted text', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'draw a diagram' }, extra(A));
  f.sessions.get(f.record().sessionId).changes = [{ path: 'diagram.svg', operation: 'create', before: '', after: '<svg>private full file body</svg>' }];
  f.finish('artist', 'Saved diagram.svg'); f.report('Saved diagram.svg'); await f.service.poll(f.record().agentId);
  const list = await f.service.list(extra(A));
  assert.ok(!JSON.stringify(list).includes('private full file body'));
  assert.ok(!f.notices.at(-1).prompt.includes('private full file body'));
  assert.equal((await f.service.changes({ name: 'artist' }, extra(A))).changes[0].after, '<svg>private full file body</svg>');
  f.service.close();
});


test('one-shot requires an explicit final report and settled descendant tree', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'Delegate a design tree' }, extra(A));
    const r = f.record(), s = f.sessions.get(r.sessionId);
    const child = { sessionId: 'native-child', parentSessionId: r.sessionId, name: 'designer', status: 'running',
      changes: [{ path: 'design.svg', operation: 'write' }], coverage: 'child writes' };
    s.descendants = [child]; s.tree = { settled: false, running: true, rootSummary: { ready: false } };
    f.finish('artist', 'Initial root turn, not the final summary');
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'running');
    assert.equal(f.notices.length, 0);
    assert.equal(f.removed.length, 0);
    child.status = 'idle'; s.tree.running = false;
    await f.service.poll(r.agentId); // Children idle, but native notifications have not settled.
    assert.equal(f.notices.length, 0);
    s.tree.settled = true;
    await f.service.poll(r.agentId); // Settled tree, but root summary still unverified.
    assert.equal(f.record().state, 'running', 'the missing final is reminded, not settled');
    f.finish('artist', 'still not a report');
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'awaiting_report');
    assert.equal(f.notices.length, 0);
    const summary = '汇总'.repeat(5000) + '完整收尾';
    s.tree.rootSummary = { ready: true, reply: 'Not a report', state: 'completed' };
    f.report(summary);
    await f.service.poll(r.agentId);
    assert.equal(f.record(), undefined);
    assert.ok(f.notices[0].prompt.includes(summary));
    assert.ok(!f.notices[0].prompt.includes('Initial root turn'));
    assert.ok(!f.notices[0].prompt.includes('designer'));
    assert.equal(f.removed.filter(item => item === r.sessionId).length, 1);
  } finally { f.service.close(); }
});

test('tree inspection and file attribution follow only this root lineage without exposing native IDs', async () => {
  const f = await fixture();
  try {
    for (const thread of [A, B]) await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(thread));
    await f.service.send({ name: 'artist', message: 'Build a nested tree' }, extra(A));
    const r = f.record(), s = f.sessions.get(r.sessionId), foreign = f.record('artist', B);
    s.changes = [{ path: 'root.md', operation: 'write' }];
    s.descendants = [
      { sessionId: 'native-child', parentSessionId: r.sessionId, name: 'designer', status: 'running', changes: [{ path: 'design.svg', operation: 'create', after: 'private body' }], coverage: 'child scope' },
      { sessionId: 'native-grandchild', parentSessionId: 'native-child', name: 'reviewer', status: 'idle', changes: [{ path: 'review.md', operation: 'write' }], coverage: 'grandchild scope' },
      { sessionId: foreign.sessionId, parentSessionId: null, name: 'foreign chat', status: 'running', changes: [{ path: 'foreign-secret.md', operation: 'write' }] },
    ];
    for (const [id, text] of [['native-child', 'Child work'], ['native-grandchild', 'Grandchild review']]) {
      f.sessions.set(id, { sessionId: id, turns: new Map([['native-turn', { afterSeq: 0, state: 'ended', endSeq: 2,
        messages: [{ seq: 1, text }] }]]) });
    }
    const changes = await f.service.changes({ name: 'artist' }, extra(A));
    assert.deepEqual(changes.changes.map(item => item.agentPath), [['artist'], ['artist', 'designer'], ['artist', 'designer', 'reviewer']]);
    const list = await f.service.list(extra(A));
    assert.deepEqual(list.items[0].tree.nodes.map(node => node.depth), [0, 1, 2]);
    assert.ok(!JSON.stringify(list).includes('private body'));
    const inspected = await f.service.inspect({ name: 'artist' }, extra(A));
    assert.equal(inspected.tree.nodes[1].messages[0].text, 'Child work');
    assert.equal(inspected.tree.nodes[2].messages[0].text, 'Grandchild review');
    const visible = JSON.stringify([list, changes, inspected]);
    for (const hidden of ['native-child', 'native-grandchild', foreign.sessionId, 'foreign-secret.md', 'foreign chat']) assert.ok(!visible.includes(hidden));
    assert.ok(!f.reads.includes(foreign.sessionId));
    assert.equal((await f.service.list(extra(B))).items[0].tree.nodes.length, 0);
  } finally { f.service.close(); }
});

test('tree cancellation cannot complete or clean up while a descendant is still running', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'Tree to cancel' }, extra(A));
    const r = f.record(), s = f.sessions.get(r.sessionId);
    s.descendants = [{ sessionId: 'native-child', parentSessionId: r.sessionId, name: 'child', status: 'running', changes: [] }];
    s.tree = { settled: false, running: true };
    await f.service.cancel({ name: 'artist' }, extra(A));
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'running');
    assert.equal(f.notices.length, 0);
    assert.equal(f.removed.length, 0);
    assert.equal(f.cancellations[0].sessionId, r.sessionId);
    s.descendants[0].status = 'idle'; s.tree = { settled: true, running: false };
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'cancelled');
    assert.equal(f.notices.length, 0);
    assert.equal(f.removed.length, 0);
  } finally { f.service.close(); }
});


test('tree protocol negotiation blocks an old host and a new task cannot lose its tree snapshot', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    const hostStatus = f.api.hostStatus;
    f.api.hostStatus = async () => { const status = await hostStatus(); delete status.treeProtocol; return status; };
    const unavailable = await f.service.status(extra(A));
    assert.equal(unavailable.dshConnected, true);
    assert.equal(unavailable.ready, false);
    assert.equal(unavailable.hostError.code, 'tree-protocol-required');
    const blocked = await f.service.send({ name: 'artist', message: 'Do not start on an old host' }, extra(A));
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.error.code, 'tree-protocol-required');
    assert.equal(f.sends.length, 0);
    f.api.hostStatus = hostStatus;
    await f.service.poll(f.record().agentId); // Resume the same saved task after the bridge upgrades.
    assert.equal(f.record().task.treeProtocol, 1);
    assert.equal(f.sends.length, 1);
    const managedStatus = f.api.managedStatus;
    f.api.managedStatus = async input => { const status = await managedStatus(input); delete status.tree; return status; };
    f.finish();
    await f.service.poll(f.record().agentId);
    assert.equal(f.record().error.code, 'tree-protocol-required');
    assert.equal(f.notices.length, 0);
    assert.equal(f.removed.length, 0);
  } finally { f.service.close(); }
});

test('a historical automatic result remains quarantined without delivery or cleanup', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    const r = f.record();
    r.state = 'delivery_pending';
    r.task = { taskId: 'historical-task', message: 'Old leaf work', state: 'completed', dispatches: [], answers: [],
      result: { state: 'completed', reply: 'Historical verified answer', changes: [], coverage: 'old leaf scope' },
      delivery: { state: 'pending' } };
    f.store.save(r);
    // Persistent leaf delivery can complete with DSH unavailable; use persistent
    // here so native cleanup does not need a live host.
    r.lifetime = 'persistent'; f.store.save(r);
    const observed = f.statusCalls();
    f.offline(true);
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'awaiting_report');
    assert.equal(f.statusCalls(), observed);
    assert.equal(f.notices.length, 0);
    assert.equal(f.record().task.legacyAutomaticResult.reply, 'Historical verified answer');
    assert.equal(f.removed.length, 0);
    f.offline(false);
    await f.service.poll(r.agentId);
    assert.equal(f.sends.length, 0, 'old completed work must never be dispatched again');
    assert.equal(f.notices.length, 0);
  } finally { f.service.close(); }
});


test('a new caller adopts the exact old in-flight task without resending its prompt', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'Existing in-flight work' }, extra(A));
    const old = f.record();
    delete old.task.treeProtocol;
    f.store.save(old);
    const requestId = old.task.dispatches[0].requestId;
    const baseline = old.task.dispatches[0].afterSeq;
    await f.service.poll(old.agentId);
    assert.equal(f.sends.length, 1);
    assert.equal(f.beginnings.length, 2);
    assert.equal(f.beginnings[1].taskId, old.task.taskId);
    assert.equal(f.beginnings[1].taskStartSeq, baseline);
    assert.equal(f.beginnings[1].treeProtocol, 1);
    assert.equal(f.record().task.dispatches[0].requestId, requestId);
    assert.equal(f.record().task.treeProtocol, 1);
  } finally { f.service.close(); }
});


test('a native final summary never becomes a report, but a failed turn notifies', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'Nested task' }, extra(A));
    const r = f.record(), s = f.sessions.get(r.sessionId);
    s.descendants = [{ sessionId: 'native-child', parentSessionId: r.sessionId, name: 'child', status: 'idle', changes: [] }];
    f.finish('artist', 'Initial root completed');
    s.tree = { settled: true, running: false, rootSummary: { ready: true, reply: '', state: 'failed' } };
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'failed');
    assert.equal(f.record().task.result, undefined);
    assert.equal(f.record().task.reports.filter(report => !report.failure).length, 0, 'native text never becomes an explicit report');
    assert.equal(f.notices.length, 1, 'the failure still reaches the parent');
    assert.match(f.notices[0].prompt, /执行失败/);
  } finally { f.service.close(); }
});


test('managed inspection keeps empty history distinct from denial without starting a task or using ordinary history', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    const r = f.record(), s = f.sessions.get(r.sessionId);
    s.tree = { nodes: [], settled: false, running: false };
    let ordinaryReads = 0;
    f.api.readSession = async () => { ordinaryReads++; throw Object.assign(new Error('session/agent-busy'), { code: 'session/agent-busy' }); };
    const empty = await f.service.inspect({ name: 'artist' }, extra(A));
    assert.deepEqual(empty.messages, []);
    assert.match(empty.note, /No completed text/);
    assert.equal(empty.inspectionIncomplete, false);
    assert.equal(f.historyRequests[0].targetSessionId, r.sessionId);
    assert.equal(f.beginnings.length, 0);
    assert.equal(f.sends.length, 0);
    assert.equal(f.record().task, undefined);
    delete s.tree;
    s.descendants = [{ sessionId: 'native-child', parentSessionId: r.sessionId, name: 'child', status: 'running', changes: [] }];
    f.api.managedHistory = async input => {
      if (input.targetSessionId !== r.sessionId) throw Object.assign(new Error('The requested history is outside the authorized tree.'), { code: 'managed-history-forbidden' });
      return { events: [1, 2, 3].map(seq => ({ seq, type: 'assistant/message', data: { content: [{ type: 'text', text: 'message-' + seq }, { type: 'reasoning', text: 'hidden reasoning' }] } })) };
    };
    const partial = await f.service.inspect({ name: 'artist', maxMessages: 1 }, extra(A));
    assert.deepEqual(partial.messages.map(message => message.text), ['message-3']);
    assert.equal(partial.hasMore, true);
    assert.equal(partial.inspectionIncomplete, true);
    assert.equal(partial.tree.nodes[1].error.code, 'managed-history-forbidden');
    assert.equal(partial.tree.nodes[1].messages, undefined, 'denial is not an empty history');
    assert.ok(!JSON.stringify(partial).includes('hidden reasoning'));
    f.api.managedHistory = async () => ({});
    const malformed = await f.service.inspect({ name: 'artist' }, extra(A));
    assert.equal(malformed.error.code, 'invalid-response');
    assert.equal(malformed.messages, undefined);
    assert.equal(ordinaryReads, 0);
    assert.equal(f.beginnings.length, 0);
    assert.equal(f.sends.length, 0);
  } finally { f.service.close(); }
});


test('busy supplements persist independently and are dispatched in order to the same task', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  const record = f.record(); let release;
  const held = f.store.locked(record.agentId, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(await f.service.send({ name: 'artist', message: 'first' }, extra(A)), { name: 'artist', accepted: false, queued: true, state: 'running', actualModel: 'test' });
  const flagged = f.record(); flagged.callbackBlocked = true; f.store.save(flagged);
  const second = await f.service.send({ name: 'artist', message: 'second' }, extra(A));
  assert.equal(second.queued, true);
  assert.equal(second.callbackError.code, 'native-callback-unavailable');
  assert.equal(f.sends.length, 1);
  f.store.save(record);
  release(); await held;
  await f.service.poll(record.agentId);
  assert.deepEqual(f.sends.map(item => item.message), ['initial', 'first', 'second']);
  assert.deepEqual(f.sends.map(item => item.mode), ['queue', 'steer', 'steer'], 'a drained supplement is steered as well');
  assert.equal(new Set(f.sends.map(item => item.requestId)).size, 3);
  assert.equal(f.store.supplements(record.agentId).length, 0);
  f.service.close();
});

test('a supplement sent while the task runs is steered into the running turn', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'long work' }, extra(A));
    assert.deepEqual(f.sends.map(item => [item.message, item.mode]), [['long work', 'queue']]);
    const supplement = await f.service.send({ name: 'artist', message: 'new input' }, extra(A));
    assert.equal(supplement.accepted, true, 'the running task admits the input without ending its turn');
    assert.equal(supplement.state, 'running');
    assert.deepEqual(f.sends.map(item => [item.message, item.mode]), [['long work', 'queue'], ['new input', 'steer']],
      'the supplement reaches the model on its next step instead of waiting for the turn to end');
    const dispatch = f.record().task.dispatches.at(-1);
    assert.equal(dispatch.kind, 'supplement');
    assert.equal(dispatch.accepted, true);
    assert.equal(dispatch.state, 'running');
  } finally { f.service.close(); }
});

test('busy after entering the operation is not mistaken for a lock timeout', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  f.api.managedStatus = async () => { throw Object.assign(new Error('native busy'), { code: 'agent-busy' }); };
  await assert.rejects(f.service.send({ name: 'artist', message: 'supplement' }, extra(A)), error => error.message === 'native busy');
  assert.equal(f.store.supplements(f.record().agentId).length, 0);
  f.service.close();
});

test('queued input answers a waiting question and cannot cross cancellation or task replacement', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  const record = f.record(); let release;
  f.sessions.get(record.sessionId).questions = [{ id: 'q', message: 'question', state: 'pending' }];
  const held = f.store.locked(record.agentId, () => new Promise(resolve => { release = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  await f.service.send({ name: 'artist', message: 'answer' }, extra(A));
  await f.service.send({ name: 'artist', message: 'next supplement' }, extra(A));
  release(); await held; await f.service.poll(record.agentId);
  assert.equal(f.sessions.get(record.sessionId).questions[0].state, 'answered');
  assert.equal(f.record().task.answers[0].message, 'answer');
  assert.equal(f.sends.some(item => item.message === 'next supplement'), false);
  f.finish();
  await f.service.poll(record.agentId);
  await f.service.poll(record.agentId);
  assert.deepEqual(f.sends.slice(1).map(item => item.message), ['Answer: answer', 'next supplement']);
  const stale = f.record();
  assert.equal(f.store.enqueueSupplement(stale, 'request-stale', 'must not send'), true);
  const newer = f.record(); newer.task.taskId = 'task-new'; f.store.save(newer);
  await f.service.poll(record.agentId);
  assert.equal(f.store.supplements(record.agentId)[0].status, 'blocked');
  assert.equal(f.sends.some(item => item.message === 'must not send'), false);
  f.service.close();
});

test('queued dispatch recovers the original accepted receipt without resending', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  const record = f.record(), requestId = 'request-recovery';
  assert.equal(f.store.enqueueSupplement(record, requestId, 'queued message'), true);
  record.task.dispatches.push({ requestId, message: 'queued message', state: 'unknown', afterSeq: 0 });
  f.store.save(record);
  const key = createHash('sha256').update(JSON.stringify(['send', record.sessionId, requestId])).digest('hex');
  const directory = path.join(f.stateDirectory, 'scoped', record.ownerId, record.agentId, 'requests');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, `${key}.json`), JSON.stringify({ status: 'accepted', afterSeq: 0 }));
  await f.service.poll(record.agentId);
  assert.equal(f.sends.length, 1);
  assert.equal(f.store.supplementSummary(record.agentId, record.task.taskId).latest.status, 'accepted');
  f.service.close();
});

test('cached final or cancellation blocks queued input and preserves its reason', async () => {
  for (const reason of ['final-submitted', 'task-cancelled']) {
    const f = await fixture();
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
    const record = f.record();
    assert.equal(f.store.enqueueSupplement(record, 'request-blocked', 'do not send'), true);
    if (reason === 'task-cancelled') { record.task.cancelRequested = true; record.task.cancelVerified = true; }
    else record.task.reports = [{ id: 'final', message: 'done', final: true, delivery: { state: 'delivered' }, treeSettledConfirmed: true }];
    f.store.save(record);
    await f.service.poll(record.agentId);
    const summary = f.store.supplementSummary(record.agentId, record.task.taskId);
    assert.equal(summary.blocked, 1);
    assert.equal(summary.latest.reason, reason);
    assert.equal(f.sends.some(item => item.message === 'do not send'), false);
    if (reason === 'final-submitted') {
      assert.equal(f.record().state, 'supplement_blocked');
      await f.service.delete({ name: 'artist' }, extra(A));
      assert.equal(f.store.supplements(record.agentId).length, 0);
    }
    f.service.close();
  }
});

test('cancellation resolves an already consumed queued answer despite its unsent continuation', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  const record = f.record();
  assert.equal(f.store.enqueueSupplement(record, 'request-answer', 'answer'), true);
  f.store.setSupplement('request-answer', 'sending');
  record.task.answers = [{ answerId: 'request-answer', message: 'answer', questionIds: ['q'], dispatched: false }];
  record.task.cancelRequested = true; record.task.cancelVerified = true;
  f.store.save(record);
  await f.service.poll(record.agentId);
  assert.equal(f.store.supplementSummary(record.agentId, record.task.taskId).latest.status, 'accepted');
  assert.equal(f.sends.length, 1);
  f.service.close();
});

test('cached final checks unknown queued dispatch against request-correlated native completion', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  const record = f.record(), requestId = 'request-native-proof';
  assert.equal(f.store.enqueueSupplement(record, requestId, 'supplement'), true);
  f.store.setSupplement(requestId, 'unknown');
  record.task.dispatches.push({ requestId, message: 'supplement', state: 'unknown', afterSeq: 3 });
  record.task.reports = [{ id: 'final', message: 'done', final: true, delivery: { state: 'delivered' }, treeSettledConfirmed: true }];
  record.task.result = { state: 'completed', reply: 'done', changes: [] };
  f.store.save(record);
  f.sessions.get(record.sessionId).turns.set(requestId, { afterSeq: 3, state: 'ended', endSeq: 8, completionReason: { kind: 'completed' } });
  await f.service.poll(record.agentId);
  assert.equal(f.store.supplementSummary(record.agentId, record.task.taskId).latest.status, 'accepted');
  assert.equal(f.sends.length, 1);
  f.service.close();
});

test('a sealed final never resends a queued dispatch with no original receipt', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  const record = f.record(), requestId = 'request-unsent';
  assert.equal(f.store.enqueueSupplement(record, requestId, 'must not send'), true);
  f.store.setSupplement(requestId, 'sending');
  record.task.dispatches.push({ requestId, message: 'must not send', state: 'sending', afterSeq: 0 });
  record.task.reports = [{ id: 'final', message: 'done', final: true, delivery: { state: 'delivered' }, treeSettledConfirmed: true }];
  record.task.result = { state: 'completed', reply: 'done', changes: [] };
  f.store.save(record);
  await f.service.poll(record.agentId);
  const summary = f.store.supplementSummary(record.agentId, record.task.taskId);
  assert.equal(summary.latest.status, 'blocked');
  assert.equal(summary.latest.reason, 'final-submitted');
  assert.equal(f.sends.length, 1);
  f.service.close();
});

test('an uncached native final blocks recovery before resending an unsent intent', async () => {
  const f = await fixture();
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
  const record = f.record(), requestId = 'request-unsent-native-final';
  assert.equal(f.store.enqueueSupplement(record, requestId, 'must not send'), true);
  f.store.setSupplement(requestId, 'sending');
  record.task.dispatches.push({ requestId, message: 'must not send', state: 'sending', afterSeq: 0 });
  f.store.save(record);
  f.sessions.get(record.sessionId).reports = [{ id: 'native-final', taskId: record.task.taskId, message: 'done', final: true }];
  await f.service.poll(record.agentId);
  assert.equal(f.store.supplementSummary(record.agentId, record.task.taskId).latest.reason, 'final-submitted');
  assert.equal(f.sends.length, 1);
  f.service.close();
});

test('send returns a compact receipt for a rich active task and preserves errors', async () => {
  let failure;
  const f = await fixture({ beforeSend: async () => { if (failure) throw failure; } });
  try {
  await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
  assert.deepEqual(await f.service.send({ name: 'artist', message: 'private initial task' }, extra(A)),
    { name: 'artist', accepted: true, state: 'running', actualModel: 'test' });
  const record = f.record();
  record.callbackBlocked = true;
  record.task.reports = [{ id: 'old-report', message: 'private report', final: false, delivery: { state: 'blocked' } }];
  const session = f.sessions.get(record.sessionId);
  session.changes = [{ path: 'private file', operation: 'write' }];
  session.descendants = [
    { sessionId: 'child', parentSessionId: record.sessionId, name: 'child', status: 'unloaded', changes: [] },
    { sessionId: 'grandchild', parentSessionId: 'child', name: 'deep child', status: 'unloaded',
      changes: [{ path: 'private child file', operation: 'write' }], coverage: { complete: false } },
  ];
  f.store.save(record);
  const result = await f.service.send({ name: 'artist', message: 'private supplement' }, extra(A));
  assert.deepEqual(Object.keys(result).sort(), ['accepted', 'actualModel', 'callbackError', 'name', 'state']);
  assert.equal(result.accepted, true);
  assert.equal(result.callbackError.code, 'native-callback-unavailable');
  assert.doesNotMatch(JSON.stringify(result), /private|deep child|coverage/);
  const listed = (await f.service.list(extra(A))).items[0];
  assert.equal(listed.tree.nodes.length, 3);
  assert.equal(listed.changes.count, 2);
  assert.equal(listed.reports.latest.summary, 'private report');
  failure = Object.assign(new Error('transport rejected'), { code: 'send-rejected' });
  const rejected = await f.service.send({ name: 'artist', message: 'retry' }, extra(A));
  assert.equal(rejected.accepted, false);
  assert.equal(rejected.error.code, 'send-rejected');
  assert.equal(rejected.callbackError.code, 'native-callback-unavailable');
  failure = Object.assign(new Error('delivery unknown'), { code: 'send-unknown', uncertain: true });
  const unknown = await f.service.send({ name: 'artist', message: 'retry uncertain' }, extra(A));
  assert.equal(unknown.accepted, false);
  assert.equal(unknown.error.code, 'send-unknown');
  failure = undefined;
  f.sessions.get(f.record().sessionId).questions = [{ id: 'q', message: 'question', state: 'pending' }];
  assert.deepEqual(await f.service.send({ name: 'artist', message: 'answer' }, extra(A)), { name: 'artist', answered: true, state: 'resuming', actualModel: 'test' });
  } finally { f.service.close(); }
});

test('ordinary turns stay quiet; nonfinal reports preserve the task and exact body across supplements', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'work' }, extra(A));
    const first = f.record(), taskId = first.task.taskId;
    f.finish('artist', 'ordinary assistant text');
    await f.service.poll(first.agentId);
    assert.equal(f.record().state, 'running', 'the ending without a final is reminded once');
    f.finish('artist', 'still ordinary text');
    await f.service.poll(first.agentId);
    assert.equal(f.record().state, 'awaiting_report');
    assert.equal(f.notices.length, 0); assert.equal(f.removed.length, 0);
    f.report('Only this progress', false);
    await f.service.poll(first.agentId);
    assert.equal(f.record().state, 'awaiting_report');
    assert.equal(f.notices[0].prompt.split('\n\n<!--')[0], 'DSH「artist」汇报：\nOnly this progress');
    await f.service.poll(first.agentId);
    assert.equal(f.notices.length, 1);
    await f.service.send({ name: 'artist', message: 'continue' }, extra(A));
    assert.equal(f.record().task.taskId, taskId);
    assert.equal(f.sends.length, 3, 'task, one reminder, then the continuation');
    f.report('Explicit final');
    f.finish('artist', 'Different ordinary ending');
    await f.service.poll(first.agentId);
    assert.equal(f.record(), undefined);
    assert.equal(f.notices.length, 2);
    assert.equal(f.notices[1].prompt.split('\n\n<!--')[0], 'DSH「artist」交付：\nExplicit final');
  } finally { f.service.close(); }
});

test('a submitted final waits for the tree; cancellation retains reports but never cleans automatically', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'work' }, extra(A));
    const r = f.record(), session = f.sessions.get(r.sessionId);
    f.report('Final submitted');
    session.tree = { settled: false, running: true };
    await f.service.poll(r.agentId);
    assert.equal(f.notices.length, 0);
    await assert.rejects(f.service.send({ name: 'artist', message: 'too late' }, extra(A)), /final report/);
    await f.service.cancel({ name: 'artist' }, extra(A));
    session.tree = { settled: true, running: false };
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'cancelled');
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].prompt.split('\n\n<!--')[0], 'DSH「artist」交付：\nFinal submitted');
    assert.equal(f.removed.length, 0);
  } finally { f.service.close(); }
});

test('report protocol adoption preserves the dispatch and rejects an old bridge', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'existing task' }, extra(A));
    const r = f.record(); delete r.task.reportProtocol; f.store.save(r);
    const status = f.api.hostStatus;
    f.api.hostStatus = async () => ({ ...await status(), reportProtocol: undefined });
    await f.service.poll(r.agentId);
    assert.equal(f.record().error.code, 'report-protocol-required');
    assert.equal(f.sends.length, 1);
    f.api.hostStatus = status;
    await f.service.poll(r.agentId);
    assert.equal(f.beginnings.at(-1).taskId, r.task.taskId);
    assert.equal(f.beginnings.at(-1).reportProtocol, 1);
    assert.equal(f.record().task.reportProtocol, 1);
    assert.equal(f.sends.length, 1);
  } finally { f.service.close(); }
});


test('a cancelled persistent agent starts a new task in the same session, while a cancelled one-shot cannot', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'cancel this' }, extra(A));
    const old = f.record(), oldTask = old.task.taskId;
    await f.service.cancel({ name: 'artist' }, extra(A));
    await f.service.poll(old.agentId);
    assert.equal(f.record().state, 'cancelled');
    await f.service.send({ name: 'artist', message: 'new task' }, extra(A));
    assert.equal(f.record().sessionId, old.sessionId);
    assert.notEqual(f.record().task.taskId, oldTask);
    assert.equal(f.store.historyFor(f.record().agentId)[0].taskId, oldTask);
    assert.equal(f.sends.length, 2);
    await f.service.create({ name: 'once', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'once', message: 'one task' }, extra(A));
    await f.service.cancel({ name: 'once' }, extra(A));
    await f.service.poll(f.record('once').agentId);
    await assert.rejects(f.service.send({ name: 'once', message: 'second task' }, extra(A)), /one-shot/);
    assert.equal(f.notices.length, 0);
  } finally { f.service.close(); }
});


test('an accepted progress report is delivered before a broken ordinary dispatch observation', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'work' }, extra(A));
    const r = f.record();
    f.report('Persisted progress', false);
    // A malformed/missing native dispatch causes the fixture wait to reject.
    f.sessions.get(r.sessionId).turns.delete(r.task.dispatches[0].requestId);
    await f.service.poll(r.agentId);
    assert.equal(f.notices.length, 1);
    assert.equal(f.notices[0].prompt.split('\n\n<!--')[0], 'DSH「artist」汇报：\nPersisted progress');
    assert.equal(f.record().task.reports[0].delivery.state, 'delivered');
    assert.equal(f.record().state, 'reconnecting');
    await f.service.poll(r.agentId);
    assert.equal(f.notices.length, 1);
  } finally { f.service.close(); }
});


test('a failed final report delivery retry never automatically cleans a one-shot tree', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'work' }, extra(A));
    const r = f.record(), session = f.sessions.get(r.sessionId);
    f.finish(); f.report('Explicit failure report');
    session.tree = { settled: true, running: false, rootSummary: { ready: true, reply: '', state: 'failed' } };
    f.notification('reject');
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'delivery_pending');
    assert.equal(f.record().task.result.state, 'failed');
    assert.equal(f.removed.length, 0);
    const retry = f.record();
    // The persisted final result remains authoritative even for records whose
    // task state predates this fix and still says running.
    retry.task.state = 'running';
    retry.task.reports[0].delivery.nextAttemptAt = 0;
    f.store.save(retry);
    f.notification('ok');
    await f.service.poll(r.agentId);
    assert.equal(f.record().state, 'failed');
    assert.equal(f.record().task.state, 'failed');
    assert.equal(f.record().task.reports[0].delivery.state, 'delivered');
    assert.equal(f.notices.length, 1);
    assert.equal(f.removed.length, 0);
    assert.ok(f.sessions.has(r.sessionId));
  } finally { f.service.close(); }
});

test('status names the DSH internals a changed host no longer provides', async () => {
  const f = await fixture();
  try {
    const healthy = await f.service.status(extra(A));
    assert.equal(healthy.backends.dsh.ready, true, 'a complete host stays ready');
    assert.equal('missingInternals' in healthy.backends.dsh, false);

    const hostStatus = f.api.hostStatus;
    f.api.hostStatus = async () => ({ ...(await hostStatus()), compatibility: { missing: ['sessionController.inspect or sessionQuery.readSession'] } });
    const changed = await f.service.status(extra(A));
    assert.equal(changed.backends.dsh.ready, false, 'a host that renamed an internal cannot run a task');
    assert.deepEqual(changed.backends.dsh.missingInternals, ['sessionController.inspect or sessionQuery.readSession']);
    assert.equal(changed.backends.dsh.reason.code, 'dsh-internals-changed');
    assert.match(changed.backends.dsh.reason.message, /sessionQuery\.readSession/);
  } finally { f.service.close(); }
});

const dueTask = overrides => ({ taskId: 'task-a', finalReminder: 'armed', reports: [], ...overrides });

test('a turn that ends without a final report is reminded exactly once', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'draw the diagram' }, extra(A));
    f.finish('artist', 'all done, written in the reply only');
    await f.service.poll(f.record().agentId);
    assert.equal(f.sends.length, 2, 'the task plus one reminder');
    assert.equal(f.sends[1].message, FINAL_REPORT_REMINDER);
    assert.equal(f.sends[1].mode, 'steer', 'a supplement is read on the next step');
    assert.equal(f.record().state, 'running', 'the reminder turn decides the next state, not this one');
    assert.equal(f.record().task.finalReminder, 'sent');
    assert.deepEqual(f.notices, [], 'the controlling side is never notified');

    // The reminder turn ends without a final report: the task settles, silently.
    f.finish('artist', 'still only text');
    await f.service.poll(f.record().agentId);
    assert.equal(f.record().state, 'awaiting_report');
    assert.equal(f.sends.length, 2, 'a reminder is never sent twice');
  } finally { f.service.close(); }
});

test('a task without the marker is never reminded, which keeps older tasks quiet', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'old task' }, extra(A));
    const record = f.record();
    delete record.task.finalReminder;
    f.store.save(record);
    f.finish('artist', 'text only');
    await f.service.poll(record.agentId);
    assert.equal(f.record().state, 'awaiting_report');
    assert.equal(f.sends.length, 1, 'no reminder for a task created before the rule');
  } finally { f.service.close(); }
});

test('a failed or cancelled turn is not reminded', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'break' }, extra(A));
    const session = f.sessions.get(f.record().sessionId);
    for (const [id, turn] of session.turns) session.turns.set(id, { ...turn, state: 'ended', endSeq: 9,
      completionReason: { kind: 'error', error: { kind: 'provider', message: 'boom' } } });
    session.running = false;
    await f.service.poll(f.record().agentId);
    assert.equal(f.record().state, 'failed');
    assert.equal(f.sends.length, 1, 'a failed turn gets no reminder');

    await f.service.send({ name: 'artist', message: 'again' }, extra(A));
    await f.service.cancel({ name: 'artist' }, extra(A));
    f.finish('artist', 'cut short');
    await f.service.poll(f.record().agentId);
    assert.equal(f.sends.length, 2, 'a cancelled turn gets no reminder');
  } finally { f.service.close(); }
});

test('a turn that already submitted a final report is not reminded', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'draw' }, extra(A));
    f.finish('artist', 'done');
    f.report('delivered properly', true);
    await f.service.poll(f.record().agentId);
    assert.equal(f.sends.length, 1, 'the explicit final is the report; no reminder');
  } finally { f.service.close(); }
});

test('a queued supplement suppresses the reminder until it is read', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'draw' }, extra(A));
    const record = f.record();
    f.store.enqueueSupplement(record, 'supplement-1', 'one more colour');
    f.finish('artist', 'text only');
    await f.service.poll(record.agentId);
    const queued = f.record();
    assert.equal(queued.task.finalReminder, 'armed', 'the reminder waits for the queued input');
    assert.equal(f.sends.filter(send => send.message === FINAL_REPORT_REMINDER).length, 0);
  } finally { f.service.close(); }
});

test('the reminder is decision logic on its own, so every condition can be checked directly', () => {
  const view = { reports: [] };
  assert.equal(finalReminderDue({ task: dueTask(), view, target: 'dsh', supplements: [] }), true);
  assert.equal(finalReminderDue({ terminal: 'failed', task: dueTask(), view, target: 'dsh' }), false);
  assert.equal(finalReminderDue({ terminal: 'cancelled', task: dueTask(), view, target: 'dsh' }), false);
  assert.equal(finalReminderDue({ task: dueTask({ finalReminder: 'sent' }), view, target: 'dsh' }), false);
  assert.equal(finalReminderDue({ task: dueTask({ reports: [{ final: true }] }), view, target: 'dsh' }), false);
  assert.equal(finalReminderDue({ task: dueTask(), view: { reports: [{ final: true }] }, target: 'dsh' }), false,
    'a final that only reached the observation still counts');
  assert.equal(finalReminderDue({ task: dueTask(), view, target: 'codex-desktop' }), false,
    'desktop targets use their own durable queue');
  assert.equal(finalReminderDue({ task: dueTask(), view, target: 'dsh', supplements: [{ task: 'task-a', status: 'queued' }] }), false);
  assert.equal(finalReminderDue({ task: dueTask(), view, target: 'dsh', supplements: [{ task: 'task-a', status: 'accepted' }] }), true,
    'a delivered supplement no longer waits');
  assert.equal(finalReminderDue({ task: dueTask(), view, target: 'dsh', supplements: [{ task: 'other', status: 'queued' }] }), true,
    'another task supplement is not this task input');
});

test('a reminder that cannot be sent is not retried and does not fail the task', async () => {
  let attempts = 0;
  const f = await fixture({ beforeSend: async () => {
    attempts += 1;
    if (attempts === 2) throw Object.assign(new Error('supplement rejected'), { code: 'send-rejected' });
  } });
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'draw' }, extra(A));
    f.finish('artist', 'text only');
    await f.service.poll(f.record().agentId);
    assert.equal(f.record().task.finalReminder, 'sent');
    assert.equal(f.record().state, 'running');
    const reminder = f.record().task.dispatches.find(dispatch => dispatch.reminder);
    assert.equal(reminder.state, 'failed', 'the reminder keeps its own failure');
    assert.equal(reminder.error.code, 'send-rejected');

    await f.service.poll(f.record().agentId);
    assert.equal(f.record().state, 'awaiting_report', 'the finished turn still settles');
    assert.equal(attempts, 2, 'the reminder is never retried');
    await f.service.poll(f.record().agentId);
    assert.equal(attempts, 2, 'and no loop appears on later polls');
  } finally { f.service.close(); }
});

test('a reminder left failed on disk settles the task instead of failing it', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'draw' }, extra(A));
    f.finish('artist', 'text only');
    await f.service.poll(f.record().agentId);
    // The process died between the failed reminder write and the poll that would have
    // settled the turn: the record on disk already holds a failed reminder.
    const record = f.record();
    record.task.dispatches.find(dispatch => dispatch.reminder).state = 'failed';
    record.state = 'running';
    record.task.state = 'running';
    f.store.save(record);
    f.sessions.get(record.sessionId).running = false;

    await f.service.poll(record.agentId);
    assert.equal(f.record().state, 'awaiting_report', 'a failed reminder never fails the finished turn');
  } finally { f.service.close(); }
});

test('a reminder whose outcome is unknown settles the task and lets it sleep', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await f.service.send({ name: 'artist', message: 'draw' }, extra(A));
    f.finish('artist', 'text only');
    await f.service.poll(f.record().agentId);
    const record = f.record();
    record.task.dispatches.find(dispatch => dispatch.reminder).state = 'unknown';
    record.state = 'running';
    record.task.state = 'running';
    f.store.save(record);
    f.sessions.get(record.sessionId).running = false;

    await f.service.poll(record.agentId);
    const settled = f.record();
    assert.equal(settled.state, 'awaiting_report', 'an undecided reminder is not work the task still owes');
    f.store.claimLease('idle-monitor', 'monitor', 60000); f.store.claimLease('idle-monitor:ready', 'monitor', 60000);
    assert.equal(await f.service.trySleep(settled.agentId), true, 'and the name may sleep again');
  } finally { f.service.close(); }
});

const MULTI_MODEL_CATALOG = {
  default: { provider: 'fixture', model: 'base' },
  routableProviders: ['fixture'],
  groups: [{ id: 'fixture', models: [
    { id: 'base', reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'off' } },
    { id: 'alpha-pro', reasoning: { efforts: [{ id: 'low' }, { id: 'max' }], defaultEffort: 'low' } },
    { id: 'beta-mini', reasoning: { efforts: [{ id: 'medium' }], defaultEffort: 'medium' } },
  ] }],
};

test('create resolves a model substring and keeps it across sends, effort changes and list', async () => {
  const f = await fixture();
  try {
    f.catalog(MULTI_MODEL_CATALOG);
    const created = await f.service.create({ name: 'artist', lifetime: 'persistent', model: 'ALPHA' }, extra(A));
    assert.equal(created.created, true);
    assert.equal(created.actualModel, 'alpha-pro');
    assert.equal(f.sends.length, 0, 'creation starts no model turn');
    assert.deepEqual(f.record().modelPin,
      { provider: 'fixture', model: 'alpha-pro', reasoningEffort: 'low' });
    assert.deepEqual(f.selections.map(item => [item.model, item.reasoningEffort, item.sessionOnly]),
      [['alpha-pro', 'low', true]], 'an explicit DSH pin is session-only');
    assert.equal((await f.service.list(extra(A))).items[0].actualModel, 'alpha-pro');

    const first = await f.service.send({ name: 'artist', message: 'go' }, extra(A));
    assert.equal(first.actualModel, 'alpha-pro');
    assert.equal(f.selections.length, 1, 'the same live selection is not selected again');
    assert.deepEqual(f.record().task.modelSelection,
      { provider: 'fixture', model: 'alpha-pro', reasoningEffort: 'low' });

    const second = await f.service.send({ name: 'artist', message: 'more', effort: 'max' }, extra(A));
    assert.equal(second.actualModel, 'alpha-pro');
    assert.deepEqual(f.record().modelPin,
      { provider: 'fixture', model: 'alpha-pro', reasoningEffort: 'max' });
    const lastSelection = f.selections.at(-1);
    assert.equal(lastSelection.provider, 'fixture');
    assert.equal(lastSelection.model, 'alpha-pro');
    assert.equal(lastSelection.reasoningEffort, 'max');
    assert.equal(lastSelection.sessionOnly, true);
    assert.equal(lastSelection.requestId.endsWith('-model'), true);
    assert.equal(f.record().task.dispatches.at(-1).model.reasoningEffort, 'max');
  } finally { f.service.close(); }
});

test('effort alone without a pin is refused without touching the name or sending', async () => {
  const f = await fixture();
  try {
    f.catalog(MULTI_MODEL_CATALOG);
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await assert.rejects(f.service.send({ name: 'artist', message: 'work', effort: 'high' }, extra(A)),
      error => error.code === 'model-required-for-effort' && /host default/.test(error.message));
    assert.equal(f.record().modelPin, undefined);
    assert.equal(f.sends.length, 0);
  } finally { f.service.close(); }
});

test('an unknown model lists the catalog IDs and creates no durable pin or dispatch', async () => {
  const f = await fixture();
  try {
    f.catalog(MULTI_MODEL_CATALOG);
    await f.service.create({ name: 'artist', lifetime: 'persistent' }, extra(A));
    await assert.rejects(f.service.send({ name: 'artist', message: 'work', model: 'missing' }, extra(A)),
      error => error.code === 'model-not-found' && /alpha-pro/.test(error.message) && /beta-mini/.test(error.message));
    assert.equal(f.record().modelPin, undefined);
    assert.equal(f.sends.length, 0);
  } finally { f.service.close(); }
});

test('a busy lock freezes the current pin for queued input and a later pin change takes the normal lock', async () => {
  const f = await fixture();
  try {
    f.catalog(MULTI_MODEL_CATALOG);
    await f.service.create({ name: 'artist', lifetime: 'persistent', model: 'ALPHA' }, extra(A));
    await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
    const record = f.record(); let release;
    const held = f.store.locked(record.agentId, () => new Promise(resolve => { release = resolve; }));
    await new Promise(resolve => setImmediate(resolve));

    // No model/effort: the old no-wait path stores the current pin in the same
    // INSERT SELECT. An explicit selection must not use this path.
    const old = await f.service.send({ name: 'artist', message: 'queued-old' }, extra(A));
    assert.equal(old.queued, true);
    assert.equal(old.actualModel, 'alpha-pro');
    release(); await held;

    const newer = await f.service.send({ name: 'artist', message: 'queued-new', model: 'BETA' }, extra(A));
    assert.equal(newer.queued, true);
    assert.equal(newer.actualModel, 'beta-mini', 'the queued receipt reports this input’s resolved full ID');
    assert.deepEqual(f.record().modelPin,
      { provider: 'fixture', model: 'beta-mini', reasoningEffort: 'medium' });
    assert.equal((await f.service.list(extra(A))).items[0].actualModel, 'alpha-pro',
      'list keeps the observed model separate from the queued new pin');
    assert.equal(f.store.supplements(record.agentId).length, 2);

    await f.service.poll(record.agentId);
    const supplements = f.record().task.dispatches.filter(dispatch => dispatch.kind === 'supplement');
    assert.deepEqual(supplements.map(dispatch => [dispatch.message, dispatch.model.model]),
      [['queued-old', 'alpha-pro'], ['queued-new', 'beta-mini']],
      'each queued input keeps the selection frozen when it was accepted');
    assert.deepEqual(f.sends.slice(1).map(send => send.message), ['queued-old', 'queued-new']);
  } finally { f.service.close(); }
});

test('a pending question freezes the answer selection before its continuation dispatch', async () => {
  const f = await fixture();
  try {
    f.catalog(MULTI_MODEL_CATALOG);
    await f.service.create({ name: 'artist', lifetime: 'persistent', model: 'ALPHA' }, extra(A));
    await f.service.send({ name: 'artist', message: 'initial' }, extra(A));
    const record = f.record();
    f.sessions.get(record.sessionId).questions = [{ id: 'question-model', state: 'pending', message: 'Continue?' }];
    await f.service.poll(record.agentId);
    assert.equal(f.record().state, 'awaiting_input');

    const answered = await f.service.send({ name: 'artist', message: 'yes', model: 'BETA' }, extra(A));
    assert.equal(answered.answered, true);
    assert.equal(answered.actualModel, 'beta-mini');
    const answer = f.record().task.answers[0];
    assert.deepEqual(answer.modelSelection,
      { provider: 'fixture', model: 'beta-mini', reasoningEffort: 'medium' });
    // The continuation waits for the live turn to end; a later pin change must not
    // rewrite the answer intent already accepted.
    f.finish();
    const later = f.record();
    later.modelPin = { provider: 'fixture', model: 'alpha-pro', reasoningEffort: 'max' };
    f.store.save(later);
    await f.service.poll(record.agentId);
    const dispatch = f.record().task.dispatches.find(item => item.kind === 'answer');
    assert.deepEqual(dispatch.model,
      { provider: 'fixture', model: 'beta-mini', reasoningEffort: 'medium' });
  } finally { f.service.close(); }
});

test('a reminder keeps the name’s explicit selection', async () => {
  const f = await fixture();
  try {
    f.catalog(MULTI_MODEL_CATALOG);
    await f.service.create({ name: 'artist', lifetime: 'persistent', model: 'ALPHA' }, extra(A));
    await f.service.send({ name: 'artist', message: 'work' }, extra(A));
    f.finish();
    await f.service.poll(f.record().agentId);
    const reminder = f.record().task.dispatches.find(item => item.reminder === true);
    assert.ok(reminder);
    assert.deepEqual(reminder.model,
      { provider: 'fixture', model: 'alpha-pro', reasoningEffort: 'low' });
  } finally { f.service.close(); }
});

test('a reminder that did arrive keeps the task running while the model works', async () => {
  const f = await fixture();
  try {
    await f.service.create({ name: 'artist', lifetime: 'once' }, extra(A));
    await f.service.send({ name: 'artist', message: 'draw' }, extra(A));
    f.finish('artist', 'text only');
    await f.service.poll(f.record().agentId);
    const record = f.record();
    record.task.dispatches.find(dispatch => dispatch.reminder).state = 'running';
    f.store.save(record);
    f.sessions.get(record.sessionId).running = true;

    const working = await f.service.poll(record.agentId);
    assert.equal(working.state, 'running', 'the reminder turn is work in progress, not a finished task');
    assert.equal(f.record().task.state, 'running');
  } finally { f.service.close(); }
});
