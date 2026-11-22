// Inspect view for input modes.
//
// The service entry is real: createScopedAgents + RosterStore + scheduler. Only the
// native Codex target is a controllable stand-in. Each case reads the row through
// service.inspect, so the assertions cover the caller-visible receipt and the
// input's own requestId rather than a reconstructed internal dispatch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREAD = '22222222-2222-4222-8222-222222222222';
const extra = () => ({ _meta: { threadId: THREAD } });
const MODEL = { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' };
const modelList = () => ({
  default: { ...MODEL }, routableProviders: [MODEL.provider],
  groups: [{ id: MODEL.provider, models: [{ id: MODEL.model, reasoningEfforts: ['high', 'max'] }] }],
});

function fakeCodex(options = {}) {
  const state = {
    running: false, descendantRunning: false, turnId: undefined, turnSeq: 0, question: undefined,
    failAnswerDelivery: options.failAnswerDelivery === true,
    answerRouteUnknown: options.answerRouteUnknown === true,
  };
  const calls = { deliver: [], answer: [] };
  const factory = record => ({
    labels: { host: 'Codex Desktop', bridge: 'Codex Desktop fixture' },
    probe: async () => ({ identity: { workspace }, methods: [], treeProtocol: 1, reportProtocol: 1 }),
    create: async () => ({ sessionId: record.sessionId, modelRequestsStarted: 0 }),
    beginTask: async () => ({ treeProtocol: 1, reportProtocol: 1, throughSeq: 0 }),
    observe: async () => ({ sessionId: record.sessionId, taskId: record.task?.taskId,
      running: state.running || state.descendantRunning,
      questions: state.question ? [{ ...state.question }] : [], reports: [], changes: [], throughSeq: 0,
      tree: { settled: !state.running && !state.descendantRunning,
        running: state.running || state.descendantRunning,
        nodes: [{ sessionId: record.sessionId, parentSessionId: null, name: record.name,
          status: state.running ? 'running' : 'idle', activity: state.running ? 'running' : 'idle',
          changes: [], coverage: 'fixture' }] } }),
    history: async () => ({ messages: [], hasMore: false }),
    answer: async ({ answerId, message }) => {
      calls.answer.push({ answerId, message });
      if (state.question?.state !== 'pending') throw Object.assign(new Error('no pending question'), { code: 'question-not-pending' });
      const consumedQuestionIds = [state.question.id];
      state.question = { ...state.question, state: 'answered' };
      return { consumedQuestionIds, continuation: `Parent answer:\n${message}` };
    },
    deliver: async input => {
      calls.deliver.push({ ...input });
      if (input.kind === 'answer' && state.failAnswerDelivery) {
        throw Object.assign(new Error('fixture answer write refused'), {
          code: 'fixture-answer-failed', terminal: true, notSent: true });
      }
      if (input.kind === 'answer' && state.answerRouteUnknown) return { accepted: true };
      if (state.running) return { accepted: true, delivery: 'current-turn', turnId: state.turnId };
      state.running = true; state.turnId = `turn-${++state.turnSeq}`;
      return { accepted: true, delivery: 'new-turn', turnId: state.turnId };
    },
    receipt: async () => undefined,
    turn: async () => (state.running
      ? { state: 'running' }
      : { state: 'ended', completionReason: { kind: 'completed' } }),
    models: async () => modelList(),
    model: async () => MODEL,
    selectModel: async () => ({ accepted: true }),
    cancel: async () => { state.running = false; return { cancelRequested: true }; },
    destroy: async () => ({ destroyed: true }),
    cursor: async () => ({ throughSeq: 0 }),
    rootTurn: async () => ({ running: state.running, ...(state.turnId ? { turnId: state.turnId } : {}) }),
  });
  factory.calls = calls;
  factory.state = state;
  return factory;
}

async function fixture(options = {}) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'input-mode-inspect-'));
  const store = new RosterStore(':memory:');
  const codex = fakeCodex(options);
  const service = createScopedAgents({ stateDirectory, workspace,
    configFile: path.join(stateDirectory, 'config.json'), target: 'codex-desktop' }, {
    store,
    clientFactory: () => { throw new Error('no DSH host is needed for this case'); },
    callCodex: async (threadId, tool) => (tool === 'read_thread'
      ? { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } }
      : { accepted: true }),
    backendAdapters: { 'codex-desktop': codex },
    codexProbeRegistration: async () => ({ ready: true, registered: true,
      tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  const record = name => store.named(ownerIdFor(THREAD), name);
  return { service, store, stateDirectory, codex, record };
}

async function start(f, name = 'codex-agent') {
  await f.service.create({ name, lifetime: 'persistent', target: 'codex-desktop' }, extra());
  await f.service.send({ name, message: 'start the task' }, extra());
  await f.service.poll(f.record(name).agentId);
  assert.equal(f.codex.state.running, true, 'the first Codex turn started');
  const turnA = f.codex.state.turnId;
  return { name, agentId: f.record(name).agentId, turnA };
}

const view = async (f, name) => f.service.inspect({ name }, extra());
const inputFor = (inspected, requestId) => (inspected.inputs ?? []).find(input => input.requestId === requestId);

test('inspect lists an accepted supplement with its real route and keeps legacy blocked/local-pending states', async () => {
  const f = await fixture();
  try {
    const helper = await start(f);
    const steer = await f.service.send({ name: helper.name, message: 'insert now', mode: 'steer' }, extra());
    assert.equal(steer.delivery, 'current-turn');
    // The durable work queue hides accepted rows; inspect must still show this input.
    assert.equal(f.store.supplements(helper.agentId).some(item => item.requestId === steer.requestId), false);

    const before = await view(f, helper.name);
    const accepted = inputFor(before, steer.requestId);
    assert.ok(accepted, 'the accepted supplement has its own input row');
    assert.equal(accepted.mode, 'steer');
    assert.equal(accepted.delivery, 'current-turn');
    assert.equal(accepted.accepted, true);
    assert.equal(accepted.queued, false);
    assert.equal(accepted.turnId, helper.turnA);
    assert.equal('afterTurnId' in accepted, false);

    // Rows written before the mode/receipt columns existed. The first one was later
    // blocked with its original reason; the second is still waiting locally.
    const record = f.store.get(helper.agentId);
    f.store.enqueueSupplement(record, 'request-legacy-blocked', 'old blocked input', undefined, { mode: 'queue' });
    f.store.enqueueSupplement(record, 'request-legacy-pending', 'old pending input', undefined, { mode: 'queue' });
    f.store.setSupplement('request-legacy-blocked', 'blocked', 'codex-model-change-while-running');
    const legacy = f.store.get(helper.agentId);
    legacy.task.dispatches.push({
      requestId: 'request-legacy-blocked', kind: 'supplement', state: 'queued', accepted: false,
      delivery: 'local-pending', mode: 'queue', message: 'old blocked input', answerIds: [],
    });
    f.store.save(legacy);
    f.store.db.prepare("UPDATE supplements SET receipt=NULL, mode=NULL WHERE requestId IN ('request-legacy-blocked','request-legacy-pending')").run();

    const after = await view(f, helper.name);
    const blocked = inputFor(after, 'request-legacy-blocked');
    assert.ok(blocked, 'an accepted or blocked legacy input is not missing from inspect');
    assert.equal(blocked.delivery, 'blocked', 'a blocked row stays blocked even with a stale queued dispatch');
    assert.equal(blocked.accepted, false);
    assert.equal(blocked.queued, false);
    assert.equal(blocked.reason, 'codex-model-change-while-running');
    const pending = inputFor(after, 'request-legacy-pending');
    assert.ok(pending, 'a legacy queued input is listed');
    assert.equal(pending.delivery, 'local-pending', 'a row without a receipt reports local-pending, not an invented route');
    assert.equal(pending.accepted, false);
    assert.equal(pending.queued, true);
    assert.equal('turnId' in pending, false);
  } finally { f.service.close(); }
});

test('an answer is answer-pending until its actual dispatch, then answered with that turn', async () => {
  const f = await fixture();
  try {
    const helper = await start(f);
    f.codex.state.question = { id: 'codex-question-pending', state: 'pending', message: 'Which branch?' };
    const answer = await f.service.send({ name: helper.name, message: 'Use the release branch.' }, extra());
    assert.equal(answer.delivery, 'answer-pending');
    assert.equal(answer.accepted, false);
    assert.equal(answer.queued, true);

    const pending = inputFor(await view(f, helper.name), answer.requestId);
    assert.ok(pending, 'the answer row is keyed by the requestId the caller kept');
    assert.equal(pending.delivery, 'answer-pending');
    assert.equal(pending.accepted, false);
    assert.equal(pending.queued, true);
    assert.equal(pending.mode, 'steer');
    assert.equal('turnId' in pending, false, 'registration alone proves no turn');

    // A ends; the next poll writes the answer into a new turn B. The answer dispatch
    // has a different internal request id and is matched through answerIds/questionIds.
    f.codex.state.running = false;
    await f.service.poll(helper.agentId);
    const turnB = `turn-${f.codex.state.turnSeq}`;
    assert.notEqual(turnB, helper.turnA);
    const delivered = inputFor(await view(f, helper.name), answer.requestId);
    assert.equal(delivered.delivery, 'answered');
    assert.equal(delivered.accepted, true);
    assert.equal(delivered.queued, false);
    assert.equal(delivered.turnId, turnB);
    assert.equal(f.codex.calls.deliver.filter(call => call.kind === 'answer').length, 1);
    assert.match(f.codex.calls.deliver.find(call => call.kind === 'answer').message, /Use the release branch\./);
  } finally { f.service.close(); }
});

test('a failed answer dispatch stays blocked with its reason instead of reporting answered', async () => {
  const f = await fixture({ failAnswerDelivery: true });
  try {
    const helper = await start(f);
    f.codex.state.question = { id: 'codex-question-fail', state: 'pending', message: 'Which branch?' };
    const answer = await f.service.send({ name: helper.name, message: 'Use the release branch.' }, extra());
    assert.equal(answer.delivery, 'answer-pending');

    f.codex.state.running = false;
    await f.service.poll(helper.agentId);
    assert.equal(f.codex.calls.deliver.some(call => call.kind === 'answer'), true, 'the answer write was attempted');

    const failed = inputFor(await view(f, helper.name), answer.requestId);
    assert.ok(failed, 'the failed answer keeps its own input row');
    assert.notEqual(failed.delivery, 'answered', 'dispatched=true alone is not delivery evidence');
    assert.equal(failed.delivery, 'blocked');
    assert.equal(failed.accepted, false);
    assert.equal(failed.queued, false);
    assert.equal(failed.reason, 'fixture-answer-failed');
    assert.equal('turnId' in failed, false);
  } finally { f.service.close(); }
});

test('accepted without a native route reports route-unknown, never answered/current/new', async () => {
  const f = await fixture({ answerRouteUnknown: true });
  try {
    const helper = await start(f);
    f.codex.state.question = { id: 'codex-question-route', state: 'pending', message: 'Which branch?' };
    const answer = await f.service.send({ name: helper.name, message: 'Use the release branch.' }, extra());
    f.codex.state.running = false;
    await f.service.poll(helper.agentId);

    const row = inputFor(await view(f, helper.name), answer.requestId);
    assert.equal(row.delivery, 'accepted-route-unknown');
    assert.equal(row.accepted, true);
    assert.equal(row.queued, false);
    assert.equal('turnId' in row, false, 'no current/new turn is invented from accepted');
    assert.equal('afterTurnId' in row, false);
  } finally { f.service.close(); }
});

test('a native card answer reports answered without inventing a text turn', async () => {
  const f = await fixture();
  try {
    const helper = await start(f);
    // A native card answer is delivered by the adapter itself; no continuation
    // dispatch is created, so inspect must not borrow a turn id from the task.
    const record = f.store.get(helper.agentId);
    record.task.answers.push({ answerId: 'answer-native-card', message: 'Use the release branch.',
      dispatched: true, questionIds: ['codex-question-native'], nativeAnswered: true });
    f.store.save(record);

    const row = inputFor(await view(f, helper.name), 'answer-native-card');
    assert.equal(row.delivery, 'answered');
    assert.equal(row.accepted, true);
    assert.equal(row.queued, false);
    assert.equal('turnId' in row, false);
  } finally { f.service.close(); }
});
