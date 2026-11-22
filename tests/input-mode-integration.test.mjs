// Cross-entry integration for input modes.
//
// These cases drive the real createScopedAgents send/run entries, the real roster
// and the shared scheduler. Only the native target is a controllable stand-in:
// Claude CLI and Codex Desktop adapters and the DSH managed host are local fixtures.
// They assert caller-visible receipts and each input's own inspect row, never an
// inference from accepted alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const THREAD = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });
const MODEL = { provider: 'fixture', model: 'fixture-model', reasoningEffort: 'high' };

async function fixture({ adapters = {}, clientFactory, controlFactory, behavior = {} } = {}) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'input-mode-'));
  const store = new RosterStore(':memory:');
  const runtimeConfig = { stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh', ...behavior };
  const dependencies = {
    store,
    clientFactory: clientFactory ?? (() => { throw new Error('no DSH host is needed for this case'); }),
    ...(controlFactory ? { controlFactory } : {}),
    callCodex: async (threadId, tool) => (tool === 'read_thread'
      ? { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } }
      : { accepted: true }),
    backendAdapters: adapters,
    codexProbeRegistration: async () => ({ ready: true, registered: true,
      tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  };
  const service = createScopedAgents(runtimeConfig, dependencies);
  const reopen = () => createScopedAgents(runtimeConfig, dependencies);
  const record = name => store.named(ownerIdFor(THREAD), name);
  return { service, store, stateDirectory, record, runtimeConfig, reopen };
}

const inputsOf = inspected => inspected.inputs ?? [];
const inputFor = (inspected, requestId) => {
  const found = inputsOf(inspected).find(input => input.requestId === requestId);
  assert.ok(found, `inspect must carry the input ${requestId}; got ${inputsOf(inspected).map(input => input.requestId).join(', ') || 'none'}`);
  return found;
};
const entryCall = (service, entry, args) => entry === 'send'
  ? service.send(args, extra(THREAD))
  : service.run(args, extra(THREAD));

// --- Claude CLI ---------------------------------------------------------------

const claudeModel = () => ({
  default: { ...MODEL }, routableProviders: [MODEL.provider],
  groups: [{ id: MODEL.provider, models: [{ id: MODEL.model, reasoningEfforts: ['high', 'max'] }] }],
});

function fakeClaude() {
  const state = { running: false, turnId: undefined, turnSeq: 0, question: undefined };
  const calls = { deliver: [], answer: [], root: 0 };
  const factory = record => ({
    labels: { host: 'Claude CLI', bridge: 'Claude CLI fixture' },
    probe: async () => ({ identity: { workspace }, methods: [], treeProtocol: 1, reportProtocol: 1 }),
    create: async () => ({ sessionId: record.sessionId, modelRequestsStarted: 0 }),
    beginTask: async () => ({ treeProtocol: 1, reportProtocol: 1, throughSeq: 0 }),
    observe: async () => ({ sessionId: record.sessionId, taskId: record.task?.taskId,
      running: state.running, questions: state.question ? [{ ...state.question }] : [],
      reports: [], changes: [], throughSeq: 0,
      tree: { settled: !state.running, running: state.running, nodes: [{ sessionId: record.sessionId,
        parentSessionId: null, name: record.name, status: state.running ? 'running' : 'idle',
        activity: state.running ? 'working' : 'idle', changes: [], coverage: 'fixture' }] } }),
    history: async () => ({ messages: [], hasMore: false }),
    answer: async ({ answerId, message }) => {
      calls.answer.push({ answerId, message });
      if (state.question?.state !== 'pending') throw Object.assign(new Error('no pending question'), { code: 'question-not-pending' });
      state.question = { ...state.question, state: 'answered' };
      return { consumedQuestionIds: [state.question.id], continuation: `Parent answer:\n${message}` };
    },
    deliver: async input => {
      calls.deliver.push({ ...input });
      // A headless CLI process has no native turn id to quote. The target can still
      // prove that a new turn is the next one, so the receipt says new-turn and leaves
      // turnId absent rather than inventing one from the session label.
      if (state.running) return { accepted: true, delivery: 'current-turn' };
      state.running = true; state.turnSeq += 1;
      return { accepted: true, delivery: 'new-turn' };
    },
    receipt: async () => undefined,
    turn: async () => (state.running ? { state: 'running' } : { state: 'ended', completionReason: { kind: 'completed' } }),
    models: async () => claudeModel(),
    model: async () => undefined,
    selectModel: async () => ({ accepted: true }),
    cancel: async () => { state.running = false; return { cancelRequested: true }; },
    destroy: async () => ({ destroyed: true }),
    cursor: async () => ({ throughSeq: 0 }),
    rootTurn: async () => { calls.root++; return { running: state.running }; },
  });
  factory.calls = calls;
  factory.state = state;
  return factory;
}

async function startClaude(f, name = 'claude-agent') {
  await f.service.create({ name, lifetime: 'persistent', target: 'claude-cli' }, extra(THREAD));
  await f.service.send({ name, message: 'start the task' }, extra(THREAD));
  await f.service.poll(f.record(name).agentId);
  assert.equal(f.claude.state.running, true, 'the first turn is running');
  return { name, agentId: f.record(name).agentId };
}

async function claudeFixture() {
  const claude = fakeClaude();
  const f = await fixture({ adapters: { 'claude-cli': claude } });
  return { ...f, claude };
}

test('Claude CLI pending question: send and same-name run take omitted/steer as the answer', async () => {
  for (const entry of ['send', 'run']) {
    for (const mode of [undefined, 'steer']) {
      const f = await claudeFixture();
      try {
        const helper = await startClaude(f, `claude-answer-${entry}-${mode ?? 'omitted'}`);
        f.claude.state.question = { id: 'claude-question-1', state: 'pending', message: 'Which branch?' };
        const receipt = await entryCall(f.service, entry, { name: helper.name, message: 'Use the release branch.', mode });
        const label = `${entry}/${mode ?? 'omitted'}`;
        assert.equal(receipt.requestId?.startsWith('request-'), true, `${label}: request id`);
        assert.equal(receipt.accepted, false, `${label}: an answer pending in the turn is not native acceptance`);
        assert.equal(receipt.queued, true, `${label}: it is held for delivery`);
        assert.equal(receipt.delivery, 'answer-pending', `${label}: answer-pending`);
        assert.equal(receipt.mode, 'steer', `${label}: the answer path reports its real semantic mode`);
        assert.equal(f.claude.calls.answer.length, 1, `${label}: the question was registered as the answer`);
        assert.equal(f.record(helper.name).task.answers?.length, 1, `${label}: one answer intent`);

        // The CLI turn ends: the answer is resumed into the same conversation on the next poll.
        f.claude.state.running = false;
        await f.service.poll(helper.agentId);
        const inspected = await f.service.inspect({ name: helper.name }, extra(THREAD));
        const input = inputFor(inspected, receipt.requestId);
        assert.equal(input.delivery, 'answered', `${label}: answered after the actual delivery`);
        assert.equal(input.accepted, true);
        assert.equal('turnId' in input, false,
          `${label}: a CLI process without a native turn id reports the answered route without inventing a turn id`);
        assert.equal(f.claude.calls.deliver.at(-1).kind, 'answer', `${label}: delivered as an answer`);
        assert.match(f.claude.calls.deliver.at(-1).message, /Use the release branch\./);
      } finally { f.service.close(); }
    }
  }
});

test('Claude CLI pending question: explicit queue queues the supplement and leaves the question pending', async () => {
  for (const entry of ['send', 'run']) {
    const f = await claudeFixture();
    try {
      const helper = await startClaude(f);
      f.claude.state.question = { id: 'claude-question-2', state: 'pending', message: 'Which branch?' };
      const before = f.claude.calls.answer.length;
      const receipt = await entryCall(f.service, entry, { name: helper.name, message: 'Later, read this.', mode: 'queue' });
      assert.equal(receipt.accepted, false);
      assert.equal(receipt.queued, true);
      assert.equal(receipt.mode, 'queue');
      assert.equal(receipt.delivery, 'local-pending');
      assert.equal(f.claude.calls.answer.length, before, `${entry}: queue never answers`);
      assert.equal(f.record(helper.name).task.answers?.length ?? 0, 0, `${entry}: no answer intent`);
      assert.equal(f.record(helper.name).observation?.questions?.[0]?.state ?? 'pending', 'pending',
        `${entry}: the question remains pending`);
      await f.service.poll(helper.agentId);
      assert.equal(f.claude.calls.answer.length, before, `${entry}: a poll with a pending question still does not answer`);
      assert.equal(f.store.supplement(receipt.requestId)?.status, 'queued', `${entry}: the supplement stays queued`);
      assert.equal(f.record(helper.name).task.answers?.length ?? 0, 0);
    } finally { f.service.close(); }
  }
});

test('Claude CLI without a question: omitted and queue wait for the next resume; steer is refused', async () => {
  for (const entry of ['send', 'run']) {
    const f = await claudeFixture();
    try {
      const helper = await startClaude(f, `claude-busy-${entry}`);
      f.claude.state.question = undefined;

      for (const mode of [undefined, 'queue']) {
        const receipt = await entryCall(f.service, entry, { name: helper.name, message: `next for ${mode ?? 'omitted'}`, mode });
        assert.equal(receipt.accepted, false, `${entry}/${mode}: locally held`);
        assert.equal(receipt.queued, true);
        assert.equal(receipt.mode, 'queue', `${entry}/${mode}: an ordinary CLI supplement reports queue semantics`);
        assert.ok(['local-pending', 'after-current'].includes(receipt.delivery),
          `${entry}/${mode}: held for the next resume (${receipt.delivery})`);
        assert.equal(f.claude.calls.answer.length, 0);
        assert.equal(f.store.supplement(receipt.requestId)?.status, 'queued');
      }
      const before = f.claude.calls.deliver.length;
      const refused = await entryCall(f.service, entry, { name: helper.name, message: 'insert now', mode: 'steer' });
      assert.equal(refused.accepted, false, `${entry}: steer is not accepted`);
      assert.equal(refused.queued, false);
      assert.deepEqual(refused.error, { code: 'mode-unsupported', target: 'claude-cli', supportedModes: ['queue'] },
        `${entry}: the refusal names the target and the one supported mode`);
      assert.equal(f.claude.calls.deliver.length, before, `${entry}: a refused mode writes nothing`);
      assert.equal(f.store.supplements(helper.agentId).some(item => item.message === 'insert now'), false,
        `${entry}: a refused mode queues nothing`);

      // The running turn ends; the two queued inputs reach the next turns one at a time.
      f.claude.state.running = false;
      await f.service.poll(helper.agentId);
      assert.equal(f.claude.calls.deliver.at(-1).mode, 'queue', `${entry}: the queued input starts a turn with queue mode`);
      assert.equal(f.claude.calls.deliver.at(-1).message, 'next for omitted');
    } finally { f.service.close(); }
  }
});

test('send and same-name run expose the same public receipt shape and answer turn evidence', async () => {
  const shape = receipt => ({
    accepted: receipt.accepted === true,
    queued: 'queued' in receipt ? receipt.queued : 'absent',
    mode: receipt.mode,
    delivery: receipt.delivery,
    error: receipt.error,
    requestId: typeof receipt.requestId === 'string' && receipt.requestId.startsWith('request-'),
    turnId: 'turnId' in receipt ? typeof receipt.turnId === 'string' : false,
    afterTurnId: 'afterTurnId' in receipt ? typeof receipt.afterTurnId === 'string' : false,
  });

  const claudeReceipts = [];
  for (const entry of ['send', 'run']) {
    const f = await claudeFixture();
    try {
      const helper = await startClaude(f, `claude-shape-${entry}`);
      f.claude.state.question = { id: 'claude-shape-q', state: 'pending', message: 'Which one?' };
      claudeReceipts.push(shape(await entryCall(f.service, entry, { name: helper.name, message: 'the answer' })));
    } finally { f.service.close(); }
  }
  assert.deepEqual(claudeReceipts[0], claudeReceipts[1], 'send and run answer receipts are the same public shape');
  assert.deepEqual(claudeReceipts[0], { accepted: false, queued: true, mode: 'steer', delivery: 'answer-pending',
    error: undefined, requestId: true, turnId: false, afterTurnId: false });

  const dshReceipts = [];
  for (const entry of ['send', 'run']) {
    const f = await dshFixture();
    try {
      const name = `dsh-shape-${entry}`;
      await startDsh(f, name);
      dshReceipts.push(shape(await entryCall(f.service, entry, { name, message: 'queue it', mode: 'queue' })));
    } finally { f.service.close(); }
  }
  assert.deepEqual(dshReceipts[0], dshReceipts[1], 'the DSH refusal is identical from send and run');
  assert.deepEqual(dshReceipts[0], { accepted: false, queued: false, mode: 'queue', delivery: undefined,
    error: { code: 'mode-unsupported', target: 'dsh', supportedModes: ['steer'] },
    requestId: false, turnId: false, afterTurnId: false });
});

test('Claude CLI idle: send and same-name run start a turn in both modes', async () => {
  for (const entry of ['send', 'run']) {
    for (const mode of ['steer', 'queue']) {
      const f = await claudeFixture();
      try {
        const name = `claude-idle-${entry}-${mode}`;
        await f.service.create({ name, lifetime: 'persistent', target: 'claude-cli' }, extra(THREAD));
        const receipt = await entryCall(f.service, entry, { name, message: `start ${mode}`, mode });
        assert.equal(receipt.accepted ?? false, false, `${entry}/${mode}: a CLI start is first stored locally`);
        assert.equal(receipt.mode, mode, `${entry}/${mode}: the requested mode is echoed on an idle start`);
        await f.service.poll(f.record(name).agentId);
        assert.equal(f.claude.calls.deliver.length, 1, `${entry}/${mode}: exactly one start`);
        const inspected = await f.service.inspect({ name }, extra(THREAD));
        const input = inputFor(inspected, receipt.requestId);
        assert.equal(input.delivery, 'new-turn', `${entry}/${mode}: the start receipt names the new turn`);
        assert.equal('turnId' in input, false, `${entry}/${mode}: no native CLI turn id was invented`);
      } finally { f.service.close(); }
    }
  }
});

// --- DSH ----------------------------------------------------------------------

function fakeDsh() {
  const sessions = new Map(), sends = [], selections = [];
  const api = {
    async connectionIdentity() { return { application: 'dsh', dataRoot: 'fixture' }; },
    async hostStatus() { return { treeProtocol: 1, reportProtocol: 1, methods: ['managedCreate', 'managedBeginTask',
      'managedStatus', 'managedHistory', 'managedAnswer', 'managedCancel', 'managedDestroy'] }; },
    async managedCreate(input) {
      if (!sessions.has(input.sessionId)) sessions.set(input.sessionId,
        { sessionId: input.sessionId, taskId: undefined, model: { ...MODEL }, running: false,
          questions: [], reports: [], changes: [], seq: 0 });
      const s = sessions.get(input.sessionId);
      return { sessionId: s.sessionId, modelRequestsStarted: 0, model: { ...s.model } };
    },
    async managedBeginTask(input) {
      const s = sessions.get(input.sessionId);
      if (s.taskId !== input.taskId) Object.assign(s, { taskId: input.taskId, questions: [], reports: [], changes: [] });
      return { taskId: s.taskId, treeProtocol: 1, reportProtocol: 1, currentModel: { ...s.model }, throughSeq: s.seq };
    },
    async managedStatus(input) {
      const s = sessions.get(input.sessionId);
      return { sessionId: s.sessionId, taskId: s.taskId, currentModel: { ...s.model }, running: s.running,
        questions: s.questions, reports: s.reports, changes: s.changes, throughSeq: s.seq,
        tree: { settled: !s.running, running: s.running, nodes: [{ sessionId: s.sessionId, parentSessionId: null,
          name: 'native root', status: s.running ? 'running' : 'idle', activity: s.running ? 'writing' : 'idle',
          changes: [], coverage: 'fixture' }] } };
    },
    async managedHistory() { return { events: [] }; },
    async managedAnswer(input) {
      const s = sessions.get(input.sessionId);
      const pending = s.questions.filter(question => question.state === 'pending');
      if (!pending.length) throw Object.assign(new Error('no question'), { code: 'question-not-pending' });
      pending.forEach(question => { question.state = 'answered'; });
      return { consumedQuestionIds: pending.map(question => question.id), continuation: `Answer: ${input.message}` };
    },
    async managedCancel() { return { cancelled: true, cancelRequested: true }; },
    async managedDestroy() { return { destroyed: true }; },
  };
  const controlFactory = () => ({
    async models() { return claudeModel(); },
    async selectModel(input) {
      selections.push({ ...input });
      sessions.get(input.sessionId).model = Object.fromEntries(['provider', 'model', 'reasoningEffort']
        .filter(key => input[key] !== undefined).map(key => [key, input[key]]));
      return { accepted: true };
    },
    async send(input) {
      const s = sessions.get(input.sessionId);
      sends.push({ ...input });
      s.running = true; s.seq += 1;
      return { accepted: true, afterSeq: s.seq - 1 };
    },
    async wait(input) {
      const s = sessions.get(input.sessionId);
      return { state: s.running ? 'running' : 'ended', correlation: 'request-id', afterSeq: input.afterSeq ?? 0,
        sessionId: s.sessionId };
    },
    async read() { return { messages: [] }; },
  });
  return { api, controlFactory, sessions, sends, selections };
}

async function dshFixture() {
  const dsh = fakeDsh();
  const f = await fixture({ clientFactory: () => dsh.api, controlFactory: dsh.controlFactory });
  return { ...f, dsh };
}

async function startDsh(f, name) {
  await f.service.create({ name, lifetime: 'persistent', target: 'dsh' }, extra(THREAD));
  const receipt = await f.service.send({ name, message: 'start the task' }, extra(THREAD));
  assert.equal(receipt.accepted, true, 'the DSH task was admitted');
  return { name, agentId: f.record(name).agentId, session: f.dsh.sessions.get(f.record(name).sessionId) };
}

test('DSH busy explicit queue is refused by send and run, with or without a question, and changes nothing', async () => {
  for (const entry of ['send', 'run']) {
    for (const withQuestion of [false, true]) {
      const f = await dshFixture();
      try {
        const name = `dsh-${entry}-${withQuestion}`;
        const helper = await startDsh(f, name);
        if (withQuestion) helper.session.questions = [{ id: 'dsh-q', state: 'pending', message: 'Pick one' }];
        const before = {
          sends: f.dsh.sends.length,
          selections: f.dsh.selections.length,
          pin: structuredClone(f.record(name).modelPin),
          supplements: f.store.supplements(helper.agentId).length,
        };
        const receipt = await entryCall(f.service, entry, { name, message: 'queue this', mode: 'queue' });
        assert.equal(receipt.accepted, false, `${entry}/${withQuestion}: not accepted`);
        assert.deepEqual(receipt.error, { code: 'mode-unsupported', target: 'dsh', supportedModes: ['steer'] },
          `${entry}/${withQuestion}: DSH names steer as its only mode`);
        assert.equal(f.dsh.sends.length, before.sends, `${entry}/${withQuestion}: no backend write`);
        assert.equal(f.dsh.selections.length, before.selections, `${entry}/${withQuestion}: no model selection write`);
        assert.deepEqual(f.record(name).modelPin, before.pin, `${entry}/${withQuestion}: the pin is untouched`);
        assert.equal(f.store.supplements(helper.agentId).length, before.supplements,
          `${entry}/${withQuestion}: nothing entered the durable queue`);
        assert.equal(f.record(name).task.answers?.length ?? 0, 0, `${entry}/${withQuestion}: no answer registration`);
      } finally { f.service.close(); }
    }
  }
});

test('DSH busy omission and explicit steer still insert on the next step', async () => {
  for (const mode of [undefined, 'steer']) {
    const f = await dshFixture();
    try {
      const name = `dsh-supplement-${mode ?? 'omitted'}`;
      const helper = await startDsh(f, name);
      const before = f.dsh.sends.length;
      const receipt = await f.service.send({ name, message: 'read this next', mode }, extra(THREAD));
      assert.equal(receipt.accepted, true, `${mode}: DSH accepted the insert`);
      assert.equal(receipt.mode, 'steer', `${mode}: DSH inserts on the next step`);
      assert.equal(f.dsh.sends.length, before + 1, `${mode}: one native write`);
      assert.equal(f.dsh.sends.at(-1).mode, 'steer', `${mode}: delivered as steer`);
      assert.equal(f.dsh.sends.at(-1).message, 'read this next');
      assert.equal(f.store.supplement(receipt.requestId)?.status, 'accepted');
    } finally { f.service.close(); }
  }
});

test('DSH idle: send and same-name run start a turn in both modes', async () => {
  for (const entry of ['send', 'run']) {
    for (const mode of ['steer', 'queue']) {
      const f = await dshFixture();
      try {
        const name = `dsh-idle-${entry}-${mode}`;
        await f.service.create({ name, lifetime: 'persistent', target: 'dsh' }, extra(THREAD));
        const before = f.dsh.sends.length;
        const receipt = await entryCall(f.service, entry, { name, message: `start ${mode}`, mode });
        assert.equal(receipt.accepted, true, `${entry}/${mode}: an idle DSH start is accepted`);
        assert.equal(receipt.mode, mode, `${entry}/${mode}: both modes start a turn when idle`);
        assert.equal(f.dsh.sends.length, before + 1);
      } finally { f.service.close(); }
    }
  }
});

// --- Codex Desktop ------------------------------------------------------------

function fakeCodex() {
  const state = { running: false, descendantRunning: false, turnId: undefined, turnSeq: 0, question: undefined };
  const calls = { deliver: [], answer: [], root: 0 };
  const receipts = new Map();
  const factory = record => ({
    labels: { host: 'Codex Desktop', bridge: 'Codex Desktop fixture' },
    probe: async () => ({ identity: { workspace }, methods: [], treeProtocol: 1, reportProtocol: 1 }),
    create: async () => ({ sessionId: record.sessionId, modelRequestsStarted: 0 }),
    beginTask: async () => ({ treeProtocol: 1, reportProtocol: 1, throughSeq: 0 }),
    observe: async () => { if (state.observeFailure) throw new Error('native read unavailable'); return ({ sessionId: record.sessionId, taskId: record.task?.taskId,
      running: state.running || state.descendantRunning,
      questions: state.question ? [{ ...state.question }] : [], reports: [], changes: [], throughSeq: 0,
      tree: { settled: !state.running && !state.descendantRunning, running: state.running || state.descendantRunning,
        nodes: [{ sessionId: record.sessionId, parentSessionId: null, name: record.name,
          status: state.running ? 'running' : 'idle', activity: state.running ? 'running' : 'idle',
          changes: [], coverage: 'root' },
        ...(state.descendantRunning ? [{ sessionId: 'child-thread', parentSessionId: record.sessionId,
          name: 'helper child', status: 'running', activity: 'running', changes: [], coverage: 'child' }] : [])] } }); },
    history: async () => ({ messages: [], hasMore: false }),
    answer: async ({ answerId, message }) => {
      calls.answer.push({ answerId, message });
      if (state.question?.state !== 'pending') throw Object.assign(new Error('no pending question'), { code: 'question-not-pending' });
      state.question = { ...state.question, state: 'answered' };
      return { consumedQuestionIds: [state.question.id], continuation: `Parent answer:\n${message}` };
    },
    deliver: async input => {
      calls.deliver.push({ ...input });
      if (state.rejectNext) {
        state.rejectNext = false; receipts.set(input.requestId, { status: 'rejected', notSent: true });
        throw Object.assign(new Error('lost response to pre-write rejection'), { uncertain: true });
      }
      const delivery = state.running ? 'current-turn' : 'new-turn';
      if (!state.running) { state.running = true; state.turnId = `turn-${++state.turnSeq}`; state.actualEffort = input.model?.reasoningEffort ?? null; }
      const receipt = { status: 'accepted', accepted: true, delivery, turnId: state.turnId, actualEffort: state.actualEffort };
      receipts.set(input.requestId, receipt);
      if (state.loseNext) { state.loseNext = false; throw Object.assign(new Error('lost response after native write'), { uncertain: true }); }
      return receipt;
    },
    receipt: async ({ requestId }) => receipts.get(requestId),
    turn: async () => (state.running ? { state: 'running' } : { state: 'ended', completionReason: { kind: 'completed' } }),
    models: async () => claudeModel(),
    model: async () => MODEL,
    selectModel: async () => ({ accepted: true }),
    cancel: async () => { state.running = false; return { cancelRequested: true }; },
    destroy: async () => ({ destroyed: true }),
    cursor: async () => ({ throughSeq: 0 }),
    rootTurn: async () => { calls.root++; return { running: state.running, ...(state.turnId ? { turnId: state.turnId } : {}) }; },
  });
  factory.calls = calls;
  factory.state = state;
  return factory;
}

async function codexFixture() {
  const codex = fakeCodex();
  const f = await fixture({ adapters: { 'codex-desktop': codex } });
  return { ...f, codex };
}

async function startCodex(f, name = 'codex-agent') {
  await f.service.create({ name, lifetime: 'persistent', target: 'codex-desktop' }, extra(THREAD));
  await f.service.send({ name, message: 'start the task' }, extra(THREAD));
  await f.service.poll(f.record(name).agentId);
  assert.equal(f.codex.state.running, true, 'the first Codex turn is running');
  return { name, agentId: f.record(name).agentId, turnId: f.codex.state.turnId };
}

test('Codex idle: both modes start a turn with no backlog', async () => {
  for (const mode of ['steer', 'queue']) {
    const f = await codexFixture();
    try {
      const name = `codex-idle-${mode}`;
      await f.service.create({ name, lifetime: 'persistent', target: 'codex-desktop' }, extra(THREAD));
      const receipt = await f.service.send({ name, message: `start ${mode}`, mode }, extra(THREAD));
      await f.service.poll(f.record(name).agentId);
      assert.equal(f.codex.calls.deliver.length, 1, `${mode}: exactly one start`);
      assert.equal(receipt.mode, mode, `${mode}: the idle receipt echoes the requested mode`);
      const inspected = await f.service.inspect({ name }, extra(THREAD));
      const input = inputFor(inspected, receipt.requestId);
      assert.equal(input.delivery, 'new-turn');
      assert.equal(input.turnId, f.codex.state.turnId);
    } finally { f.service.close(); }
  }
});

test('Codex queue Q1/Q2 and steer S keep FIFO and each input its own turn', async () => {
  const f = await codexFixture();
  try {
    const helper = await startCodex(f);
    const firstTurn = helper.turnId;
    const q1 = await f.service.send({ name: helper.name, message: 'Q1 only', mode: 'queue' }, extra(THREAD));
    const q2 = await f.service.send({ name: helper.name, message: 'Q2 only', mode: 'queue' }, extra(THREAD));
    // The real caller pattern: queue through send, then the same-name run with mode
    // omitted steers into the active turn.
    const s = await f.service.run({ name: helper.name, message: 'S now' }, extra(THREAD));
    await f.service.poll(helper.agentId);

    assert.equal(q1.requestId.startsWith('request-'), true);
    assert.notEqual(q1.requestId, q2.requestId);
    const inspectA = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectA, q1.requestId).delivery, 'after-current');
    assert.equal(inputFor(inspectA, q1.requestId).afterTurnId, firstTurn);
    assert.equal(inputFor(inspectA, q2.requestId).delivery, 'after-current');
    const sInput = inputFor(inspectA, s.requestId);
    assert.equal(sInput.delivery, 'current-turn');
    assert.equal(sInput.accepted, true);
    assert.equal(sInput.turnId, firstTurn);
    assert.equal(f.codex.calls.deliver.filter(call => call.message === 'Q1 only').length, 0,
      'Q1 was not written into the active turn');
    assert.equal(f.codex.calls.deliver.filter(call => call.message === 'Q2 only').length, 0,
      'Q2 was not written into the active turn');
    assert.equal(f.codex.calls.deliver.filter(call => call.message === 'S now').length, 1,
      'S was written once');
    assert.equal(f.codex.calls.deliver.find(call => call.message === 'S now').mode, 'steer');

    // A ends while a descendant is still active: only the root state decides that B may start.
    f.codex.state.running = false;
    f.codex.state.descendantRunning = true;
    await f.service.poll(helper.agentId);
    const q1Deliver = f.codex.calls.deliver.filter(call => call.message === 'Q1 only');
    assert.equal(q1Deliver.length, 1, 'Q1 started B exactly once even though a descendant is active');
    assert.equal(q1Deliver[0].mode, 'queue');
    const turnB = `turn-${f.codex.state.turnSeq}`;
    assert.notEqual(turnB, firstTurn);
    // The next read settles the remaining queue behind the now-known B without starting it.
    await f.service.poll(helper.agentId);
    const inspectB = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectB, q1.requestId).delivery, 'new-turn');
    assert.equal(inputFor(inspectB, q1.requestId).turnId, turnB);
    assert.equal(inputFor(inspectB, q2.requestId).delivery, 'after-current');
    assert.equal(inputFor(inspectB, q2.requestId).afterTurnId, turnB);

    // A new call arriving behind Q2 does not jump the queue: it waits behind B and
    // Q2, never before them.
    const q3 = await f.service.send({ name: helper.name, message: 'Q3 last', mode: 'queue' }, extra(THREAD));
    await f.service.poll(helper.agentId);
    const inspectB2 = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectB2, q3.requestId).delivery, 'after-current');
    assert.equal(inputFor(inspectB2, q3.requestId).afterTurnId, turnB);

    // B ends: Q2 alone opens C.
    f.codex.state.running = false;
    f.codex.state.descendantRunning = false;
    await f.service.poll(helper.agentId);
    const q2Deliver = f.codex.calls.deliver.filter(call => call.message === 'Q2 only');
    assert.equal(q2Deliver.length, 1, 'Q2 started C exactly once');
    assert.equal(q2Deliver[0].mode, 'queue');
    const turnC = `turn-${f.codex.state.turnSeq}`;
    assert.equal(new Set([firstTurn, turnB, turnC]).size, 3, 'A, B and C are three different turns');
    const inspectC = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectC, q2.requestId).delivery, 'new-turn');
    assert.equal(inputFor(inspectC, q2.requestId).turnId, turnC);
    assert.equal(inputFor(inspectC, q3.requestId).delivery, 'after-current');
    assert.equal(inputFor(inspectC, q3.requestId).afterTurnId, turnC);
    assert.equal(f.codex.calls.deliver.filter(call => call.message === 'Q1 only').length, 1);
    assert.equal(f.codex.calls.deliver.filter(call => call.message === 'Q2 only').length, 1);
    assert.equal(f.codex.calls.deliver.filter(call => call.message === 'Q3 last').length, 0,
      'Q3 did not overtake Q2 while C was pending');

    // C ends: Q3 alone opens D.
    f.codex.state.running = false;
    await f.service.poll(helper.agentId);
    const q3Deliver = f.codex.calls.deliver.filter(call => call.message === 'Q3 last');
    assert.equal(q3Deliver.length, 1, 'Q3 started D exactly once');
    const turnD = `turn-${f.codex.state.turnSeq}`;
    assert.equal(new Set([firstTurn, turnB, turnC, turnD]).size, 4);
    const inspectD = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectD, q3.requestId).delivery, 'new-turn');
    assert.equal(inputFor(inspectD, q3.requestId).turnId, turnD);
    assert.equal(f.codex.calls.deliver.some(call => call.message.includes('Q1 only') && call.message.includes('Q2 only')), false,
      'Q1 and Q2 were never merged');
    assert.equal(f.codex.calls.deliver.filter(call => call.message === 'Q1 only')[0].message, 'Q1 only');
  } finally { f.service.close(); }
});

test('Codex explicit queue never answers; a separate answer answers while Q stays queued', async () => {
  const f = await codexFixture();
  try {
    const helper = await startCodex(f);
    const firstTurn = helper.turnId;
    f.codex.state.question = { id: 'codex-queue-question', state: 'pending', message: 'Pick one' };
    const q = await f.service.send({ name: helper.name, message: 'Q waits behind A', mode: 'queue' }, extra(THREAD));
    assert.equal(q.accepted, false);
    assert.equal(q.mode, 'queue');
    assert.equal(f.codex.calls.answer.length, 0, 'explicit queue did not answer the question');
    assert.equal(f.record(helper.name).task.answers?.length ?? 0, 0);

    const answered = await f.service.answer({ name: helper.name, message: 'R answers' }, extra(THREAD));
    assert.equal(answered.answered, true);
    // First poll delivers the answer; the next one settles the queue row behind A.
    await f.service.poll(helper.agentId);
    await f.service.poll(helper.agentId);
    assert.equal(f.codex.calls.answer.length, 1, 'the separate answer consumed the question');
    assert.equal(f.codex.calls.deliver.filter(call => call.message === 'Q waits behind A').length, 0,
      'Q was still not written into A');
    const answerId = f.record(helper.name).task.answers.at(-1).answerId;
    const inspectA = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectA, q.requestId).delivery, 'after-current');
    assert.equal(inputFor(inspectA, q.requestId).afterTurnId, firstTurn);
    assert.equal(inputFor(inspectA, answerId).delivery, 'answered');
    assert.equal(inputFor(inspectA, answerId).turnId, firstTurn);

    // A ends: the queued input starts B alone, after the answer was delivered.
    f.codex.state.running = false;
    await f.service.poll(helper.agentId);
    const qDeliver = f.codex.calls.deliver.filter(call => call.message === 'Q waits behind A');
    assert.equal(qDeliver.length, 1, 'Q started B once after the answer');
    const turnB = `turn-${f.codex.state.turnSeq}`;
    assert.notEqual(turnB, firstTurn);
    const inspectB = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectB, q.requestId).delivery, 'new-turn');
    assert.equal(inputFor(inspectB, q.requestId).turnId, turnB);
  } finally { f.service.close(); }
});

test('Codex answer R and queued Q ready in one poll: R opens B alone, Q opens C afterwards', async () => {
  const f = await codexFixture();
  try {
    const helper = await startCodex(f);
    const firstTurn = helper.turnId;
    const q = await f.service.send({ name: helper.name, message: 'Q after the answer', mode: 'queue' }, extra(THREAD));
    await f.service.poll(helper.agentId);
    assert.equal(inputFor(await f.service.inspect({ name: helper.name }, extra(THREAD)), q.requestId).afterTurnId, firstTurn);

    f.codex.state.question = { id: 'codex-question-1', state: 'pending', message: 'Which input?' };
    const r = await f.service.send({ name: helper.name, message: 'R is the answer' }, extra(THREAD));
    assert.equal(r.delivery, 'answer-pending');
    assert.equal(f.codex.calls.answer.length, 1, 'R was registered as the answer');
    const beforePoll = f.codex.calls.deliver.length;

    // A ends before the next poll while a descendant remains active. The same poll now
    // sees an idle root, R ready and Q queued; only the root may decide the new turn.
    f.codex.state.running = false;
    f.codex.state.descendantRunning = true;
    await f.service.poll(helper.agentId);
    const after = f.codex.calls.deliver.slice(beforePoll);
    assert.equal(after.length, 1, 'the race poll made one start only');
    assert.equal(after[0].kind, 'answer');
    assert.match(after[0].message, /R is the answer/);
    assert.equal(after[0].message.includes('Q after the answer'), false, 'B carries R alone');
    const turnB = `turn-${f.codex.state.turnSeq}`;
    assert.notEqual(turnB, firstTurn);
    await f.service.poll(helper.agentId);
    const inspectB = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectB, r.requestId).delivery, 'answered');
    assert.equal(inputFor(inspectB, r.requestId).turnId, turnB);
    assert.equal(inputFor(inspectB, q.requestId).delivery, 'after-current');
    assert.equal(inputFor(inspectB, q.requestId).afterTurnId, turnB);

    f.codex.state.running = false;
    await f.service.poll(helper.agentId);
    const qDeliver = f.codex.calls.deliver.filter(call => call.message === 'Q after the answer');
    assert.equal(qDeliver.length, 1, 'Q started C exactly once');
    const turnC = `turn-${f.codex.state.turnSeq}`;
    const inspectC = await f.service.inspect({ name: helper.name }, extra(THREAD));
    assert.equal(inputFor(inspectC, q.requestId).delivery, 'new-turn');
    assert.equal(inputFor(inspectC, q.requestId).turnId, turnC);
    assert.equal(f.codex.calls.deliver.filter(call => call.message.includes('R is the answer')).length, 1);
    assert.equal(f.codex.calls.deliver.filter(call => call.message.includes('R is the answer'))[0].message.includes('Q after'), false,
      'B never contained Q');
  } finally { f.service.close(); }
});

for (const route of ['steer', 'start']) test(`Codex answer after a lost ${route} response recovers the original native receipt`, async () => {
  const f = await codexFixture();
  try {
    const name = `recover-${route}`;
    await f.service.create({ name, lifetime: 'persistent', target: 'codex-desktop' }, extra(THREAD));
    await f.service.send({ name, message: 'begin', effort: 'high' }, extra(THREAD));
    await f.service.poll(f.record(name).agentId);
    const turnA = f.codex.state.turnId;
    f.codex.state.question = { id: 'q-recovery', state: 'pending', message: 'Continue?' };
    const answer = await f.service.send({ name, message: 'yes' }, extra(THREAD));
    assert.equal(answer.delivery, 'answer-pending');
    if (route === 'start') f.codex.state.running = false;
    f.codex.state.loseNext = true;
    await f.service.poll(f.record(name).agentId);
    const restarted = f.reopen();
    await restarted.poll(f.record(name).agentId);
    const writes = f.codex.calls.deliver.filter(item => item.kind === 'answer');
    assert.equal(writes.length, 1);
    assert.equal(writes[0].requestId, answer.requestId);
    assert.equal(writes[0].model.requestedEffort, 'max');
    const row = inputFor(await restarted.inspect({ name }, extra(THREAD)), answer.requestId);
    assert.equal(row.actualEffort, route === 'steer' ? 'high' : 'max');
    assert.equal(row.turnId, route === 'steer' ? turnA : f.codex.state.turnId);
    assert.equal((await restarted.list(extra(THREAD))).items[0].actualEffort, row.actualEffort);
  } finally { f.service.close(); }
});

test('Codex explicit selection is not queued if active observation fails', async () => {
  const f = await codexFixture();
  try {
    const helper = await startCodex(f);
    const before = f.store.supplementInputs(helper.agentId).length;
    f.codex.state.observeFailure = true;
    await assert.rejects(f.service.send({ name: helper.name, message: 'do not queue', effort: 'high' }, extra(THREAD)),
      error => error.code === 'model-selection-unconfirmed' && error.notSent === true);
    assert.equal(f.store.supplementInputs(helper.agentId).length, before);
    assert.equal(f.codex.calls.deliver.length, 1);
  } finally { f.service.close(); }
});

test('a recovered not-sent rejection stays failed even if the turn ends', async () => {
  const f = await codexFixture();
  try {
    const helper = await startCodex(f);
    f.codex.state.question = { id: 'q-rejected', state: 'pending', message: 'Continue?' };
    const answer = await f.service.send({ name: helper.name, message: 'not written' }, extra(THREAD));
    f.codex.state.rejectNext = true;
    await f.service.poll(helper.agentId);
    f.codex.state.running = false;
    const restarted = f.reopen();
    await restarted.poll(helper.agentId);
    const row = inputFor(await restarted.inspect({ name: helper.name }, extra(THREAD)), answer.requestId);
    assert.equal(row.accepted, false);
    assert.equal(row.status, 'blocked');
    assert.equal(row.actualEffort, null);
    assert.equal(f.codex.calls.deliver.filter(item => item.kind === 'answer').length, 1);
  } finally { f.service.close(); }
});
