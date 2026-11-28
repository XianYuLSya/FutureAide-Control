// Releasing a finished round's Codex threads.
//
// A persistent Codex helper keeps its thread loaded for ever today: the caller finishes
// a round, the name goes idle, and nothing ever lets the desktop drop that thread. These
// cases run the real shared state machine, the real roster and the real Codex adapter,
// host and RPC selection; only the desktop's own RPC endpoint is a stand-in, and the
// release call is that stand-in's recorded seam. The real transport picks and verifies
// the thread set itself, so the stand-in only answers with the three states it may.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore, submissionNoticeId, submissionRef } from '../src/roster-store.mjs';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';
import { canReleaseThreads, RELEASE_ATTEMPT_CAP, RELEASE_LONG_RECHECK_MS, RELEASE_RECHECK_MS, releaseDue,
  releaseRetryDelay } from '../src/idle-monitor-eligibility.mjs';
import { liveThread, liveTurn, livePage } from '../test/live-thread-fixture.mjs';
import { CODEX_MODELS } from '../test/assembly/renderer.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOSS = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });

/** The Codex Desktop RPC, reduced to the threads and turns the adapter reads and writes. */
function codexDesktop() {
  const threads = new Map(), calls = [];
  let created = 0, clock = 1793932679, missing = false;
  const textOf = input => (input ?? []).map(item => item.text ?? '').join('');
  const userItem = text => ({ id: `item-${++clock}`, type: 'userMessage', content: [{ type: 'text', text }] });
  const running = thread => thread.turns.find(turn => turn.status === 'inProgress');
  const find = id => {
    const thread = threads.get(id);
    if (!thread || missing) throw Object.assign(new Error(`thread not found: ${id}`),
      { code: 'codex-thread-not-found', terminal: true });
    return thread;
  };
  async function request(method, params = {}) {
    calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'thread/list': return livePage();
      case 'model/list': return livePage(structuredClone(CODEX_MODELS));
      case 'config/read': return { model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'high', profile: null };
      case 'thread/start': {
        const id = `${String(++created).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
        threads.set(id, { id, cwd: params.cwd, name: null, turns: [], loaded: true,
          updatedAt: ++clock, model: 'gpt-6-astra', reasoningEffort: 'high' });
        return { thread: liveThread({ id, cwd: params.cwd, updatedAt: clock, model: 'gpt-6-astra', reasoningEffort: 'high' }) };
      }
      case 'thread/read': {
        const thread = find(params.threadId);
        // A thread the desktop dropped its load of keeps its metadata readable; only the
        // status says so, and that is what the ordinary resume path acts on.
        const status = thread.loaded ? { type: running(thread) ? 'active' : 'idle' } : { type: 'notLoaded' };
        return { thread: liveThread({ id: thread.id, cwd: thread.cwd, name: thread.name, updatedAt: thread.updatedAt,
          model: thread.model, reasoningEffort: thread.reasoningEffort, status }) };
      }
      case 'thread/resume': {
        const thread = find(params.threadId);
        thread.loaded = true;
        return { thread: liveThread({ id: thread.id, cwd: thread.cwd, name: thread.name, updatedAt: thread.updatedAt,
          model: thread.model, reasoningEffort: thread.reasoningEffort,
          status: { type: running(thread) ? 'active' : 'idle' } }) };
      }
      case 'thread/name/set': {
        const thread = find(params.threadId);
        thread.name = params.name; thread.updatedAt = ++clock;
        return {};
      }
      case 'thread/turns/list': {
        const items = turn => params.itemsView !== 'summary' ? []
          : [turn.items.find(item => item.type === 'userMessage'), turn.items.findLast(item => item.type === 'agentMessage')].filter(Boolean);
        return livePage(find(params.threadId).turns.toReversed().map(turn => liveTurn({ id: turn.id, rootTurnId: turn.id,
          status: turn.status, startedAt: turn.startedAt, itemsView: params.itemsView, items: items(turn) })));
      }
      case 'turn/start': {
        const thread = find(params.threadId);
        if (running(thread)) throw Object.assign(new Error('a turn is already running on this thread'), { code: 'codex-native-rpc-rejected' });
        if (params.model !== undefined) thread.model = params.model;
        if (params.effort !== undefined) thread.reasoningEffort = params.effort;
        const turn = { id: `turn-${++clock}`, status: 'inProgress', startedAt: ++clock, items: [userItem(textOf(params.input))] };
        thread.turns.push(turn); thread.updatedAt = ++clock;
        return { turn: liveTurn({ id: turn.id, rootTurnId: turn.id, status: 'inProgress', items: [] }) };
      }
      case 'turn/steer': {
        const thread = find(params.threadId), turn = running(thread);
        if (!turn || turn.id !== params.expectedTurnId) throw Object.assign(new Error('no active turn to steer'), { code: 'codex-native-rpc-rejected' });
        turn.items.push(userItem(textOf(params.input))); thread.updatedAt = ++clock;
        return { turnId: turn.id };
      }
      case 'turn/interrupt': {
        const thread = find(params.threadId), turn = running(thread);
        if (turn) { turn.status = 'interrupted'; thread.updatedAt = ++clock; }
        return {};
      }
      case 'thread/delete': {
        threads.delete(params.threadId);
        return {};
      }
      default: throw new Error(`unexpected native method ${method}`);
    }
  }
  return {
    request,
    threadIds: () => [...threads.keys()],
    runningTurn: threadId => running(find(threadId))?.id,
    inputs: method => calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method) && (!method || call.method === method)),
    /** Methods the adapter sent, in order; a count is enough to prove a quiet poll. */
    methods: () => calls.map(call => call.method),
    calls: () => calls.length,
    /** The desktop dropping its load of every helper thread: what release means here. */
    unload() { for (const thread of threads.values()) thread.loaded = false; },
    loaded: id => find(id).loaded,
    setMissing(value) { missing = value; },
    endTurn(threadId, reply) {
      const thread = find(threadId), turn = running(thread);
      assert.ok(turn, 'the helper has a running turn to end');
      turn.items.push({ id: `item-${++clock}`, type: 'agentMessage', text: reply });
      turn.status = 'completed'; thread.updatedAt = ++clock;
    },
  };
}

async function fixture({ release = 'complete', idleSessionCleanup, releaseAbsent = false, releaseReason,
  onModels, onNotice, ownerHistory, rosterOnDisk = false } = {}) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'idle-cleanup-'));
  const roster = rosterOnDisk ? path.join(stateDirectory, 'roster.sqlite') : ':memory:';
  const store = new RosterStore(roster);
  const codex = codexDesktop();
  const notices = [], releases = [];
  let gate;
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const callCodex = async (threadId, tool, args) => {
    if (tool === 'read_thread') return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace },
      ...(ownerHistory ? { history: ownerHistory() } : {}) };
    notices.push(args.prompt);
    return onNotice?.(args.prompt) ?? { accepted: true };
  };
  const service = createScopedAgents({
    stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh',
    ...(idleSessionCleanup === undefined ? {} : { idleSessionCleanup }),
  }, {
    store,
    clientFactory: () => { throw new Error('no DSH host is needed for these cases'); },
    callCodex,
    backendAdapters: { 'codex-desktop': async (record, deps) => {
      const backend = await createCodexBackend(record, { ...deps, hostOptions: { nativeRequest: codex.request } });
      // A build older than the release path: the shared layer must notice and do nothing.
      if (releaseAbsent) { const { releaseIdleThreads: _absent, ...rest } = backend; return rest; }
      // The stand-in for the real release: it never picks the thread set here, it only
      // answers with the state the transport is allowed to answer with, and it keeps the
      // host's own fence so a test can ask what the host would see.
      return { ...backend, ...(onModels ? { models: async () => {
        const catalog = await backend.models();
        await onModels();
        return catalog;
      } } : {}), releaseIdleThreads: async ({ taskId, canRelease, signal } = {}) => {
        const call = { taskId, name: record.name, canRelease, signal, finished: false };
        releases.push(call);
        try {
          if (release === 'block') { gate = deferred(); await gate.promise; }
          if (release === 'throw') throw new Error('the release transport failed');
          if (release === 'complete') { codex.unload(); return { state: 'complete' }; }
          return { state: release, reason: releaseReason ?? 'the desktop guard has not cleared this thread' };
        } finally { call.finished = true; }
      } };
    } },
    codexProbeRegistration: async () => ({ ready: true, registered: true, tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  const record = name => store.named(ownerIdFor(BOSS), name);
  /** The release runs outside the poll, so a finished round is settled after it answers. */
  const settleRelease = async name => {
    for (let i = 0; i < 100; i++) {
      const current = record(name);
      if (!current || current.releaseState?.state !== 'sending') return;
      await new Promise(done => setTimeout(done, 10));
    }
  };
  return {
    service, store, roster, codex, notices, releases, record, settleRelease,
    /** What the stand-in recorded for each call, including the host's own fence. */
    releaseCalls: releases,
    /** Let a deliberately blocked release call finish. */
    openGate: () => gate?.resolve(),
    /** Wait for a condition the background work satisfies. */
    async until(check, tries = 200) {
      for (let i = 0; i < tries; i++) { if (check()) return true; await new Promise(done => setTimeout(done, 10)); }
      return false;
    },
    /**
     * A second process: another service over the same roster, with its own in-memory
     * state and its own record of the release calls it makes.
     */
    second(peerStore = store) {
      const calls = [];
      const peer = createScopedAgents({
        stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh',
        ...(idleSessionCleanup === undefined ? {} : { idleSessionCleanup }),
      }, {
        store: peerStore,
        callCodex,
        clientFactory: () => { throw new Error('no DSH host is needed for these cases'); },
        backendAdapters: { 'codex-desktop': async (record, deps) => {
          const backend = await createCodexBackend(record, { ...deps, hostOptions: { nativeRequest: codex.request } });
          return { ...backend, releaseIdleThreads: async ({ taskId, ticket }) => {
            calls.push({ taskId, ticket });
            return { state: 'waiting', reason: 'release-unsubscribe-accepted' };
          } };
        } },
        codexProbeRegistration: async () => ({ ready: true, registered: true, tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
        startSharedMonitor: () => true,
        removeTree: async () => {},
      });
      // The roster connection belongs to the fixture; this peer only has its own state.
      peer.close = () => {};
      return { service: peer, calls };
    },
    async start(name, task, selection = {}) {
      await service.create({ name, lifetime: 'persistent', target: 'codex-desktop', ...selection }, extra(BOSS));
      await service.send({ name, message: task }, extra(BOSS));
      const agentId = record(name).agentId;
      await service.poll(agentId);
      const [threadId] = codex.threadIds();
      const turnId = codex.runningTurn(threadId);
      assert.ok(turnId, 'the task started a turn on the helper thread');
      return { name, agentId, threadId, turnId };
    },
    poll: helper => service.poll(helper.agentId),
    report: (helper, message, final = false) => service.submitToParent({ kind: 'report', message, final }, extra(helper.threadId)),
    answer: (helper, message) => service.answer({ name: helper.name, message }, extra(BOSS)),
    /** Finish the helper's round with a delivered final report. */
    async finish(helper) {
      await this.report(helper, 'All ten fixed.', true);
      codex.endTurn(helper.threadId, 'all ten');
      await this.poll(helper); await this.poll(helper);
      await settleRelease(helper.name);
      return record(helper.name);
    },
    async fail(helper) {
      codex.endTurn(helper.threadId, 'stopped');
      await this.poll(helper);
      const stopped = record(helper.name);
      stopped.state = stopped.task.state = 'failed';
      stopped.task.dispatches.at(-1).state = 'failed';
      store.save(stopped);
      return stopped;
    },
  };
}

test('a delivered final report releases the helper thread exactly once', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const taskId = f.record('lead').task.taskId;
    const done = await f.finish(lead);
    assert.equal(done.state, 'idle', 'a persistent name returns to idle');
    assert.equal(done.task.state, 'completed');
    assert.deepEqual(f.releases.map(item => item.taskId), [taskId], 'the target is asked once, for this task');
    assert.equal(done.releaseState.taskId, taskId);
    assert.equal(done.releaseState.state, 'complete');
    assert.equal(done.releaseState.attempts, 1);
    assert.equal(done.releaseState.nextCheckAt, undefined, 'a proven release schedules nothing');
    assert.equal(typeof done.releaseState.ticket, 'string');
    assert.equal(f.codex.loaded(lead.threadId), false, 'the thread is no longer loaded');
    // A finished name is not polled and nothing reloads the thread it just released.
    const before = f.codex.calls();
    await f.poll(lead);
    assert.equal(f.codex.calls(), before, 'a terminal poll issues no RPC at all');
    assert.equal(f.codex.methods().includes('thread/resume'), false, 'no read resumes a cold thread');
  } finally { f.service.close(); }
});

test('a released thread resumes for the next task with the same selection', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.', { model: 'luna', effort: 'low' });
    const pinned = f.record('lead').modelPin;
    await f.finish(lead);
    assert.equal(f.codex.loaded(lead.threadId), false);

    // The same name is given more work: the resume path is the only thing that has to
    // bring the thread back, and the pinned selection must survive it.
    await f.service.send({ name: 'lead', message: 'Now do the next ten.' }, extra(BOSS));
    await f.poll(lead);
    assert.equal(f.codex.methods().includes('thread/resume'), true, 'the cold thread is resumed');
    assert.equal(f.codex.loaded(lead.threadId), true);
    const starts = f.codex.inputs('turn/start');
    assert.equal(starts.length, 2, 'the second task starts its own turn on the same thread');
    assert.deepEqual([starts[1].params.model, starts[1].params.effort], ['gpt-6-luna', 'low'], 'the frozen model is unchanged');
    assert.deepEqual(f.record('lead').modelPin, pinned);
    assert.equal(f.releases.length, 1, 'the new round has not finished, so nothing is released again');
  } finally { f.service.close(); }
});

test('a waiting release is recorded and never blocks the next task', async () => {
  const f = await fixture({ release: 'waiting' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const done = await f.finish(lead);
    assert.equal(done.state, 'idle');
    assert.equal(done.releaseState.state, 'waiting');
    assert.equal(done.releaseState.attempts, 1);
    assert.ok(done.releaseState.nextCheckAt > Date.now(), 'the next ask is throttled');
    assert.equal(done.nextAttemptAt, done.releaseState.nextCheckAt,
      'the shared sweep schedules on the name’s own retry field');
    assert.equal(f.codex.loaded(lead.threadId), true, 'a waiting answer keeps the thread loaded');

    await f.service.send({ name: 'lead', message: 'Now do the next ten.' }, extra(BOSS));
    await f.poll(lead);
    assert.equal(f.codex.inputs('turn/start').length, 2, 'the new task is dispatched as usual');
  } finally { f.service.close(); }
});

test('a deferred release keeps the record and does not retry inside the throttle', async () => {
  const f = await fixture({ release: 'deferred' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const done = await f.finish(lead);
    assert.equal(done.releaseState.state, 'deferred');
    assert.match(done.releaseState.reason, /guard/);
    const asked = f.releases.length;
    await f.poll(lead); await f.poll(lead);
    assert.equal(f.releases.length, asked, 'a throttled release is not asked again');
  } finally { f.service.close(); }
});

test('a verification cancellation without a final report is released', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    // An ordinary reply is not a report: this round ends with nothing submitted.
    f.codex.endTurn(lead.threadId, 'still working');
    await f.poll(lead);
    assert.equal(f.record('lead').state, 'awaiting_report');
    assert.equal(f.releases.length, 0, 'a live round is never released');

    await f.service.cancel({ name: 'lead' }, extra(BOSS));
    await f.poll(lead); await f.poll(lead);
    const done = f.record('lead');
    assert.equal(done.state, 'cancelled');
    assert.equal(done.task.cancelVerified, true);
    assert.equal(f.releases.length, 1, 'the verified cancellation releases the thread');
  } finally { f.service.close(); }
});

test('the shared sweep sleeps to the release due time, then asks only the release', async () => {
  const f = await fixture({ release: 'waiting' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const done = await f.finish(lead);
    const due = done.nextAttemptAt;

    // While it waits the sweep reports no work and names the exact moment instead of
    // spinning on a finished name.
    assert.equal(await f.service.monitorScan({ sweep: true, force: true }), false, 'a waiting release is not work');
    assert.equal(f.service.releaseWakeAt(), due);
    assert.equal(f.releases.length, 1, 'nothing is asked before the due time');
    const before = f.codex.calls();
    await f.poll(lead);
    assert.equal(f.releases.length, 1, 'an early poll does not ask again');
    assert.equal(f.codex.calls(), before, 'and reads nothing');

    // The due moment arrives: one release call, and no conversation read at all.
    const record = f.record('lead');
    record.nextAttemptAt = Date.now() - 1;
    record.releaseState.nextCheckAt = record.nextAttemptAt;
    f.store.save(record);
    const beforeDue = f.codex.calls();
    await f.poll(lead);
    await f.until(() => f.releases.length === 2);
    assert.equal(f.releases.length, 2, 'the due re-check asks the target again');
    assert.equal(f.codex.calls(), beforeDue, 'the re-check reads nothing: no thread/read, no resume');
    await f.settleRelease('lead');
    assert.equal(f.record('lead').releaseState.attempts, 2);
    assert.ok(f.record('lead').nextAttemptAt > Date.now(), 'the next ask is scheduled again');
  } finally { f.service.close(); }
});

test('a slow release never holds the name lock a new task needs', async () => {
  // The reviewed defect: the poll asked the target while holding the name lock, so a
  // dispatch for the same name waited out the ten-second lock budget and failed with
  // agent-busy. The release now runs outside both the lock and the poll's in-flight map.
  const f = await fixture({ release: 'block' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    await f.finish(lead);
    assert.equal(await f.until(() => f.releaseCalls.length === 1), true, 'the release call started outside the round');
    assert.equal(f.releaseCalls[0].finished, false, 'and it is still waiting on the target');

    const started = Date.now();
    await f.service.send({ name: 'lead', message: 'Now do the next ten.' }, extra(BOSS));
    assert.ok(Date.now() - started < 5000, `the dispatch did not wait for the unload (${Date.now() - started}ms)`);

    // The dispatch invalidated the ticket, and the host's own fence agrees at the point
    // where it would send the unsubscribe.
    assert.equal(f.record('lead').releaseState, undefined, 'a new round cancels the release attempt');
    assert.equal(f.releaseCalls[0].canRelease(), false, 'the host critical-point check refuses');

    // Finishing the blocked call must not write its verdict onto the new round.
    f.openGate();
    await f.until(() => f.releaseCalls[0].finished);
    await f.settleRelease('lead');
    assert.equal(f.record('lead').releaseState, undefined, 'the late verdict is dropped, not written');
    assert.equal(f.record('lead').nextAttemptAt, undefined, 'and it never schedules itself again');

    await f.poll(lead);
    assert.equal(f.codex.inputs('turn/start').length, 2, 'the new round was dispatched normally');
  } finally { f.service.close(); }
});

test('a cancelled round refuses new questions and reports before recording them', async () => {
  const f = await fixture({ release: 'block' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    f.codex.endTurn(lead.threadId, 'still working');
    await f.poll(lead);
    await f.service.cancel({ name: 'lead' }, extra(BOSS));
    await f.poll(lead); await f.poll(lead);
    assert.equal(f.record('lead').state, 'cancelled');
    assert.equal(await f.until(() => f.releaseCalls.length === 1), true, 'the release is out');
    for (const kind of ['ask', 'report']) {
      await assert.rejects(f.service.submitToParent({ kind, message: 'Late submission' }, extra(lead.threadId)),
        { code: 'task-cancelled' });
    }
    assert.deepEqual(f.store.pendingSubmissions(lead.agentId, f.record('lead').task.taskId), []);
    assert.equal(f.releaseCalls[0].canRelease(), true);
  } finally {
    f.openGate();
    await f.settleRelease('lead');
    f.service.close();
  }
});

test('a late report accepted on a failed round is delivered before reassigning the name', async () => {
  const f = await fixture({ idleSessionCleanup: false });
  try {
    const lead = await f.start('lead', 'Do the first task.');
    const stopped = await f.fail(lead);
    assert.equal(stopped.state, 'failed');
    const accepted = await f.report(lead, 'Report accepted after the failure.');
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.taskId, stopped.task.taskId);

    const next = await f.service.send({ name: lead.name, message: 'Do the next task.' }, extra(BOSS));
    assert.equal(next.queued, true);
    assert.match(f.notices.join('\n'), /Report accepted after the failure/);
    assert.deepEqual(f.store.pendingSubmissions(lead.agentId, accepted.taskId), []);
    assert.notEqual(f.record('lead').task.taskId, accepted.taskId);
    const [previous] = f.store.historyFor(lead.agentId);
    assert.equal(previous.reports.find(report => report.message === 'Report accepted after the failure.').delivery.state, 'delivered');
    assert.equal(f.releaseCalls.length, 0, 'the cleanup switch stays off');
  } finally { f.service.close(); }
});

test('a late question on a failed round is delivered without reopening it', async () => {
  const f = await fixture({ idleSessionCleanup: false });
  try {
    const lead = await f.start('lead', 'Do the first task.');
    const stopped = await f.fail(lead);
    const writes = f.codex.inputs().length;
    const asked = await f.service.submitToParent({ kind: 'ask', message: 'Which input should I use?' }, extra(lead.threadId));
    assert.equal(asked.taskId, stopped.task.taskId);

    await f.poll(lead);
    assert.equal(f.record('lead').state, 'failed');
    assert.equal(f.record('lead').task.taskId, asked.taskId);
    const questionNotices = () => f.notices.filter(notice => notice.includes('Which input should I use?'));
    assert.equal(questionNotices().length, 1);
    assert.doesNotMatch(questionNotices()[0], /futureaide_answer_agent/);
    await assert.rejects(f.answer(lead, 'Use the backup input.'), { code: 'round-finished' });
    assert.equal(f.codex.inputs().length, writes);

    const sent = await f.service.send({ name: lead.name, message: 'Begin the next task.' }, extra(BOSS));
    assert.equal(sent.queued, true);
    assert.notEqual(f.record('lead').task.taskId, asked.taskId);
    assert.equal(questionNotices().length, 1);
    assert.deepEqual(f.store.pendingSubmissions(lead.agentId, asked.taskId), []);
    assert.equal(f.store.historyTask(lead.agentId, asked.taskId).state, 'failed');
  } finally { f.service.close(); }
});

test('a callback committed on another connection during reassignment is delivered on its original round', async () => {
  let submitDuringModels;
  const f = await fixture({ rosterOnDisk: true, onModels: () => {
    const submit = submitDuringModels;
    submitDuringModels = undefined;
    submit?.();
  } });
  const peer = new RosterStore(f.roster);
  try {
    const lead = await f.start('lead', 'Do the first task.');
    const stopped = await f.fail(lead);
    assert.equal(stopped.state, 'failed');
    let receipt;
    submitDuringModels = () => { receipt = peer.submitParentMessage(lead.agentId,
      { kind: 'report', message: 'Report committed while the new model was checked.' }); };

    const next = await f.service.send({ name: lead.name, message: 'Do the next task.', model: 'luna', effort: 'low' }, extra(BOSS));
    assert.equal(next.queued, true);
    assert.equal(receipt?.accepted, true);
    assert.equal(receipt.taskId, stopped.task.taskId);
    assert.match(f.notices.join('\n'), /Report committed while the new model was checked/);
    assert.deepEqual(peer.pendingSubmissions(lead.agentId, receipt.taskId), []);
    assert.notEqual(f.record('lead').task.taskId, receipt.taskId);
    assert.equal(f.store.historyCount(lead.agentId), 1, 'the rollover commits once');
  } finally { peer.close(); f.service.close(); }
});

test('a cancelled round delivers its previously accepted report before a new task', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Old task.');
    f.codex.endTurn(lead.threadId, 'stopping');
    await f.poll(lead);
    await f.service.cancel({ name: lead.name }, extra(BOSS));
    await f.poll(lead); await f.poll(lead); await f.settleRelease('lead');
    const stopped = f.record('lead');
    assert.equal(stopped.state, 'cancelled');
    f.store.enqueueSubmission({ id: 'older-accepted-report', ownerId: stopped.ownerId, agentId: lead.agentId,
      taskId: stopped.task.taskId, kind: 'report', message: 'Already accepted on the cancelled task.' });

    assert.equal((await f.service.send({ name: lead.name, message: 'New task.' }, extra(BOSS))).queued, true);
    assert.match(f.notices.join('\n'), /Already accepted on the cancelled task/);
    assert.deepEqual(f.store.pendingSubmissions(lead.agentId, stopped.task.taskId), []);
    assert.notEqual(f.record('lead').task.taskId, stopped.task.taskId);
  } finally { f.service.close(); }
});

test('an unhinted monitor drains old-task callbacks without attaching them to the new task', async () => {
  const f = await fixture({ idleSessionCleanup: false });
  try {
    const lead = await f.start('lead', 'Old task.');
    f.codex.endTurn(lead.threadId, 'stopping');
    await f.poll(lead);
    await f.service.cancel({ name: lead.name }, extra(BOSS));
    await f.poll(lead); await f.poll(lead);
    const stopped = f.record('lead');
    assert.equal(stopped.state, 'cancelled');
    await assert.rejects(f.report(lead, 'Too late.'), { code: 'task-cancelled' });
    await f.service.send({ name: lead.name, message: 'New task.' }, extra(BOSS));
    const newTaskId = f.record('lead').task.taskId;
    assert.notEqual(newTaskId, stopped.task.taskId);

    // Restore rows a former build accepted before moving the name to the next task.
    f.store.enqueueSubmission({ id: 'legacy-report', ownerId: stopped.ownerId, agentId: lead.agentId,
      taskId: stopped.task.taskId, kind: 'report', message: 'Recovered final from the old task.', final: true });
    f.store.enqueueSubmission({ id: 'legacy-question', ownerId: stopped.ownerId, agentId: lead.agentId,
      taskId: stopped.task.taskId, kind: 'ask', message: 'Recovered question from the old task.' });
    const peer = f.second();
    await peer.service.monitorScan({ sweep: false });
    await peer.service.drainPolls();

    assert.deepEqual(f.store.pendingSubmissions(lead.agentId, stopped.task.taskId), []);
    const recovered = f.notices.filter(text => text.includes('from the old task.'));
    assert.equal(recovered.length, 2);
    assert.doesNotMatch(recovered.join('\n'), /futureaide_answer_agent/);
    assert.equal(f.record('lead').task.taskId, newTaskId);
    assert.equal(f.record('lead').task.reports?.some(report => report.final), false);
    const receipt = await f.service.submitToParent({ kind: 'ask', message: 'Question from the new task.' }, extra(lead.threadId));
    assert.equal(receipt.taskId, newTaskId);
    await f.poll(lead);
    assert.match(f.notices.join('\n'), /Question from the new task\.[\s\S]*futureaide_answer_agent/);
  } finally { f.service.close(); }
});

test('a prior task submission in a pre-upgrade roster keeps its notice through a retry', async () => {
  let refuse = true;
  const f = await fixture({ rosterOnDisk: true, onNotice: text => {
    if (refuse && text.includes('Prior task report.')) return { isError: true };
  } });
  try {
    const lead = await f.start('lead', 'Old task.');
    const stopped = await f.finish(lead);
    await f.service.send({ name: lead.name, message: 'New task.' }, extra(BOSS));

    f.store.enqueueSubmission({ id: 'pre-upgrade-report', ownerId: stopped.ownerId, agentId: lead.agentId,
      taskId: stopped.task.taskId, kind: 'report', message: 'Prior task report.' });
    // The former schema can hold the accepted row without any delivery state.
    f.store.db.exec('DROP INDEX IF EXISTS submissions_debt; ALTER TABLE submissions DROP COLUMN delivery');
    const reopened = new RosterStore(f.roster);
    reopened.close();

    const monitor = f.second().service;
    await monitor.monitorScan({ sweep: false });
    await monitor.drainPolls();
    const [pending] = f.store.pendingSubmissions(lead.agentId, stopped.task.taskId);
    assert.equal(pending.delivery.state, 'pending');
    const first = f.notices.filter(text => text.includes('Prior task report.'));
    assert.equal(first.length, 1);
    await monitor.monitorScan({ sweep: false });
    await monitor.drainPolls();
    assert.equal(f.notices.filter(text => text.includes('Prior task report.')).length, 1);

    refuse = false;
    f.store.saveSubmissionDelivery(pending.id, { ...pending.delivery, nextAttemptAt: 0 });
    const restarted = f.second().service;
    await restarted.monitorScan({ sweep: false });
    await restarted.drainPolls();
    const [delivered] = f.store.submissions(lead.agentId, stopped.task.taskId)
      .filter(item => item.id === pending.id);
    assert.equal(delivered.delivery.state, 'delivered');
    assert.deepEqual(f.store.pendingSubmissions(lead.agentId, stopped.task.taskId), []);
    assert.deepEqual(f.notices.filter(text => text.includes('Prior task report.')), [first[0], first[0]]);
  } finally { f.service.close(); }
});

test('a consumed question still blocks rollover after the helper read fails', async () => {
  const body = 'Accepted before the helper read failed.';
  let refuse = true;
  const f = await fixture({ onNotice: text => text.includes(body) && refuse ? { isError: true } : undefined });
  try {
    const lead = await f.start('lead', 'First task.');
    const receipt = await f.service.submitToParent({ kind: 'ask', message: body }, extra(lead.threadId));
    f.codex.setMissing(true);
    await f.poll(lead);
    assert.equal(f.record('lead').state, 'failed');
    assert.deepEqual(f.store.pendingSubmissions(lead.agentId, receipt.taskId), [], 'the inbox row was absorbed');
    const [pending] = f.store.submissionWork(lead.agentId, receipt.taskId);
    assert.equal(pending.message, body);
    assert.equal(pending.delivery.state, 'pending', 'the parent declined the first write');
    await assert.rejects(f.service.send({ name: lead.name, message: 'Second task.' }, extra(BOSS)),
      { code: 'previous-delivery-pending', count: 1 });
    assert.equal(f.record('lead').task.taskId, receipt.taskId);

    refuse = false;
    f.codex.setMissing(false);
    f.codex.endTurn(lead.threadId, 'now the old profile can be read again');
    f.store.saveSubmissionDelivery(pending.id, { ...pending.delivery, nextAttemptAt: 0 });
    assert.equal((await f.service.send({ name: lead.name, message: 'Second task.' }, extra(BOSS))).queued, true);
    const [delivered] = f.store.submissions(lead.agentId, receipt.taskId);
    assert.equal(delivered.delivery.state, 'delivered');
    assert.equal(delivered.message, body);
    const attempts = f.notices.filter(text => text.includes(body));
    assert.equal(attempts.length, 2, 'only one write was accepted');
    assert.ok(attempts.every(text => text.includes(`<!-- futureaide-control:${submissionNoticeId(receipt.submissionId)} -->`)));
    assert.notEqual(f.record('lead').task.taskId, receipt.taskId);
  } finally { f.service.close(); }
});

test('a final accepted after a Codex profile miss reaches the parent and does not leave delivery debt', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'First task.');
    f.codex.setMissing(true);
    await f.poll(lead);
    assert.equal(f.record('lead').state, 'failed');
    const receipt = await f.report(lead, 'Final preserved from the missing profile.', true);
    assert.equal(receipt.accepted, true);
    await f.poll(lead);
    await f.poll(lead);
    const [delivered] = f.store.submissions(lead.agentId, receipt.taskId);
    assert.equal(delivered.delivery.state, 'delivered');
    assert.equal(f.store.submissionDebt(lead.agentId, receipt.taskId), 0);
    const notices = f.notices.filter(text => text.includes(delivered.message));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /任务树无法确认：线程不在当前 Codex 档案/);
    assert.equal(f.record('lead').task.reports.find(report => report.final).treeSettledConfirmed, undefined);
    await assert.rejects(f.service.send({ name: lead.name, message: 'Second task.' }, extra(BOSS)),
      { code: 'codex-thread-not-found' });
    assert.deepEqual(await f.service.cancel({ name: lead.name }, extra(BOSS)),
      { name: lead.name, accepted: false, state: 'failed' });

    f.codex.setMissing(false);
    // Older monitors could leave a cancellation pending after recording the profile miss.
    const legacy = f.record('lead');
    legacy.task.cancelRequested = legacy.task.cancelPending = true;
    legacy.state = 'running';
    f.store.db.prepare('UPDATE agents SET body=? WHERE id=?').run(JSON.stringify(legacy), lead.agentId);
    await f.poll(lead);
    assert.equal(f.record('lead').state, 'failed');
    await assert.rejects(f.service.send({ name: lead.name, message: 'Second task.' }, extra(BOSS)),
      { code: 'previous-task-unsettled', retryable: true });
    f.codex.endTurn(lead.threadId, 'the old thread is available');
    assert.equal((await f.service.send({ name: lead.name, message: 'Second task.' }, extra(BOSS))).queued, true);
    assert.notEqual(f.record('lead').task.taskId, receipt.taskId);
    assert.equal(f.notices.filter(text => text.includes(delivered.message)).length, 1);
  } finally { f.service.close(); }
});

test('a restored profile never replays a legacy failed task when historical inbox work wakes the monitor', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('release-315', 'The earlier round.');
    const earlier = await f.finish(lead);
    const [oldSubmission] = f.store.submissions(lead.agentId, earlier.task.taskId);
    const priorWrites = f.codex.inputs().length;
    const priorNotices = f.notices.length;
    const obsolete = 'An obsolete task from the missing profile.';
    assert.equal((await f.service.send({ name: lead.name, message: obsolete }, extra(BOSS))).queued, true);
    const legacy = f.record(lead.name);
    // Before the upgrade the terminal record had no treeUnavailable marker and no
    // dispatch for this round. Its one failure notice had already been delivered.
    legacy.state = legacy.task.state = 'failed';
    legacy.task.startedAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    legacy.error = { code: 'codex-thread-not-found',
      message: `The Codex thread ${lead.threadId} is not visible in the current profile.` };
    legacy.observation = { ...legacy.observation, stale: true };
    legacy.task.reports = [{ id: 'legacy-failure', taskId: legacy.task.taskId, failure: true, final: false,
      message: 'The thread was not visible in the profile.', createdAt: legacy.task.startedAt,
      delivery: { id: 'legacy-failure-notice', state: 'delivered', createdAt: legacy.task.startedAt } }];
    assert.deepEqual(legacy.task.dispatches, []);
    assert.equal(legacy.task.treeUnavailable, undefined);
    f.codex.setMissing(true);
    f.store.save(legacy);
    // A consumed row from the earlier round was migrated without a delivery value.
    // It makes the normal unhinted sweep select the otherwise dormant failed name.
    f.store.db.prepare('UPDATE submissions SET delivery=NULL WHERE id=?').run(oldSubmission.id);
    assert.ok(f.store.pendingSubmissionAgents().some(item => item.agentId === lead.agentId && item.dueAt === 0));

    f.codex.setMissing(false);
    const monitor = f.second().service;
    await monitor.monitorScan();
    await monitor.drainPolls();
    assert.equal(f.codex.inputs().length, priorWrites, 'the restored profile never sends the old task');
    assert.equal(f.record(lead.name).state, 'failed');
    assert.equal(f.record(lead.name).error.code, 'codex-thread-not-found');
    assert.deepEqual(f.record(lead.name).task.dispatches, []);
    assert.equal(f.record(lead.name).task.message, obsolete);
    assert.equal(f.store.submissionDebt(lead.agentId), 0);
    assert.equal(f.notices.length, priorNotices, 'the earlier final was already delivered');

    const fresh = 'The newly requested task.';
    assert.equal((await f.service.send({ name: lead.name, message: fresh }, extra(BOSS))).queued, true);
    await f.poll(lead);
    const current = f.record(lead.name);
    assert.notEqual(current.task.taskId, legacy.task.taskId);
    assert.equal(current.task.dispatches[0].accepted, true);
    const newWrites = f.codex.inputs().slice(priorWrites);
    assert.equal(newWrites.length, 1);
    assert.match(newWrites[0].params.input[0].text, /The newly requested task/);
    assert.equal(f.store.historyTask(lead.agentId, legacy.task.taskId).message, obsolete);
  } finally { f.service.close(); }
});

test('an aged Codex dispatch with a native receipt is reconciled without sending again', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Work that Codex already accepted.');
    const record = f.record(lead.name);
    const dispatch = record.task.dispatches[0];
    // The worker can stop between a durable native receipt and the roster save.
    // Keep that receipt intact and restore the earlier roster-side sending intent.
    record.task.startedAt = new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString();
    dispatch.state = 'sending';
    delete dispatch.accepted;
    f.store.save(record);
    const before = f.codex.inputs().length;

    await f.poll(lead);
    const reconciled = f.record(lead.name);
    assert.equal(reconciled.state, 'running');
    assert.equal(reconciled.task.dispatches[0].requestId, dispatch.requestId);
    assert.equal(reconciled.task.dispatches[0].accepted, true);
    assert.equal(reconciled.task.expired, undefined);
    assert.equal(f.codex.inputs().length, before, 'the accepted native request is read back, not replayed');
  } finally { f.service.close(); }
});

test('explicit cleanup proceeds after a profile miss', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Task in another profile.');
    f.codex.setMissing(true);
    await f.poll(lead);
    assert.equal(f.record(lead.name).task.treeUnavailable, 'codex-thread-not-found');
    assert.equal((await f.service.delete({ name: lead.name }, extra(BOSS))).state, 'cleaning');
    assert.equal((await f.poll(lead)).deleted, true);
    assert.equal(f.record(lead.name), undefined);
  } finally { f.service.close(); }
});

test('an archived delivered final consumes its legacy pending row without writing a second notice', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'First task.');
    const done = await f.finish(lead);
    const [item] = f.store.submissions(lead.agentId, done.task.taskId);
    assert.equal(item.delivery.state, 'delivered');
    await f.service.send({ name: lead.name, message: 'Second task.' }, extra(BOSS));
    // A former monitor delivered the report via its task-body notice but left
    // the original inbox row pending. Only its old marker is in the archive.
    f.store.db.prepare("UPDATE agent_history SET body=json_set(body,'$.reports[0].delivery.id','old-report-notice') WHERE agent=?")
      .run(lead.agentId);
    f.store.db.prepare("UPDATE submissions SET state='pending', consumed=NULL, delivery=NULL WHERE id=?").run(item.id);
    const peer = f.second().service;
    await peer.monitorScan({ sweep: false });
    await peer.drainPolls();

    assert.equal(f.notices.filter(text => text.includes(item.message)).length, 1);
    const [settled] = f.store.submissions(lead.agentId, done.task.taskId);
    assert.equal(settled.delivery.id, submissionNoticeId(item.id));
    assert.equal(settled.delivery.state, 'delivered');
    assert.equal(f.store.submissionDebt(lead.agentId, done.task.taskId), 0);
  } finally { f.service.close(); }
});

for (const deliveredBeforeCancel of [false, true]) {
  test(deliveredBeforeCancel ? 'cancellation adopts the notice an older observation already delivered'
    : 'cancelling between absorption and the first notice still settles the accepted question once', async () => {
    const f = await fixture();
    try {
      const lead = await f.start('lead', 'Task with a question.');
      const body = 'An accepted question around cancellation.';
      const receipt = await f.service.submitToParent({ kind: 'ask', message: body }, extra(lead.threadId));
      if (deliveredBeforeCancel) {
        const record = f.record(lead.name);
        record.task.questionNotices = { [submissionRef(receipt.submissionId)]: {
          id: 'old-observation-notice', state: 'delivered', createdAt: new Date().toISOString(),
        } };
        f.notices.push(`${body}\n<!-- futureaide-control:old-observation-notice -->`);
        f.store.save(record);
        await f.service.cancel({ name: lead.name }, extra(BOSS));
      } else {
        const consume = f.store.saveAndConsumeSubmissions.bind(f.store);
        f.store.saveAndConsumeSubmissions = (record, ids) => {
          consume(record, ids);
          assert.ok(ids.includes(receipt.submissionId));
          assert.equal(f.store.requestCancel(record), true);
          f.store.saveAndConsumeSubmissions = consume;
        };
      }
      await f.poll(lead); await f.poll(lead); await f.settleRelease(lead.name);
      const [settled] = f.store.submissions(lead.agentId, receipt.taskId);
      assert.equal(settled.delivery.state, 'delivered');
      assert.equal(settled.delivery.id, submissionNoticeId(receipt.submissionId));
      assert.equal(f.notices.filter(text => text.includes(body)).length, 1);
      assert.equal(f.store.submissionDebt(lead.agentId, receipt.taskId), 0);
    } finally { f.service.close(); }
  });
}

test('a restarted monitor confirms a write that landed before its delivery state was saved', async () => {
  const f = await fixture({ rosterOnDisk: true, ownerHistory: () => f.notices });
  let peerStore;
  try {
    const lead = await f.start('lead', 'Report before a restart.');
    const body = 'A report received before the monitor went away.';
    const receipt = await f.report(lead, body);
    const saveDelivery = f.store.saveSubmissionDelivery.bind(f.store);
    f.store.saveSubmissionDelivery = (id, notice, options) => {
      if (id === receipt.submissionId && notice.state === 'delivered') throw new Error('monitor exited before recording the receipt');
      return saveDelivery(id, notice, options);
    };
    await f.poll(lead);
    assert.equal(f.notices.filter(text => text.includes(body)).length, 1);
    const [interrupted] = f.store.submissionWork(lead.agentId, receipt.taskId);
    assert.equal(interrupted.delivery.state, 'sending');

    peerStore = new RosterStore(f.roster);
    peerStore.saveSubmissionDelivery(interrupted.id, { ...interrupted.delivery, nextAttemptAt: 0 },
      { expected: interrupted.deliveryVersion });
    const restarted = f.second(peerStore).service;
    await restarted.monitorScan({ sweep: false });
    await restarted.drainPolls();
    const [settled] = peerStore.submissions(lead.agentId, receipt.taskId);
    assert.equal(settled.delivery.state, 'delivered');
    assert.equal(settled.delivery.recovered, true);
    assert.equal(settled.message, body);
    assert.equal(f.notices.filter(text => text.includes(body)).length, 1);
  } finally { peerStore?.close(); f.service.close(); }
});

for (const missingTree of [false, true]) {
  test(missingTree ? 'an unhinted monitor restart delivers a final after the profile miss was saved'
    : 'an unhinted monitor sweep observes the tree while a final is waiting and a progress notice is in backoff', async () => {
    const progress = 'Progress with no write receipt.';
    const f = await fixture({ rosterOnDisk: true, onNotice: text => {
      if (text.includes(progress)) throw new Error('owner write outcome unknown');
    } });
    let peerStore;
    try {
      const lead = await f.start('lead', 'End the native turn after submitting the final.');
      const interim = await f.report(lead, progress);
      const body = 'The accepted final can now be delivered.';
      const final = await f.report(lead, body, true);
      await f.poll(lead);
      const work = f.store.submissionWork(lead.agentId, final.taskId);
      const waiting = work.find(item => item.id === final.submissionId);
      assert.equal(waiting.delivery.waitingForTree, true);
      assert.equal(f.notices.filter(text => text.includes(body)).length, 0);
      const old = work.find(item => item.id === interim.submissionId);
      const record = f.record(lead.name);
      const deferred = { ...old.delivery, nextAttemptAt: Date.now() + 60000 };
      record.task.reports.find(report => report.id === submissionRef(interim.submissionId)).delivery = deferred;
      if (missingTree) {
        record.state = record.task.state = 'failed';
        record.task.treeUnavailable = 'codex-thread-not-found';
        f.codex.setMissing(true);
      } else f.codex.endTurn(lead.threadId, 'The old turn ended.');
      assert.equal(f.store.saveSubmissionDelivery(old.id, deferred, { expected: old.deliveryVersion, record }), true);
      peerStore = new RosterStore(f.roster);
      const restarted = f.second(peerStore).service;
      await restarted.monitorScan();
      await restarted.drainPolls();
      const result = peerStore.submissions(lead.agentId, final.taskId).find(item => item.id === final.submissionId);
      assert.equal(result.delivery.state, 'delivered');
      const notices = f.notices.filter(text => text.includes(body));
      assert.equal(notices.length, 1);
      if (missingTree) assert.match(notices[0], /任务树无法确认：线程不在当前 Codex 档案/);
      assert.equal(f.notices.filter(text => text.includes(progress)).length, 1, 'the unrelated notice keeps its backoff');
    } finally { peerStore?.close(); f.service.close(); }
  });
}

for (const release of ['waiting', 'complete']) {
  test(`an unhinted sweep processes persisted inbox work after a release is ${release}`, async () => {
    const f = await fixture({ release });
    try {
      const lead = await f.start('lead', 'Fix the ten places.');
      f.codex.endTurn(lead.threadId, 'still working');
      await f.poll(lead);
      await f.service.cancel({ name: 'lead' }, extra(BOSS));
      await f.poll(lead); await f.poll(lead); await f.settleRelease('lead');
      const done = f.record('lead');
      assert.equal(done.state, 'cancelled');
      assert.equal(done.releaseState.state, release);
      if (release === 'waiting') {
        done.nextAttemptAt = done.releaseState.nextCheckAt = Date.now() + 300000;
        f.store.save(done);
      }

      // Old builds could persist these even after cancellation. The inbox already
      // owns both rows, so a normal worker sweep must settle them without a name hint.
      for (const [kind, message] of [['ask', 'Obsolete question'], ['report', 'Persisted report']]) {
        f.store.enqueueSubmission({ id: `old-${kind}`, ownerId: done.ownerId, agentId: done.agentId,
          taskId: done.task.taskId, kind, message });
      }
      const peer = f.second();
      await peer.service.monitorScan({ force: true });
      await peer.service.drainPolls();
      assert.deepEqual(f.store.pendingSubmissions(lead.agentId, done.task.taskId), []);
      assert.match(f.notices.join('\n'), /Persisted report/);
      assert.match(f.notices.join('\n'), /旧轮次提问：\nObsolete question/);
      assert.doesNotMatch(f.notices.join('\n'), /futureaide_answer_agent/);
      assert.equal(f.record('lead').state, 'cancelled');
    } finally { f.service.close(); }
  });
}

for (const alreadySleeping of [false, true]) {
  test(alreadySleeping ? 'an unhinted worker round wakes a name with a pending callback'
    : 'a callback committed before the sleep write keeps the name awake', async () => {
    const f = await fixture();
    try {
      const lead = await f.start('lead', 'Wait for the parent.');
      f.codex.endTurn(lead.threadId, 'waiting');
      await f.poll(lead);
      const record = f.record('lead');
      assert.equal(record.state, 'awaiting_report');
      f.store.claimLease('idle-monitor', 'fixture-monitor', 60000);
      f.store.claimLease('idle-monitor:ready', 'fixture-monitor', 60000);
      if (alreadySleeping) assert.equal(await f.service.trySleep(lead.agentId), true);

      // This is the durable write a separate MCP process can make after the
      // worker's last poll. No name hint accompanies the row in this fixture.
      f.store.enqueueSubmission({ id: 'late-ask', ownerId: record.ownerId, agentId: lead.agentId,
        taskId: record.task.taskId, kind: 'ask', message: 'Which file should I use?' });
      if (!alreadySleeping) assert.equal(await f.service.trySleep(lead.agentId), false);
      const peer = f.second();
      await peer.service.monitorScan({ sweep: false, force: true });
      await peer.service.drainPolls();
      assert.deepEqual(f.store.pendingSubmissions(lead.agentId, record.task.taskId), []);
      assert.match(f.notices.join('\n'), /Which file should I use\?/);
    } finally { f.service.close(); }
  });
}

test('a guard that keeps refusing is re-asked at a longer interval, never lost', async () => {
  // A watched thread is not a failed unload: past the first attempts the re-check keeps a
  // wider, still bounded, spacing instead of going quiet for ever.
  const f = await fixture({ release: 'deferred', releaseReason: 'release-unsubscribe-inUse' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    await f.finish(lead);
    let rounds = 0;
    while (rounds < RELEASE_ATTEMPT_CAP + 2) {
      const record = f.record('lead');
      assert.notEqual(record.nextAttemptAt, undefined, 'the name stays scheduled');
      record.nextAttemptAt = Date.now() - 1;
      record.releaseState.nextCheckAt = record.nextAttemptAt;
      f.store.save(record);
      await f.poll(lead);
      await f.settleRelease('lead');
      rounds += 1;
    }
    const done = f.record('lead');
    assert.ok(done.releaseState.attempts > RELEASE_ATTEMPT_CAP, 'it is asked again past the first cap');
    assert.equal(done.releaseState.state, 'deferred');
    assert.equal(done.nextAttemptAt, done.releaseState.nextCheckAt, 'and stays scheduled');
    const delay = done.releaseState.nextCheckAt - Date.now();
    assert.ok(delay > RELEASE_RECHECK_MS, `the interval backs off (${delay}ms)`);
    assert.ok(delay <= RELEASE_LONG_RECHECK_MS, 'but stays bounded');
  } finally { f.service.close(); }
});

test('a listed one-shot releases its thread, a completed one keeps its delete path', async () => {
  const f = await fixture();
  try {
    // A one-shot that never completed stays listed for ever today, with its thread loaded.
    await f.service.create({ name: 'solo', lifetime: 'once', target: 'codex-desktop' }, extra(BOSS));
    await f.service.send({ name: 'solo', message: 'Fix one place.' }, extra(BOSS));
    const solo = { name: 'solo', agentId: f.record('solo').agentId };
    await f.service.poll(solo.agentId);
    const [threadId] = f.codex.threadIds();
    f.codex.endTurn(threadId, 'still working');
    await f.service.poll(solo.agentId);
    await f.service.cancel({ name: 'solo' }, extra(BOSS));
    await f.service.poll(solo.agentId); await f.service.poll(solo.agentId);
    assert.equal(f.record('solo').state, 'cancelled');
    assert.equal(f.releases.length, 1, 'the listed one-shot releases the thread nobody will use again');
    assert.equal(f.codex.loaded(threadId), false);

    // A completed one-shot is deleted by its own cleanup path, so it is never released.
    await f.service.create({ name: 'duty', lifetime: 'once', target: 'codex-desktop' }, extra(BOSS));
    await f.service.send({ name: 'duty', message: 'Fix the other place.' }, extra(BOSS));
    const duty = { name: 'duty', agentId: f.record('duty').agentId };
    await f.service.poll(duty.agentId);
    const dutyThread = f.codex.threadIds().find(id => id !== threadId);
    await f.service.submitToParent({ kind: 'report', message: 'Fixed.', final: true }, extra(dutyThread));
    f.codex.endTurn(dutyThread, 'fixed');
    await f.service.poll(duty.agentId); await f.service.poll(duty.agentId);
    assert.equal(f.releases.length, 1, 'the delete path owns a completed one-shot');
    assert.equal(f.record('duty'), undefined, 'the name is cleaned up as before');
  } finally { f.service.close(); }
});

test('a one-shot keeps the body of a blocked callback when its final is delivered', async () => {
  const body = 'Preserve this unconfirmed progress report.';
  const f = await fixture({ onNotice: text => {
    if (text.includes(body)) throw new Error('owner write outcome unknown');
  } });
  try {
    const lead = await f.start('lead', 'One task with a progress report.', { lifetime: 'once' });
    const receipt = await f.report(lead, body);
    await f.poll(lead);
    const [pending] = f.store.submissionWork(lead.agentId, receipt.taskId);
    assert.equal(pending.delivery.state, 'unknown');
    assert.equal(f.store.saveSubmissionDelivery(pending.id, { ...pending.delivery, nextAttemptAt: 0,
      attemptedAt: new Date(Date.now() - 31 * 60000).toISOString() }, { expected: pending.deliveryVersion }), true);
    await f.poll(lead);
    const done = await f.finish(lead);
    assert.equal(done.state, 'idle');
    assert.equal(done.task.autoCleanupHeld, true);
    const rows = f.store.submissions(lead.agentId, receipt.taskId);
    assert.equal(rows.find(item => item.id === receipt.submissionId).delivery.state, 'blocked');
    assert.equal(rows.find(item => item.id === receipt.submissionId).message, body);
    assert.equal(rows.find(item => item.final).delivery.state, 'delivered');
    assert.equal(f.notices.filter(text => text.includes(body)).length, 1);
    assert.equal(f.notices.filter(text => text.includes('All ten fixed.')).length, 1);
    assert.equal(f.codex.methods().includes('thread/delete'), false);
  } finally { f.service.close(); }
});

test('a child callback accepted during its parent final holds automatic tree cleanup', async () => {
  let submitChild;
  const f = await fixture({ onNotice: text => { if (text.includes('All ten fixed.')) submitChild?.(); } });
  try {
    const lead = await f.start('lead', 'One parent task.', { lifetime: 'once' });
    const parent = extra(lead.threadId);
    await f.service.create({ name: 'child', lifetime: 'persistent', target: 'codex-desktop' }, parent);
    await f.service.send({ name: 'child', message: 'Child task.' }, parent);
    const childId = f.store.named(ownerIdFor(lead.threadId), 'child').agentId;
    await f.service.poll(childId);
    const childThread = f.codex.threadIds().at(-1);
    f.codex.endTurn(childThread, 'The child stopped.');
    await f.service.poll(childId);
    const child = f.store.get(childId);
    child.state = child.task.state = 'failed';
    child.task.dispatches.at(-1).state = 'failed';
    f.store.save(child);
    assert.equal(child.observation.tree.settled, true);
    const body = 'Accepted from the child during its parent final.';
    let receipt;
    submitChild = () => {
      receipt = f.store.submitParentMessage(childId, { kind: 'report', message: body });
      submitChild = undefined;
    };
    const held = await f.finish(lead);
    assert.equal(receipt?.accepted, true);
    assert.equal(held.state, 'delivery_pending');
    assert.equal(f.store.submissionDebt(childId), 1);
    held.task.dispatches.at(-1).state = 'completed';
    f.store.save(held);
    f.store.claimLease('idle-monitor', 'fixture-monitor', 60000);
    f.store.claimLease('idle-monitor:ready', 'fixture-monitor', 60000);
    assert.equal(await f.service.trySleep(lead.agentId), false);
    await f.service.poll(childId);
    assert.equal(f.store.submissions(childId, receipt.taskId)[0].delivery.state, 'delivered');
    assert.equal(f.notices.filter(text => text.includes(body)).length, 1);
    const monitor = f.second().service;
    await monitor.monitorScan();
    await monitor.drainPolls();
    assert.equal(f.record(lead.name), undefined);
    assert.equal(f.store.get(childId), undefined);
    assert.equal(f.notices.filter(text => text.includes(body)).length, 1);
  } finally { f.service.close(); }
});

test('a reason that cannot change is not asked about again', async () => {
  // No owned binding means this build cannot ever release it: one ask, then quiet.
  const f = await fixture({ release: 'deferred', releaseReason: 'release-no-owned-binding' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const done = await f.finish(lead);
    assert.equal(done.releaseState.state, 'deferred');
    assert.equal(done.releaseState.reason, 'release-no-owned-binding');
    assert.equal(done.nextAttemptAt, undefined, 'a permanent answer is not re-scheduled');
    assert.equal(f.releases.length, 1);
    assert.equal(await f.service.monitorScan({ sweep: true, force: true }), false);
  } finally { f.service.close(); }
});

test('another target’s own retry stamp is never read as a release schedule', async () => {
  // The same field carries any target's retry, so only a full record may prove who wrote
  // it. A DSH name with its own stamp must keep it and never be asked to release.
  const store = new RosterStore(':memory:');
  const service = createScopedAgents({ stateDirectory: path.join(workspace, '.runtime', 'tests'), workspace, target: 'dsh' }, {
    store, clientFactory: () => { throw new Error('no DSH host is needed for this case'); },
    startSharedMonitor: () => true, removeTree: async () => {},
  });
  try {
    const at = new Date().toISOString(), due = Date.now() + 60000;
    store.insert({ agentId: 'agent-dsh', ownerId: 'owner-dsh', sessionId: 'session-dsh', name: 'dshy',
      lifetime: 'persistent', target: 'dsh', workspace, state: 'failed', created: true, createdAt: at, updatedAt: at,
      history: [], nextAttemptAt: due,
      task: { taskId: 'task-dsh', message: 'work', state: 'failed', startedAt: at, answers: [], reports: [],
        dispatches: [{ requestId: 'request-1', kind: 'task', state: 'failed', accepted: true }] } });

    assert.equal(await service.monitorScan({ sweep: true, force: true }), false, 'a finished DSH name is not work');
    assert.equal(service.releaseWakeAt(), undefined, 'nothing is scheduled as a release re-check');
    await service.poll('agent-dsh');
    assert.equal(store.get('agent-dsh').nextAttemptAt, due, 'the other target keeps its own schedule');
  } finally { service.close(); }
});

test('the switch off never reads or clears an old release schedule', async () => {
  const f = await fixture({ idleSessionCleanup: false });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const done = await f.finish(lead);
    assert.equal(done.releaseState, undefined, 'the switch writes no release state at all');

    // A schedule left over from before the switch was turned off must stay exactly as
    // it was: it is not evidence that this feature may act.
    const due = Date.now() + 60000;
    const record = f.record('lead');
    record.nextAttemptAt = due;
    record.releaseState = { taskId: record.task.taskId, state: 'waiting', attempts: 1, nextCheckAt: due };
    f.store.save(record);

    assert.equal(await f.service.monitorScan({ sweep: true, force: true }), false);
    assert.equal(f.service.releaseWakeAt(), undefined);
    assert.equal(await f.service.ensureIdleMonitor(), false, 'an old stamp starts no listener');
    await f.poll(lead);
    assert.equal(f.releases.length, 0, 'no release call is made while the switch is off');
    assert.equal(f.record('lead').nextAttemptAt, due, 'the stamp is left alone');

    // An ordinary retry is a different thing and keeps working: a running name with its
    // own scheduled retry still counts as work for the sweep.
    const at = new Date().toISOString();
    f.store.insert({ agentId: 'agent-ordinary', ownerId: ownerIdFor(BOSS), sessionId: 'session-ordinary',
      name: 'ordinary', lifetime: 'persistent', target: 'dsh', workspace, state: 'running', created: true,
      createdAt: at, updatedAt: at, history: [], nextAttemptAt: Date.now() + 60000,
      task: { taskId: 'task-ordinary', message: 'work', state: 'running', startedAt: at, answers: [], reports: [],
        dispatches: [{ requestId: 'request-ordinary', kind: 'task', state: 'retrying', accepted: false }] } });
    // No force: the point is that the sweep counts this name as work, not that a poll runs.
    assert.equal(await f.service.monitorScan({ sweep: true }), true,
      'an ordinary retry keeps waking the sweep');
  } finally { f.service.close(); }
});

test('a release cut off by a dead worker is picked up again at its own time', async () => {
  // A worker that dies inside the release call must not leave a finished round nobody
  // polls: the attempt keeps a bounded re-check time on the same ticket, and a different
  // process resumes the round only after that time.
  const f = await fixture({ release: 'block' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    await f.finish(lead);
    assert.equal(await f.until(() => f.releaseCalls.length === 1), true);
    const sending = f.record('lead');
    assert.equal(sending.releaseState.state, 'sending');
    assert.equal(typeof sending.nextAttemptAt, 'number', 'the attempt keeps a re-check time while it is out');
    assert.equal(sending.nextAttemptAt, sending.releaseState.nextCheckAt);
    assert.ok(sending.nextAttemptAt > Date.now());
    assert.equal(await f.service.monitorScan({ sweep: true }), false, 'a sending attempt is not busy work');
    assert.equal(f.service.releaseWakeAt(), sending.nextAttemptAt, 'but the round is still scheduled');

    // The other process polls before that moment: nothing is sent for the same round.
    const peer = f.second();
    try {
      await peer.service.poll(sending.agentId);
      assert.equal(peer.calls.length, 0, 'an early poll does not re-send for the same round');

      // Once the time is up the same round continues, on a fresh ticket.
      const due = f.record('lead');
      due.nextAttemptAt = Date.now() - 1;
      due.releaseState.nextCheckAt = due.nextAttemptAt;
      f.store.save(due);
      await peer.service.poll(sending.agentId);
      await f.until(() => peer.calls.length === 1);
      assert.equal(peer.calls.length, 1, 'the round continues after the worker died');
      assert.equal(peer.calls[0].taskId, sending.task.taskId, 'for the same round');
      assert.equal(f.releaseCalls[0].canRelease(), false, 'and the dead attempt is fenced out by the new ticket');

      // The dead attempt's own verdict is dropped when it finally arrives.
      f.openGate();
      await f.until(() => f.releaseCalls[0].finished);
      await f.settleRelease('lead');
      assert.equal(f.record('lead').releaseState.state, 'waiting', 'the peer’s verdict is the live one');
      assert.equal(f.record('lead').releaseState.ticket, peer.calls[0].ticket);
    } finally {
      try { peer.service.close(); } catch { /* the fixture owns the roster connection */ }
    }
  } finally { f.service.close(); }
});

test('the switch off keeps today behaviour: no release call at all', async () => {
  const f = await fixture({ idleSessionCleanup: false });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const done = await f.finish(lead);
    assert.equal(done.task.state, 'completed');
    assert.equal(f.releases.length, 0);
    assert.equal(done.releaseState, undefined);
    assert.equal(f.codex.loaded(lead.threadId), true);
  } finally { f.service.close(); }
});

test('a build without the release path is unchanged, not broken', async () => {
  const f = await fixture({ releaseAbsent: true });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const done = await f.finish(lead);
    assert.equal(done.task.state, 'completed');
    // One ask, a final answer, and no schedule: the ticket ends where it started.
    assert.equal(done.releaseState.state, 'deferred');
    assert.equal(done.releaseState.reason, 'release-unsupported');
    assert.equal(done.releaseState.nextCheckAt, undefined);
    assert.equal(done.nextAttemptAt, undefined);
    assert.equal(f.releases.length, 0, 'no release call is made at all');
    assert.equal(f.codex.loaded(lead.threadId), true);
  } finally { f.service.close(); }
});

test('a failing release call does not change the delivered outcome', async () => {
  const f = await fixture({ release: 'throw' });
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    const done = await f.finish(lead);
    assert.equal(done.task.state, 'completed');
    assert.equal(done.releaseState.state, 'deferred');
    assert.equal(done.releaseState.reason.code, 'operation-failed');
    assert.match(f.notices.at(-1), /All ten fixed\./, 'the caller still receives the final report');
  } finally { f.service.close(); }
});

// The gate itself. These cases pin the states a finished round can and cannot end in,
// so a later change to the state machine cannot quietly start releasing a live round.
const record = overrides => ({
  agentId: 'agent-1', ownerId: 'owner-1', name: 'lead', target: 'codex-desktop', lifetime: 'persistent',
  state: 'idle', workspace,
  task: { taskId: 'task-1', state: 'completed',
    reports: [{ id: 'report-1', final: true, delivery: { state: 'delivered' } }],
    answers: [{ answerId: 'answer-1', dispatched: true }],
    dispatches: [{ requestId: 'request-1', kind: 'task', state: 'completed', accepted: true }] },
  observation: { activity: 'idle', tree: { settled: true, running: false } },
  ...overrides,
});

test('the gate accepts a completed, delivered, quiet round', () => {
  assert.equal(canReleaseThreads(record(), [], true), true);
  // A blocked final is a terminal delivery outcome, not a failure to clean up.
  assert.equal(canReleaseThreads(record({ task: { ...record().task,
    reports: [{ id: 'report-1', final: true, delivery: { state: 'blocked' } }] } }), [], true), true);
});

test('the gate accepts a failure or a verified cancellation that never submitted a final', () => {
  const failed = record({ state: 'failed',
    task: { taskId: 'task-1', state: 'failed', reports: [], answers: [], dispatches: [{ requestId: 'r', state: 'failed' }] } });
  // The read that would have proved the tree is exactly what failed, so the target's own
  // read-only check decides the rest.
  assert.equal(canReleaseThreads(failed, [], undefined), true);
  const cancelled = record({ state: 'cancelled',
    task: { taskId: 'task-1', state: 'cancelled', cancelVerified: true, cancelTreeSettled: true, reports: [], answers: [], dispatches: [{ requestId: 'r', state: 'cancelled' }] } });
  assert.equal(canReleaseThreads(cancelled, [], true), true);
  // An unverified cancellation may still have a turn of its own running.
  const pending = record({ state: 'cancelled',
    task: { taskId: 'task-1', state: 'cancelled', cancelRequested: true, reports: [], answers: [], dispatches: [{ requestId: 'r', state: 'cancelled' }] } });
  assert.equal(canReleaseThreads(pending, [], true), false);
});

test('the gate refuses a round that still owes a notice, an answer or a supplement', () => {
  const undelivered = overrides => record({ task: { ...record().task, ...overrides } });
  // A non-final report still on its way is work this round owes.
  assert.equal(canReleaseThreads(undelivered({
    reports: [{ id: 'report-1', final: true, delivery: { state: 'delivered' } },
      { id: 'report-2', final: false, delivery: { state: 'sending' } }] }), [], true), false);
  // A final report that never landed is why the task is not completed.
  assert.equal(canReleaseThreads(undelivered({
    reports: [{ id: 'report-1', final: true, delivery: { state: 'unknown' } }] }), [], true), false);
  // An answer the caller gave but the helper has not received.
  assert.equal(canReleaseThreads(undelivered({
    answers: [{ answerId: 'answer-1', dispatched: false }] }), [], true), false);
  // An answer that a final report already made undeliverable is not work.
  assert.equal(canReleaseThreads(undelivered({
    answers: [{ answerId: 'answer-1', dispatched: true },
      { answerId: 'answer-2', dispatched: true, undelivered: 'final-submitted' }] }), [], true), true);
  // A dispatch still on its way, including a retrying one.
  assert.equal(canReleaseThreads(undelivered({
    dispatches: [{ requestId: 'request-1', kind: 'task', state: 'retrying', accepted: false }] }), [], true), false);
  // A best-effort reminder never decides the round, exactly as the poll loop treats it.
  assert.equal(canReleaseThreads(undelivered({
    dispatches: [{ requestId: 'request-1', kind: 'task', state: 'completed' },
      { requestId: 'request-2', kind: 'supplement', reminder: true, state: 'failed' }] }), [], true), true);
  // A round sealed by its own final report keeps the dispatch state it had when the
  // helper reported: the report decided the round, not the turn.
  assert.equal(canReleaseThreads(record({ task: { ...record().task,
    dispatches: [{ requestId: 'request-1', kind: 'task', state: 'running', accepted: true }],
    reports: [{ id: 'report-1', final: true, treeSettledConfirmed: true, delivery: { state: 'delivered' } }] } }), [], true), true);
  // A queued supplement is work the caller already assigned for this task.
  assert.equal(canReleaseThreads(record(), [{ task: 'task-1', status: 'queued' }], true), false);
  assert.equal(canReleaseThreads(record(), [{ task: 'task-1', status: 'blocked' }], true), true);
  // A question that is still open is a round that has not ended.
  assert.equal(canReleaseThreads(record({ observation: { questions: [{ id: 'q1', state: 'pending' }],
    tree: { settled: true, running: false } } }), [], true), false);
});

test('the gate refuses a round whose tree has not come to rest', () => {
  assert.equal(canReleaseThreads(record(), [], false), false);
  // A completed round proved a settled tree; a stale read cannot stand in for it.
  assert.equal(canReleaseThreads(record(), [], undefined), false);
});

test('the gate covers the one-shots that stay listed and leaves the delete path alone', () => {
  const once = overrides => record({ lifetime: 'once', ...overrides });
  // A delivered final on a one-shot is deleted by its own cleanup path: no release.
  assert.equal(canReleaseThreads(once(), [], true), false);
  // A blocked final leaves the name listed for ever, so its thread is released.
  assert.equal(canReleaseThreads(once({ state: 'idle', task: { ...record().task,
    reports: [{ id: 'report-1', final: true, delivery: { state: 'blocked' } }] } }), [], true), true);
  // So do a failure and a verification cancellation that never submitted a final.
  assert.equal(canReleaseThreads(once({ state: 'failed',
    task: { taskId: 'task-1', state: 'failed', reports: [], answers: [], dispatches: [{ requestId: 'r', state: 'failed' }] } }), [], undefined), true);
  assert.equal(canReleaseThreads(once({ state: 'cancelled',
    task: { taskId: 'task-1', state: 'cancelled', cancelVerified: true, cancelTreeSettled: true, reports: [], answers: [], dispatches: [{ requestId: 'r', state: 'cancelled' }] } }), [], true), true);
});

test('the gate never touches another target or a closing name', () => {
  assert.equal(canReleaseThreads(record({ target: 'dsh' }), [], true), false);
  assert.equal(canReleaseThreads(record({ target: 'claude-cli' }), [], true), false);
  assert.equal(canReleaseThreads(record({ closed: true }), [], true), false);
  assert.equal(canReleaseThreads(record({ state: 'delivery_pending' }), [], true), false);
  assert.equal(canReleaseThreads(record({ state: 'awaiting_report' }), [], true), false);
  assert.equal(canReleaseThreads(record({ state: 'cleaning' }), [], true), false);
  assert.equal(canReleaseThreads(record({ task: undefined }), [], true), false);
});

test('a release attempt is atomic, fenced by the round’s ticket, and survives an older document', async () => {
  // The MCP server and the shared listener are different SQLite connections. A backend
  // that read its state before the other connection wrote would otherwise put the old
  // copy back, erasing the attempt (or a newly dispatched request).
  const directory = await mkdtemp(path.join(workspace, '.runtime', 'tests', 'roster-'));
  const file = path.join(directory, 'roster.sqlite');
  const store = new RosterStore(file), other = new RosterStore(file);
  try {
    const at = new Date().toISOString();
    const attempt = { taskId: 'task-x', ticket: 'ticket-1', state: 'sending', nodes: { 'thread-1': 'submitted' } };
    store.insert({ agentId: 'agent-x', ownerId: 'owner-x', sessionId: 'session-x', name: 'x', lifetime: 'persistent',
      target: 'codex-desktop', workspace, state: 'idle', created: true, createdAt: at, updatedAt: at, history: [],
      releaseState: { taskId: 'task-x', ticket: 'ticket-1', state: 'sending', attempts: 1, at },
      task: { taskId: 'task-x', message: 'work', state: 'completed', startedAt: at, answers: [], reports: [], dispatches: [] } });
    assert.equal(store.saveBackendState('agent-x', { binding: { sessionId: 'thread-1', owned: true }, requests: {} },
      { keepRelease: true }), true);

    // The attempt lands on its own field, under the round's ticket.
    assert.equal(store.saveBackendRelease('agent-x', attempt, { taskId: 'task-x', ticket: 'ticket-1' }), true);
    assert.equal(store.backendState('agent-x').release.ticket, 'ticket-1');

    // A Codex document read before that write cannot erase it, and its newer content lands.
    assert.equal(other.saveBackendState('agent-x', { binding: { sessionId: 'thread-1', owned: true },
      requests: { r1: { status: 'accepted' } } }, { keepRelease: true }), true);
    const merged = store.backendState('agent-x');
    assert.equal(merged.release.ticket, 'ticket-1', 'the live attempt survives an older document');
    assert.equal(merged.requests.r1.status, 'accepted', 'and the newer request landed');
    assert.equal(merged.binding.sessionId, 'thread-1');

    // A newer re-check replaces the ticket, and the older attempt can no longer write —
    // even though the stored document still names it.
    const rotated = store.get('agent-x');
    rotated.releaseState = { ...rotated.releaseState, ticket: 'ticket-2' };
    store.save(rotated);
    assert.equal(other.saveBackendRelease('agent-x', attempt, { taskId: 'task-x', ticket: 'ticket-1' }), false,
      'the previous attempt is fenced out');
    assert.equal(other.saveBackendRelease('agent-x', { ...attempt, ticket: 'ticket-2' },
      { taskId: 'task-x', ticket: 'ticket-2' }), true, 'while the current one writes');

    // A dispatch that restored its own subscription knows only the round it belongs to.
    assert.equal(other.saveBackendRelease('agent-x', { ...attempt, nodes: { 'thread-1': 'resubscribed' } },
      { taskId: 'task-x' }), true, 'the round alone is enough for that write');

    // A newer round on this name invalidates every attempt, from any connection.
    const moved = other.get('agent-x');
    moved.task = { taskId: 'task-y', message: 'more', state: 'running', startedAt: at, answers: [], reports: [], dispatches: [] };
    other.save(moved);
    assert.equal(store.saveBackendRelease('agent-x', attempt, { taskId: 'task-x', ticket: 'ticket-2' }), false,
      'the round moved on');
    assert.equal(store.backendState('agent-x').release.nodes['thread-1'], 'resubscribed', 'and the last attempt stands');
  } finally { store.close(); other.close(); }
});

test('a release is due once per task and only a bounded number of times after that', () => {
  const now = 1_000_000;
  assert.equal(releaseDue(undefined, 'task-1', now), true, 'a task that was never asked about');
  assert.equal(releaseDue(undefined, undefined, now), false);
  assert.equal(releaseDue({ taskId: 'task-1', state: 'complete', attempts: 1 }, 'task-1', now), false, 'a proven release never repeats');
  assert.equal(releaseDue({ taskId: 'task-1', state: 'waiting', attempts: 1, nextCheckAt: now + 1 }, 'task-1', now), false);
  assert.equal(releaseDue({ taskId: 'task-1', state: 'waiting', attempts: 1, nextCheckAt: now }, 'task-1', now), true);
  assert.equal(releaseDue({ taskId: 'task-1', state: 'deferred', attempts: RELEASE_ATTEMPT_CAP, nextCheckAt: now }, 'task-1', now), true,
    'past the first attempts it is still asked again, only less often');
  assert.equal(releaseDue({ taskId: 'task-1', state: 'complete' }, 'task-2', now), true, 'a new round re-arms');
});

test('the re-check spacing widens after the first attempts and stops only for a final answer', () => {
  assert.equal(releaseRetryDelay(1), RELEASE_RECHECK_MS);
  assert.equal(releaseRetryDelay(RELEASE_ATTEMPT_CAP), RELEASE_RECHECK_MS);
  assert.equal(releaseRetryDelay(RELEASE_ATTEMPT_CAP + 1), RELEASE_LONG_RECHECK_MS, 'a watched thread is not a failure');
  assert.equal(releaseRetryDelay(999), RELEASE_LONG_RECHECK_MS, 'and the spacing stays bounded');
  // A reason that cannot change never comes back: no schedule at all.
  assert.equal(releaseRetryDelay(1, 'release-no-owned-binding'), undefined);
  assert.equal(releaseRetryDelay(1, 'release-unsupported'), undefined);
  assert.equal(releaseRetryDelay(1, 'release-unsubscribe-inUse'), RELEASE_RECHECK_MS, 'a view guard is retried');
});
