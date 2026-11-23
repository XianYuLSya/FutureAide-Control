// Answers to a managed Codex Desktop helper.
//
// A Codex helper's ask_parent is one MCP call: its turn does not end, and the helper
// keeps working on whatever does not depend on the answer. These cases run the real
// shared state machine, the real roster and the real Codex adapter, host and RPC
// selection (turn/steer for a running turn, turn/start for an idle thread); only
// the desktop's own RPC endpoint is a local stand-in.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';
import { answerOutcome, cancelledUnsentAnswer } from '../src/cleanup-input-receipts.mjs';
import { liveThread, liveTurn, livePage } from '../test/live-thread-fixture.mjs';
import { CODEX_MODELS } from '../test/assembly/renderer.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOSS = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });

/** The Codex Desktop RPC, reduced to threads and turns the adapter reads and writes. */
function codexDesktop(snapshot, { raceAnswer = false, loseStartReply = false, raceExternalTurn = false } = {}) {
  const threads = new Map(), calls = [], nativeAnswers = [];
  let created = 0, clock = 1793932679, externalStarted = false;
  if (snapshot) {
    for (const [id, thread] of snapshot.threads) threads.set(id, structuredClone(thread));
    calls.push(...snapshot.calls);
    created = snapshot.created;
    clock = snapshot.clock;
  }
  const textOf = input => (input ?? []).map(item => item.text ?? '').join('');
  const userItem = text => ({ id: `item-${++clock}`, type: 'userMessage', content: [{ type: 'text', text }] });
  const running = thread => thread.turns.find(turn => turn.status === 'inProgress');
  const find = id => {
    const thread = threads.get(id);
    if (!thread) throw Object.assign(new Error(`thread not found: ${id}`), { code: 'codex-thread-not-found' });
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
        threads.set(id, { id, cwd: params.cwd, name: null, turns: [], updatedAt: ++clock, model: 'gpt-6-astra', reasoningEffort: 'high' });
        return { thread: liveThread({ id, cwd: params.cwd, updatedAt: clock, model: 'gpt-6-astra', reasoningEffort: 'high' }) };
      }
      case 'thread/read':
      case 'thread/resume': {
        const thread = find(params.threadId);
        return { thread: liveThread({ id: thread.id, cwd: thread.cwd, name: thread.name, updatedAt: thread.updatedAt,
          model: thread.model, reasoningEffort: thread.reasoningEffort,
          status: running(thread) ? { type: 'active', activeFlags: thread.nativeCard ? ['waitingOnUserInput'] : [] }
            : { type: 'idle' } }) };
      }
      case 'thread/name/set': {
        const thread = find(params.threadId);
        thread.name = params.name; thread.updatedAt = ++clock;
        return {};
      }
      case 'thread/turns/list': {
        // Like the desktop, a summary page carries only a turn's first user message
        // and last agent message: input steered into the turn is not on it.
        const items = turn => params.itemsView !== 'summary' ? []
          : [turn.items.find(item => item.type === 'userMessage'), turn.items.findLast(item => item.type === 'agentMessage')].filter(Boolean);
        return livePage(find(params.threadId).turns.toReversed().map(turn => liveTurn({ id: turn.id, rootTurnId: turn.id,
          status: turn.status, startedAt: turn.startedAt, itemsView: params.itemsView, items: items(turn) })));
      }
      case 'turn/start': {
        if (loseStartReply && textOf(params.input).includes('answer-probe')) {
          throw Object.assign(new Error('the start reply was lost'), { code: 'uncertain' });
        }
        const thread = find(params.threadId);
        if (raceExternalTurn && textOf(params.input).includes('answer-probe') && !externalStarted) {
          // Another client starts a turn between our root read and this start.
          externalStarted = true;
          thread.turns.push({ id: 'external-racing-root', status: 'inProgress', startedAt: ++clock, items: [userItem('external turn')] });
        }
        if (running(thread)) throw Object.assign(new Error('a turn is already running on this thread'), { code: 'codex-native-rpc-rejected' });
        // A turn is the only place a selection can change; the thread reports it afterwards.
        if (params.model !== undefined) thread.model = params.model;
        if (params.effort !== undefined) thread.reasoningEffort = params.effort;
        const turn = { id: `turn-${++clock}`, status: 'inProgress', startedAt: ++clock, items: [userItem(textOf(params.input))] };
        thread.turns.push(turn); thread.updatedAt = ++clock;
        return { turn: liveTurn({ id: turn.id, rootTurnId: turn.id, status: 'inProgress', items: [] }) };
      }
      case 'turn/steer': {
        const thread = find(params.threadId);
        // The helper's turn ends between the root read and this steer: the native
        // side rejects the write without consuming the input.
        if (raceAnswer && textOf(params.input).includes('answer-probe') && running(thread)) {
          running(thread).status = 'completed'; thread.updatedAt = ++clock;
        }
        const turn = running(thread);
        if (!turn || turn.id !== params.expectedTurnId) throw Object.assign(new Error('no active turn to steer'), { code: 'codex-native-rpc-rejected' });
        turn.items.push(userItem(textOf(params.input))); thread.updatedAt = ++clock;
        return { turnId: turn.id };
      }
      case 'futureaide/userInput/read': {
        const thread = find(params.threadId);
        return { status: 'observed', requests: thread.nativeCard ? [thread.nativeCard] : [] };
      }
      case 'futureaide/userInput/reply': {
        const thread = find(params.card.threadId);
        if (thread.nativeCard?.requestId !== params.card.requestId) return { status: 'not-pending' };
        if (thread.forceInterrupt) return { status: 'unsupported' };
        nativeAnswers.push(params.answers);
        delete thread.nativeCard;
        return { status: 'answered' };
      }
      case 'turn/interrupt': {
        const thread = find(params.threadId), turn = running(thread);
        assert.equal(params.turnId, turn?.id);
        turn.status = 'interrupted';
        delete thread.nativeCard;
        thread.updatedAt = ++clock;
        return {};
      }
      default: throw new Error(`unexpected native method ${method}`);
    }
  }
  return {
    request,
    calls,
    snapshot: () => structuredClone({ threads: [...threads], calls, created, clock }),
    threadIds: () => [...threads.keys()],
    runningTurn: threadId => running(find(threadId))?.id,
    nativeAnswers,
    interruptCalls: () => calls.filter(call => call.method === 'turn/interrupt'),
    askNative(threadId, { forceInterrupt = false } = {}) {
      const thread = find(threadId);
      thread.forceInterrupt = forceInterrupt;
      thread.nativeCard = { requestId: 91, threadId, turnId: running(thread).id, itemId: 'native-item',
        kind: 'question', isBlocking: true, questions: [{ id: 'location', header: 'First run',
          question: 'Where should the first run start?', isOther: false, isSecret: false,
          options: [{ label: 'Local', description: 'Start it in the current project.' },
            { label: 'Remote', description: 'Start it on the test server.' }] }] };
      thread.updatedAt = ++clock;
    },
    /** Text the helper thread received, optionally by the RPC that carried it. */
    inputs: method => calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method) && (!method || call.method === method))
      .map(call => ({ method: call.method, turnId: call.params.expectedTurnId, text: textOf(call.params.input), params: call.params })),
    /** The helper's turn ends with an ordinary reply, which never reports to the parent. */
    endTurn(threadId, reply) {
      const thread = find(threadId), turn = running(thread);
      assert.ok(turn, 'the helper has a running turn to end');
      turn.items.push({ id: `item-${++clock}`, type: 'agentMessage', text: reply });
      turn.status = 'completed'; thread.updatedAt = ++clock;
    },
  };
}

async function fixture({ onBackend, host, directory, snapshot, raceAnswer = false, loseStartReply = false, raceExternalTurn = false,
  raceBeforeAnswer, registration = { ready: true } } = {}) {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = directory ?? await mkdtemp(path.join(base, 'answer-'));
  const store = new RosterStore(path.join(stateDirectory, 'roster.sqlite'));
  const codex = codexDesktop(snapshot, { raceAnswer, loseStartReply, raceExternalTurn });
  const notices = [];
  const service = createScopedAgents({ stateDirectory, workspace, configFile: path.join(stateDirectory, 'config.json'), target: 'dsh' }, {
    store,
    clientFactory: () => { throw new Error('no DSH host is needed for these cases'); },
    // The calling chat: what it is told arrives here.
    callCodex: async (threadId, tool, args) => {
      if (tool === 'read_thread') return { thread: { id: threadId, kind: 'codex', hostId: 'local', cwd: workspace } };
      notices.push(args.prompt);
      return { accepted: true };
    },
    backendAdapters: { 'codex-desktop': async (record, deps) => {
      let insideAnswer = false;
      const options = { ...deps, ...(host ? { host } : {}), hostOptions: { nativeRequest: codex.request } };
      if (raceBeforeAnswer) {
        options.withHostLock = (action, ...args) => deps.withHostLock(async () => {
          if (insideAnswer && raceBeforeAnswer) {
            const inject = raceBeforeAnswer;
            raceBeforeAnswer = undefined;
            await inject(codex);
          }
          return action();
        }, ...args);
      }
      const backend = await createCodexBackend(record, options);
      if (raceBeforeAnswer) {
        const deliver = backend.deliver.bind(backend);
        backend.deliver = async args => {
          insideAnswer = args.kind === 'answer';
          try { return await deliver(args); } finally { insideAnswer = false; }
        };
      }
      onBackend?.(backend);
      return backend;
    } },
    codexProbeRegistration: async () => ({ ready: registration.ready !== false,
      registered: registration.ready !== false, tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  const record = name => store.named(ownerIdFor(BOSS), name);
  return {
    service, store, codex, notices, record, stateDirectory, registration,
    /** Create a persistent Codex helper, hand it a task and let the first turn start. */
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
    // What the helper does from inside its own conversation.
    ask: (helper, message) => service.submitToParent({ kind: 'ask', message }, extra(helper.threadId)),
    report: (helper, message, final = false) => service.submitToParent({ kind: 'report', message, final }, extra(helper.threadId)),
    answer: (helper, message) => service.answer({ name: helper.name, message }, extra(BOSS)),
  };
}

const outcome = promise => promise.then(() => 'accepted', error => error);

for (const hasRecoverableReceipt of [false, true]) {
  test(`fourteen unknown dispatches share a snapshot; receipt reconciliation ${hasRecoverableReceipt ? 'can settle one' : 'is still attempted'}`, async () => {
    const receipts = [], reconciled = [];
    const f = await fixture({
      onBackend: backend => {
        const receipt = backend.receipt.bind(backend);
        backend.receipt = async args => { receipts.push(args.requestId); return receipt(args); };
      },
      ...(hasRecoverableReceipt ? { host: { findDispatchInput: async input => {
        reconciled.push(input.marker);
        return { status: 'found', turnId: 'recovered-turn', firstUser: true };
      } } } : {}),
    });
    try {
      const helper = await f.start('unknown-snapshot', 'synthetic task');
      const record = f.record(helper.name);
      record.task.dispatches = Array.from({ length: 14 }, (_, i) => ({
        requestId: `unknown-${i}`, kind: 'supplement', state: 'unknown', accepted: false,
        message: 'synthetic', startedAt: new Date().toISOString(),
      }));
      f.store.save(record);
      if (hasRecoverableReceipt) {
        const native = f.store.backendState(helper.agentId);
        native.requests['unknown-0'] = { requestId: 'unknown-0', status: 'unknown', marker: 'synthetic-marker',
          intent: { method: 'turn/start', priorTurnId: 'older-turn' } };
        f.store.saveBackendState(helper.agentId, native);
      }
      receipts.length = 0;
      const before = f.codex.calls.length;
      await f.poll(helper);
      const calls = f.codex.calls.slice(before);
      assert.deepEqual(receipts, Array.from({ length: 14 }, (_, i) => `unknown-${i}`));
      assert.equal(calls.filter(call => call.method === 'thread/turns/list').length, hasRecoverableReceipt ? 2 : 1);
      assert.equal(calls.filter(call => ['turn/start', 'turn/steer'].includes(call.method)).length, 0);
      if (hasRecoverableReceipt) {
        assert.deepEqual(reconciled, ['synthetic-marker']);
        assert.equal(f.store.backendState(helper.agentId).requests['unknown-0'].status, 'accepted');
      }
    } finally { f.store.close(); }
  });
}

test('a recovered dispatch that writes refreshes the shared snapshot before later unknowns', async () => {
  const receipts = [];
  const f = await fixture({ onBackend: backend => {
    const receipt = backend.receipt.bind(backend);
    backend.receipt = async args => { receipts.push(args.requestId); return receipt(args); };
  } });
  try {
    const helper = await f.start('write-between-snapshots', 'synthetic task');
    const record = f.record(helper.name);
    record.task.dispatches = Array.from({ length: 14 }, (_, i) => ({
      requestId: `unknown-${i}`, kind: 'supplement', state: i === 0 ? 'retrying' : 'unknown',
      accepted: false, message: 'synthetic', startedAt: new Date().toISOString(),
    }));
    f.store.save(record);
    receipts.length = 0;
    const before = f.codex.calls.length;
    await f.poll(helper);
    const calls = f.codex.calls.slice(before);
    const write = calls.findIndex(call => call.method === 'turn/steer');
    assert.ok(write >= 0, 'retry actually writes');
    assert.ok(calls.slice(write + 1).some(call => call.method === 'thread/turns/list'), 'the post-write view was refreshed');
    assert.ok(calls.slice(write + 1).filter(call => call.method === 'thread/turns/list').length <= 2,
      'the later unknowns share the post-write view');
    assert.deepEqual(receipts, Array.from({ length: 14 }, (_, i) => `unknown-${i}`));
  } finally { f.store.close(); }
});

test('a native card reaches the parent once and the answer returns to that same turn', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Prepare the first run.');
    const taskId = f.record(lead.name).task.taskId;
    f.codex.askNative(lead.threadId);
    await f.poll(lead); await f.poll(lead);
    assert.equal(f.record(lead.name).state, 'awaiting_input');
    assert.equal(f.notices.filter(text => text.includes('Where should the first run start?')).length, 1);
    assert.match(f.notices.at(-1), /Local[\s\S]*Remote[\s\S]*futureaide_answer_agent/);

    await assert.rejects(f.answer(lead, 'Invalid label'), { code: 'native-answer-invalid' });
    await f.poll(lead);
    assert.equal(f.record(lead.name).state, 'awaiting_input');
    assert.equal(f.codex.nativeAnswers.length, 0);
    assert.equal((await f.answer(lead, 'Local')).delivery, 'native-question');
    await f.poll(lead);

    assert.deepEqual(f.codex.nativeAnswers, [{ location: { answers: ['Local'] } }]);
    assert.equal(f.codex.runningTurn(lead.threadId), lead.turnId);
    assert.equal(f.codex.inputs().length, 1, 'the native response needs no ordinary input');
    assert.equal(f.record(lead.name).task.taskId, taskId);
    assert.equal(f.record(lead.name).state, 'running');
  } finally { f.service.close(); }
});

test('a card that cannot be answered is withdrawn before one ordinary continuation', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Prepare the first run.');
    const taskId = f.record(lead.name).task.taskId;
    f.codex.askNative(lead.threadId, { forceInterrupt: true });
    await f.poll(lead);
    assert.equal((await f.answer(lead, 'Local')).delivery, 'continuation-queued');
    await f.poll(lead); await f.poll(lead);
    assert.deepEqual(f.codex.interruptCalls().map(call => call.params), [{ threadId: lead.threadId, turnId: lead.turnId }]);
    assert.equal(f.codex.nativeAnswers.length, 0);
    assert.equal(f.codex.inputs('turn/start').length, 2);
    assert.match(f.codex.inputs('turn/start').at(-1).text, /^Parent answer:\nLocal\b/);
    assert.equal(f.record(lead.name).task.taskId, taskId);
  } finally { f.service.close(); }
});

test('an explicit question and a native card are answered in the order they were presented', async () => {
  for (const nativeFirst of [false, true]) {
    const f = await fixture();
    try {
      const lead = await f.start('lead', 'Prepare the first run.');
      if (nativeFirst) {
        f.codex.askNative(lead.threadId);
        await f.poll(lead);
      }
      await f.ask(lead, 'Which input should the preparation use?');
      if (!nativeFirst) f.codex.askNative(lead.threadId);
      await f.poll(lead);
      const first = nativeFirst ? 'Where should the first run start?' : 'Which input should the preparation use?';
      const next = nativeFirst ? 'Which input should the preparation use?' : 'Where should the first run start?';
      assert.equal(f.notices.length, 1);
      assert.ok(f.notices[0].includes(first));

      assert.equal((await f.answer(lead, 'Local')).answered, true);
      await f.poll(lead);
      assert.equal(f.codex.nativeAnswers.length, nativeFirst ? 1 : 0);
      assert.ok(f.notices[1]?.includes(next));
      assert.equal((await f.answer(lead, 'Remote')).answered, true);
      await f.poll(lead);
      assert.deepEqual(f.codex.nativeAnswers, [{ location: { answers: [nativeFirst ? 'Local' : 'Remote'] } }]);
      const steered = f.codex.inputs('turn/steer');
      assert.equal(steered.length, 1);
      assert.ok(steered[0].text.includes(nativeFirst ? 'Remote' : 'Local'));
    } finally { f.service.close(); }
  }
});

test('an answer given while the Codex turn is running is steered into that turn', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    await f.ask(lead, 'Three contracts need your call.');
    await f.poll(lead);
    assert.equal(f.record('lead').state, 'awaiting_input');
    assert.match(f.notices.at(-1), /Three contracts need your call\./, 'the caller is asked');

    assert.equal((await f.answer(lead, 'Take your recommendation on all three.')).answered, true);
    await f.poll(lead);

    // The helper is still inside the turn that asked: the answer has to go into it.
    assert.equal(f.codex.runningTurn(lead.threadId), lead.turnId);
    const steered = f.codex.inputs('turn/steer');
    assert.equal(steered.length, 1, 'the answer reaches the running turn without waiting for it to end');
    assert.equal(steered[0].turnId, lead.turnId);
    assert.match(steered[0].text, /^Parent answer:\nTake your recommendation on all three\./);
    assert.equal(f.codex.inputs('turn/start').length, 1, 'no second turn is started to carry it');
    assert.equal(f.record('lead').task.answers[0].dispatched, true);

    // With the answer in hand the same turn finishes everything and reports once.
    await f.report(lead, 'All ten fixed.', true);
    f.codex.endTurn(lead.threadId, 'done');
    await f.poll(lead); await f.poll(lead);
    assert.equal(f.record('lead').task.state, 'completed');
    assert.match(f.notices.at(-1), /All ten fixed\./);
    assert.equal(f.codex.inputs().length, 2, 'the task and the answer are the only inputs the helper ever received');
  } finally { f.service.close(); }
});

test('a helper with a selected model receives the steered answer with no selection fields', async () => {
  const f = await fixture();
  try {
    // Team leads are dispatched with an explicit model and effort; the answer carries
    // that same frozen selection, which a running turn can only keep.
    const lead = await f.start('lead', 'Fix the ten places.', { model: 'luna', effort: 'low' });
    assert.deepEqual([f.codex.inputs('turn/start')[0].params.model, f.codex.inputs('turn/start')[0].params.effort], ['gpt-6-luna', 'low']);
    await f.ask(lead, 'Three contracts need your call.');
    await f.poll(lead);
    await f.answer(lead, 'Take your recommendation on all three.');
    await f.poll(lead);

    const [steered] = f.codex.inputs('turn/steer');
    assert.ok(steered, 'the answer is steered into the running turn');
    assert.match(steered.text, /^Parent answer:\nTake your recommendation on all three\./);
    for (const field of ['model', 'effort']) assert.equal(field in steered.params, false, `${field} is never sent on a steer`);
    const dispatch = f.record('lead').task.dispatches.at(-1);
    assert.deepEqual([dispatch.kind, dispatch.accepted, dispatch.state], ['answer', true, 'running']);
    assert.equal(f.record('lead').state, 'running');
  } finally { f.service.close(); }
});

test('a final report sent before the accepted answer was delivered cannot seal the task without it', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    await f.ask(lead, 'Four contracts need your call.');
    await f.poll(lead);
    assert.equal((await f.answer(lead, 'Do all four as recommended.')).answered, true);

    // The helper closes its turn with a final report before the answer reached it.
    const early = await outcome(f.report(lead, 'Six fixed, four waiting for the boss.', true));
    f.codex.endTurn(lead.threadId, 'six of ten');
    await f.poll(lead); await f.poll(lead);

    const delivered = f.codex.inputs().filter(input => input.text.startsWith('Parent answer:\nDo all four as recommended.'));
    assert.equal(delivered.length, 1, 'the answer the caller gave still reaches the helper');
    assert.notEqual(early, 'accepted', 'a final report is refused while the answer is on its way');
    assert.equal(early.code, 'answer-undelivered');
    assert.match(early.message, /Parent answer:/, 'the refusal tells the helper what to wait for');
    assert.notEqual(f.record('lead').task.state, 'completed', 'the task stays open for the remaining work');
    assert.equal(f.notices.some(text => text.includes('Six fixed, four waiting')), false, 'the caller never receives the stale final');

    // The helper applies the answer in the turn it started and then finishes.
    await f.report(lead, 'All ten fixed.', true);
    f.codex.endTurn(lead.threadId, 'all ten');
    await f.poll(lead); await f.poll(lead);
    assert.equal(f.record('lead').task.state, 'completed');
    assert.match(f.notices.at(-1), /All ten fixed\./);
  } finally { f.service.close(); }
});

test('a final report attempted while the question is unanswered waits for the answer', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    await f.ask(lead, 'Which contract applies?');
    await f.poll(lead);

    const early = await outcome(f.report(lead, 'Six fixed, four waiting for the boss.', true));
    f.codex.endTurn(lead.threadId, 'six of ten');
    await f.poll(lead);
    assert.equal(f.record('lead').state, 'awaiting_input', 'the open question is what the task waits for');

    // The caller answers after the helper's turn has ended.
    assert.equal((await f.answer(lead, 'Contract B.')).answered, true);
    await f.poll(lead); await f.poll(lead);

    const delivered = f.codex.inputs('turn/start').filter(input => input.text.startsWith('Parent answer:\nContract B.'));
    assert.equal(delivered.length, 1, 'the answer starts the turn the helper was waiting for');
    assert.notEqual(early, 'accepted', 'a final report is refused while its own question is open');
    assert.equal(early.code, 'question-unanswered');
    assert.notEqual(f.record('lead').task.state, 'completed');
    assert.equal(f.notices.some(text => text.includes('Six fixed, four waiting')), false);

    // A progress report was never the problem: only a final one seals a task.
    assert.equal((await f.report(lead, 'Applying contract B.')).accepted, true);
    await f.report(lead, 'All ten fixed.', true);
    f.codex.endTurn(lead.threadId, 'all ten');
    await f.poll(lead); await f.poll(lead);
    assert.equal(f.record('lead').task.state, 'completed');
    assert.match(f.notices.at(-1), /All ten fixed\./);
  } finally { f.service.close(); }
});

for (const lifetime of ['persistent', 'once']) test(`a sealed ${lifetime} round keeps the only copy of a direct answer`, async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.', { lifetime });
    await f.ask(lead, 'Which contract applies?');
    await f.poll(lead);
    // A task left in this state by a version that still accepted the early final.
    f.store.enqueueSubmission({ id: 'legacy-final', ownerId: ownerIdFor(BOSS), agentId: lead.agentId,
      taskId: f.record('lead').task.taskId, kind: 'report', message: 'Six fixed, four waiting for the boss.', final: true });
    f.codex.endTurn(lead.threadId, 'six of ten');
    await f.poll(lead);
    assert.equal(f.record('lead').state, 'awaiting_input');

    const receipt = await f.answer(lead, 'Contract B.');
    assert.equal(receipt.answered, false, 'the caller is not told the task resumes');
    assert.equal(receipt.error.code, 'answer-not-delivered');
    const answerId = f.record('lead').task.answers.at(-1).answerId;
    await f.poll(lead); await f.poll(lead);
    const retained = f.record('lead').task.answers.find(answer => answer.answerId === answerId);
    assert.equal(retained.message, 'Contract B.');
    assert.equal(retained.undelivered, 'final-submitted');

    assert.equal(f.codex.inputs().some(input => input.text.includes('Contract B.')), false, 'nothing is written into the finished conversation');
    assert.equal(f.record('lead').task.state, 'completed', 'the held final report is released');
    assert.match(f.notices.at(-1), /Six fixed, four waiting for the boss\./);
  } finally { f.service.close(); }
});

test('the headless CLI report entry refuses a final report under the same rule', () => {
  // The Claude CLI helper reports through the store directly, bound to its dispatch.
  const store = new RosterStore(':memory:');
  try {
    const at = new Date().toISOString();
    store.insert({ agentId: 'agent-cli', ownerId: 'owner-cli', sessionId: 'session-cli', name: 'cli', lifetime: 'persistent',
      target: 'claude-cli', workspace, state: 'running', created: true, createdAt: at, updatedAt: at, history: [],
      task: { taskId: 'task-cli', message: 'work', state: 'running', startedAt: at, answers: [],
        dispatches: [{ requestId: 'request-1', kind: 'task', state: 'running', accepted: true }] } });
    const turn = requestId => ({ taskId: 'task-cli', requestId });
    const final = requestId => store.submitParentMessage('agent-cli', { kind: 'report', message: 'done', final: true }, turn(requestId));

    const asked = store.submitParentMessage('agent-cli', { kind: 'ask', message: 'Which one?' }, turn('request-1'));
    assert.throws(() => final('request-1'), { code: 'question-unanswered' });
    assert.equal(store.submitParentMessage('agent-cli', { kind: 'report', message: 'half way' }, turn('request-1')).accepted, true);

    // The parent answered; the CLI turn is still running, so the answer waits for it.
    const record = store.get('agent-cli');
    // The id the shared layer gives a stored question, written out so this case pins it.
    const questionId = `submission:${asked.submissionId}`;
    record.task.answers.push({ answerId: 'answer-1', message: 'B', dispatched: false, questionIds: [questionId] });
    store.save(record);
    assert.throws(() => final('request-1'), { code: 'answer-undelivered' });

    // A dispatch that is still being retried is on its way too.
    record.task.answers[0].dispatched = true;
    record.task.dispatches.push({ requestId: 'request-2', kind: 'answer', answerIds: [questionId], state: 'retrying', accepted: false });
    store.save(record);
    assert.throws(() => final('request-2'), { code: 'answer-undelivered' });

    // A write whose outcome is unknown is never sent again: it cannot hold the task open.
    record.task.dispatches.at(-1).state = 'unknown';
    store.save(record);
    assert.deepEqual(store.openQuestions(store.get('agent-cli')), { unanswered: 0, undelivered: 0 });

    // The answer went out as the next turn: that turn may report the task complete.
    Object.assign(record.task.dispatches.at(-1), { state: 'running', accepted: true });
    store.save(record);
    assert.equal(final('request-2').accepted, true);
  } finally { store.close(); }
});

// A restart seed: one poll has registered the answer and the native steer was
// rejected because the helper's turn ended at the same moment. The answer dispatch
// is left queued with its original request id and a native `retryable` receipt.
async function answerRaceSeed({ queuedInput = false, ageMs = 0 } = {}) {
  const first = await fixture({ raceAnswer: true });
  const lead = await first.start('lead', 'Fix the ten places.');
  if (queuedInput) await first.service.send({ name: 'lead', message: 'ordinary queued input', mode: 'queue' }, extra(BOSS));
  await first.ask(lead, 'Which contract applies?');
  await first.poll(lead);
  const receipt = await first.service.send({ name: 'lead', message: 'Recover raced answer answer-probe' }, extra(BOSS));
  await first.poll(lead);
  const record = first.record('lead');
  const dispatch = record.task.dispatches.find(entry => entry.kind === 'answer' && entry.requestId === receipt.requestId);
  assert.ok(dispatch, 'the answer dispatch exists after its rejected steer');
  assert.equal(dispatch.state, 'queued', 'the rejected steer is a local wait, not a delivery');
  if (ageMs) {
    const answer = record.task.answers.find(entry => entry.answerId === receipt.requestId);
    answer.created = new Date(Date.now() - ageMs).toISOString();
    dispatch.requestedAt = answer.created;
    first.store.save(record);
  }
  const seed = { directory: first.stateDirectory, desktop: first.codex.snapshot(),
    agentId: lead.agentId, threadId: lead.threadId, requestId: receipt.requestId };
  first.service.close();
  return seed;
}

const answerWrites = f => f.codex.inputs().filter(input => input.text.includes('answer-probe'));
const queueWrites = f => f.codex.inputs().filter(input => input.text.includes('ordinary queued input'));
const answerDispatch = (f, requestId) => f.record('lead').task.dispatches
  .find(entry => entry.kind === 'answer' && entry.requestId === requestId);
const pollTimes = async (f, seed, times = 5) => {
  for (let index = 0; index < times; index++) await f.service.poll(seed.agentId);
};

/** Age an answer by its caller's original clock, never by a later poll. */
const ageAnswer = (f, seed, ageMs = 7 * 60 * 60 * 1000) => {
  const record = f.record('lead');
  const answer = record.task.answers.find(entry => entry.answerId === seed.requestId);
  const dispatch = record.task.dispatches.find(entry => entry.requestId === seed.requestId);
  dispatch.requestedAt = answer.created = new Date(Date.now() - ageMs).toISOString();
  f.store.save(record);
};

test('a rejected answer steer recovers as one new turn under the same request id after restart', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    await pollTimes(f, seed);
    const dispatch = answerDispatch(f, seed.requestId);
    assert.equal(dispatch.requestId, seed.requestId, 'the recovery keeps the original request id');
    assert.deepEqual([dispatch.accepted, dispatch.delivery], [true, 'new-turn']);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start']);
    assert.ok(answerWrites(f).every(input => input.text.includes(seed.requestId)));
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.equal(row.delivery, 'answered');

    const before = f.codex.inputs().length;
    await f.service.poll(seed.agentId);
    await f.service.poll(seed.agentId);
    assert.equal(f.codex.inputs().length, before, 'an accepted answer is never replayed by later polls');
  } finally { f.service.close(); }
});

test('an answer recovery takes the turn before a queued input that was enqueued first', async () => {
  const seed = await answerRaceSeed({ queuedInput: true });
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    await pollTimes(f, seed);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start']);
    assert.deepEqual(queueWrites(f), [], 'the queued input waits while the answer turn is live');

    f.codex.endTurn(seed.threadId, 'answer applied');
    await f.service.poll(seed.agentId);
    await f.service.poll(seed.agentId);
    assert.deepEqual(queueWrites(f).map(input => input.method), ['turn/start'], 'the queued input starts only after the answer turn');
  } finally { f.service.close(); }
});

test('an answer older than six hours is settled from its original requestedAt without another write or expiry', async () => {
  const seed = await answerRaceSeed({ ageMs: 7 * 60 * 60 * 1000 });
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    await pollTimes(f, seed);
    const dispatch = answerDispatch(f, seed.requestId);
    assert.equal(dispatch.accepted, false);
    assert.equal(dispatch.expired, 'dispatch-expired');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer'], 'an expired answer never starts a turn');
    const record = f.record('lead');
    const answer = record.task.answers.find(entry => entry.answerId === seed.requestId);
    assert.equal(answer.undelivered, 'dispatch-expired');
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.equal(row.delivery, 'blocked');
    assert.equal(row.reason, 'dispatch-expired');
    assert.equal(row.queued, false);

    const expiredCount = record.expired?.count;
    await f.service.poll(seed.agentId);
    assert.equal(f.record('lead').expired?.count, expiredCount, 'the same expired answer is not expired twice');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer']);
  } finally { f.service.close(); }
});

test('a second start attempt with an unknown outcome is never replayed from the old steer rejection', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop, loseStartReply: true });
  try {
    await pollTimes(f, seed);
    const dispatch = answerDispatch(f, seed.requestId);
    assert.equal(dispatch.accepted, false);
    assert.equal(dispatch.state, 'unknown');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start']);
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.equal(row.delivery, 'unknown');

    const before = f.codex.inputs().length;
    await pollTimes(f, seed);
    assert.equal(f.codex.inputs().length, before, 'an unproven second attempt is never sent again');
  } finally { f.service.close(); }
});

test('a cancelled answer reports its terminal reason instead of a queued answer', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    await f.service.cancel({ name: 'lead' }, extra(BOSS));
    await pollTimes(f, seed);
    const dispatch = answerDispatch(f, seed.requestId);
    assert.equal(dispatch.state, 'cancelled');
    assert.equal(dispatch.accepted, false);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer'], 'a cancelled answer never starts a turn');
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.equal(row.delivery, 'blocked');
    assert.equal(row.reason, 'cancelled');
    assert.equal(row.queued, false);
  } finally { f.service.close(); }
});

test('a final report still cannot seal a round whose answer recovery is pending', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    await assert.rejects(f.report({ threadId: seed.threadId }, 'work finished', true), /parent has answered/);
    await pollTimes(f, seed);
    assert.equal(answerDispatch(f, seed.requestId).accepted, true);
  } finally { f.service.close(); }
});

test('an answer start that loses the race waits for the other turn and then writes once', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop, raceExternalTurn: true });
  try {
    for (let index = 0; index < 5; index++) {
      await f.service.poll(seed.agentId);
      if (f.codex.runningTurn(seed.threadId) === 'external-racing-root') f.codex.endTurn(seed.threadId, 'external done');
    }
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start', 'turn/start'],
      'the rejected race start is retried only after the other turn ends');
    const dispatch = answerDispatch(f, seed.requestId);
    assert.deepEqual([dispatch.accepted, dispatch.delivery], [true, 'new-turn']);
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.equal(row.delivery, 'answered');

    const before = f.codex.inputs().length;
    await f.service.poll(seed.agentId);
    await f.service.poll(seed.agentId);
    assert.equal(f.codex.inputs().length, before, 'the answer is not written into the other turn or duplicated');
  } finally { f.service.close(); }
});

test('a read-only retryable answer is retried after restart instead of becoming permanently unknown', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    // The adapter's 9cc875b shape: a read failed before the write, so the request is
    // retryable with attempted:false and no intent, route or reschedule.
    const record = f.record('lead');
    const dispatch = answerDispatch(f, seed.requestId);
    const backendState = f.store.backendState(seed.agentId);
    const request = backendState.requests[dispatch.requestId];
    delete request.intent; delete request.reschedule; delete request.route; delete request.afterTurnId;
    request.attempted = false; request.status = 'retryable';
    f.store.saveBackendState(seed.agentId, backendState);
    delete dispatch.delivery; dispatch.state = 'retrying'; delete dispatch.nextAttemptAt;
    f.store.save(record);

    await pollTimes(f, seed);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start']);
    const recovered = answerDispatch(f, seed.requestId);
    assert.deepEqual([recovered.accepted, recovered.delivery], [true, 'new-turn']);
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.equal(row.delivery, 'answered');
  } finally { f.service.close(); }
});

test('legacy unknown answer with a native not-sent receipt retries the original request once', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.kind === 'answer' && entry.requestId === seed.requestId);
    dispatch.state = 'unknown'; dispatch.delivery = 'unknown';
    f.store.save(record);
    const request = f.store.backendState(seed.agentId).requests[seed.requestId];
    assert.equal(request.status, 'retryable');
    assert.equal(request.reschedule.notSent, true);
    await pollTimes(f, seed);
    assert.equal(answerDispatch(f, seed.requestId).accepted, true);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start']);
    assert.ok(answerWrites(f).every(input => input.text.includes(seed.requestId)));
    await pollTimes(f, seed);
    assert.equal(answerWrites(f).length, 2);
  } finally { f.service.close(); }
});

test('legacy unknown answer with a proven pre-write read failure resumes once', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.requestId === seed.requestId);
    dispatch.state = 'unknown'; dispatch.delivery = 'unknown'; f.store.save(record);
    const state = f.store.backendState(seed.agentId), request = state.requests[seed.requestId];
    delete request.intent; delete request.route; delete request.reschedule; delete request.afterTurnId;
    request.attempted = false; request.status = 'retryable';
    f.store.saveBackendState(seed.agentId, state);
    await pollTimes(f, seed);
    assert.equal(answerDispatch(f, seed.requestId).accepted, true);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start']);
    assert.ok(answerWrites(f).every(input => input.text.includes(seed.requestId)));
  } finally { f.service.close(); }
});

test('legacy unknown answer with no proof of non-write is not replayed', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.kind === 'answer' && entry.requestId === seed.requestId);
    dispatch.state = 'unknown'; dispatch.delivery = 'unknown'; f.store.save(record);
    const state = f.store.backendState(seed.agentId), request = state.requests[seed.requestId];
    request.status = 'retryable'; delete request.reschedule;
    if (request.intent) delete request.intent.outcome;
    f.store.saveBackendState(seed.agentId, state);
    await pollTimes(f, seed);
    assert.equal(answerDispatch(f, seed.requestId).accepted, false);
    assert.equal(answerDispatch(f, seed.requestId).state, 'unknown');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer']);
  } finally { f.service.close(); }
});

test('expired legacy unknown answer with a not-sent receipt is not replayed', async () => {
  const seed = await answerRaceSeed({ ageMs: 7 * 60 * 60 * 1000 });
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.kind === 'answer' && entry.requestId === seed.requestId);
    dispatch.state = 'unknown'; dispatch.delivery = 'unknown'; f.store.save(record);
    await pollTimes(f, seed);
    assert.equal(answerDispatch(f, seed.requestId).accepted, false);
    assert.equal(answerDispatch(f, seed.requestId).expired, 'dispatch-expired');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer']);
  } finally { f.service.close(); }
});

test('legacy unknown answer does not reuse old not-sent evidence over a newer intent', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.kind === 'answer' && entry.requestId === seed.requestId);
    dispatch.state = 'unknown'; dispatch.delivery = 'unknown'; f.store.save(record);
    const state = f.store.backendState(seed.agentId), request = state.requests[seed.requestId];
    assert.equal(request.reschedule.notSent, true);
    request.status = 'retryable'; request.intent.outcome = 'pending';
    f.store.saveBackendState(seed.agentId, state);
    await pollTimes(f, seed);
    assert.equal(answerDispatch(f, seed.requestId).state, 'unknown');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer']);
  } finally { f.service.close(); }
});

test('a legacy unknown answer with a proven pre-write read failure takes the turn before the queued input', async () => {
  const seed = await answerRaceSeed({ queuedInput: true });
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.kind === 'answer' && entry.requestId === seed.requestId);
    dispatch.state = 'unknown'; dispatch.delivery = 'unknown'; f.store.save(record);
    const state = f.store.backendState(seed.agentId), request = state.requests[seed.requestId];
    delete request.intent; delete request.route; delete request.reschedule; delete request.afterTurnId;
    request.attempted = false; request.status = 'retryable';
    f.store.saveBackendState(seed.agentId, state);

    await pollTimes(f, seed, 2);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start'],
      'the proven-unwritten answer resumes as one turn under the original request');
    assert.ok(answerWrites(f).every(input => input.text.includes(seed.requestId)));
    assert.deepEqual(queueWrites(f), [], 'the queued input waits behind the recovered answer turn');
    const recovered = answerDispatch(f, seed.requestId);
    assert.deepEqual([recovered.accepted, recovered.delivery], [true, 'new-turn']);
  } finally { f.service.close(); }
});

test('a temporary registration probe keeps the answer recoverable and ahead of the queued input', async () => {
  const seed = await answerRaceSeed({ queuedInput: true });
  const registration = { ready: false };
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop, registration });
  try {
    await f.poll(seed);
    const dispatch = answerDispatch(f, seed.requestId);
    assert.equal(dispatch.state, 'retrying', 'a read-only preflight refusal is not a failed send');
    assert.equal(dispatch.error.code, 'codex-report-not-ready');
    assert.ok(dispatch.nextAttemptAt > Date.now(), 'repeated refusals keep the normal backoff');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer']);
    assert.deepEqual(queueWrites(f), [], 'Q never starts while R is waiting out its backoff or recovery');

    registration.ready = true;
    await delay(Math.max(0, dispatch.nextAttemptAt - Date.now()) + 50);
    await f.poll(seed);
    const recovered = answerDispatch(f, seed.requestId);
    assert.deepEqual([recovered.accepted, recovered.delivery], [true, 'new-turn']);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start']);
    assert.ok(answerWrites(f).every(input => input.text.includes(seed.requestId)), 'the same request id carries the recovered write');
    assert.deepEqual(queueWrites(f), [], 'Q waits behind the recovered answer turn');

    f.codex.endTurn(seed.threadId, 'answer applied');
    await f.poll(seed); await f.poll(seed);
    assert.deepEqual(queueWrites(f).map(input => input.method), ['turn/start'], 'Q starts only after the answer turn ends');
    const before = f.codex.inputs().length;
    await f.poll(seed);
    assert.equal(f.codex.inputs().length, before, 'the recovered answer is never written twice');
  } finally { f.service.close(); }
});

test('a legacy unknown answer survives a temporary registration loss and recovers as a new turn', async () => {
  const seed = await answerRaceSeed();
  const registration = { ready: false };
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop, registration });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.kind === 'answer' && entry.requestId === seed.requestId);
    dispatch.state = 'unknown'; dispatch.delivery = 'unknown'; f.store.save(record);
    const state = f.store.backendState(seed.agentId), request = state.requests[seed.requestId];
    delete request.intent; delete request.route; delete request.reschedule; delete request.afterTurnId;
    request.attempted = false; request.status = 'retryable';
    f.store.saveBackendState(seed.agentId, state);

    await f.poll(seed);
    const waiting = answerDispatch(f, seed.requestId);
    assert.equal(waiting.state, 'retrying', 'a read-only registration refusal does not seal the answer as failed');
    assert.equal(waiting.error.code, 'codex-report-not-ready');
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.equal(row.delivery, 'answer-pending');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer'], 'the original steer is kept');

    registration.ready = true;
    await delay(Math.max(0, waiting.nextAttemptAt - Date.now()) + 50);
    await f.poll(seed);
    const recovered = answerDispatch(f, seed.requestId);
    assert.deepEqual([recovered.accepted, recovered.delivery], [true, 'new-turn']);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start'],
      'after A ended, the recovered answer keeps its original steer and opens one new turn');
    assert.ok(answerWrites(f).every(input => input.text.includes(seed.requestId)));
  } finally { f.service.close(); }
});

test('a legacy failed answer is repaired under the same request id before the queued input', async () => {
  const seed = await answerRaceSeed({ queuedInput: true });
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = answerDispatch(f, seed.requestId);
    Object.assign(dispatch, { state: 'failed', delivery: 'local-pending',
      error: { code: 'codex-report-not-ready', message: 'The explicit Codex parent-report tools have not been connected.' } });
    f.store.save(record);

    await pollTimes(f, seed, 4);
    const recovered = answerDispatch(f, seed.requestId);
    assert.deepEqual([recovered.accepted, recovered.delivery], [true, 'new-turn']);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start']);
    assert.deepEqual(queueWrites(f), [], 'the old failed answer is repaired before Q');

    f.codex.endTurn(seed.threadId, 'answer applied');
    await f.service.poll(seed.agentId); await f.service.poll(seed.agentId);
    assert.deepEqual(queueWrites(f).map(input => input.method), ['turn/start']);
    const before = f.codex.inputs().length;
    await f.service.poll(seed.agentId);
    assert.equal(f.codex.inputs().length, before, 'the repaired answer is not replayed');
  } finally { f.service.close(); }
});

test('a legacy failed answer without native proof is never resent', async () => {
  for (const status of ['absent', 'unknown', 'sending', 'rejected']) {
    const seed = await answerRaceSeed();
    const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
    try {
      const record = f.record('lead');
      const dispatch = record.task.dispatches.find(entry => entry.requestId === seed.requestId);
      dispatch.state = 'failed';
      const backendState = f.store.backendState(seed.agentId);
      if (status === 'absent') delete backendState.requests[seed.requestId];
      else {
        backendState.requests[seed.requestId].status = status;
        if (status === 'rejected') backendState.requests[seed.requestId].route = 'blocked';
      }
      f.store.saveBackendState(seed.agentId, backendState);
      f.store.save(record);

      await pollTimes(f, seed, 3);
      assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer'],
        `a ${status} native receipt never authorises a fresh answer`);
      assert.equal(answerDispatch(f, seed.requestId).state, 'failed', 'an unproven or terminal receipt keeps its failed evidence');
    } finally { f.service.close(); }
  }
});

test('a legacy failed answer with a newer unproven start is never replayed', async () => {
  const seed = await answerRaceSeed({ queuedInput: true });
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.kind === 'answer' && entry.requestId === seed.requestId);
    Object.assign(dispatch, { state: 'failed', delivery: 'local-pending',
      error: { code: 'codex-report-not-ready', message: 'The explicit Codex parent-report tools have not been connected.' } });
    f.store.save(record);
    const state = f.store.backendState(seed.agentId), request = state.requests[seed.requestId];
    // The old no-write receipt belonged to the rejected steer. This later start
    // has no not-sent outcome, so it proves nothing about the answer write.
    request.intent = { method: 'turn/start', threadId: seed.threadId, at: new Date().toISOString() };
    request.attempted = true; request.status = 'retryable';
    f.store.saveBackendState(seed.agentId, state);

    await pollTimes(f, seed, 3);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer'],
      'a failed answer without current not-sent proof is never written again');
    assert.equal(answerDispatch(f, seed.requestId).accepted, false, 'the unproven failed answer is never accepted');
  } finally { f.service.close(); }
});

test('an expired waiting answer shows dispatch-expired while the external turn is still active', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop, raceExternalTurn: true });
  try {
    await pollTimes(f, seed, 2);
    assert.equal(answerDispatch(f, seed.requestId).state, 'queued');
    const writesBefore = f.codex.inputs().length;
    ageAnswer(f, seed);
    await f.poll(seed);

    const dispatch = answerDispatch(f, seed.requestId);
    assert.equal(dispatch.expired, 'dispatch-expired');
    assert.deepEqual([dispatch.state, dispatch.delivery], ['unknown', 'blocked']);
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.deepEqual([row.delivery, row.status, row.reason, row.queued], ['blocked', 'blocked', 'dispatch-expired', false]);
    assert.equal(f.codex.inputs().length, writesBefore, 'expiry writes nothing while the external turn is active');

    const expiredCount = f.record('lead').expired?.count;
    f.codex.endTurn(seed.threadId, 'external complete');
    await pollTimes(f, seed, 3);
    assert.equal(f.record('lead').expired?.count, expiredCount, 'the same answer is not expired twice');
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start'],
      'the expired answer is never started after the external turn ends');
  } finally { f.service.close(); }
});

test('a cancelled answer with an unknown native outcome inspects as unknown, not queued or blocked', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop, loseStartReply: true });
  try {
    await pollTimes(f, seed, 2);
    assert.equal(answerDispatch(f, seed.requestId).state, 'unknown');
    await f.service.cancel({ name: 'lead' }, extra(BOSS));
    await pollTimes(f, seed, 4);

    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.deepEqual([row.status, row.delivery, row.accepted, row.queued], ['unknown', 'unknown', false, false]);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/start'],
      'cancellation never writes the unknown answer again');
  } finally { f.service.close(); }
});
test('a read-only retryable answer still joins its own live turn after restart', async () => {
  const seed = await answerRaceSeed();
  // Put the original turn A back in progress: a read that failed before any write
  // must not turn the answer into a start-only recovery.
  const thread = seed.desktop.threads.find(([id]) => id === seed.threadId)[1];
  thread.turns.find(turn => turn.id === 'turn-1793932681').status = 'inProgress';
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
  try {
    const record = f.record('lead');
    const dispatch = record.task.dispatches.find(entry => entry.requestId === seed.requestId);
    const backendState = f.store.backendState(seed.agentId);
    const request = backendState.requests[seed.requestId];
    delete request.intent; delete request.reschedule; delete request.route; delete request.afterTurnId;
    request.attempted = false; request.status = 'retryable';
    f.store.saveBackendState(seed.agentId, backendState);
    delete dispatch.delivery; dispatch.state = 'retrying'; delete dispatch.nextAttemptAt;
    f.store.save(record);

    await pollTimes(f, seed, 2);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer', 'turn/steer'],
      'the pure read retry steers the live turn instead of opening a new one');
    const steered = answerWrites(f).at(-1);
    assert.equal(steered.turnId, 'turn-1793932681');
    const recovered = answerDispatch(f, seed.requestId);
    assert.deepEqual([recovered.accepted, recovered.delivery], [true, 'current-turn']);
    assert.equal(f.codex.runningTurn(seed.threadId), 'turn-1793932681');
  } finally { f.service.close(); }
});
test('legacy failed answer migration skips cancelled, final and expired rounds', async () => {
  const fail = async (entry) => {
    const record = entry.f.record('lead');
    const dispatch = record.task.dispatches.find(item => item.requestId === entry.seed.requestId);
    Object.assign(dispatch, { state: 'failed', delivery: 'local-pending',
      error: { code: 'codex-report-not-ready', message: 'The explicit Codex parent-report tools have not been connected.' } });
    entry.f.store.save(record);
    return dispatch;
  };

  // Cancelled: a cancelled round never reopens for an old failed answer.
  {
    const seed = await answerRaceSeed();
    const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
    try {
      await fail({ f, seed });
      await f.service.cancel({ name: 'lead' }, extra(BOSS));
      await pollTimes(f, seed, 3);
      assert.equal(answerDispatch(f, seed.requestId).state, 'failed');
      assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer']);
    } finally { f.service.close(); }
  }

  // Final: a sealed round keeps its answer row exactly as evidence.
  {
    const seed = await answerRaceSeed();
    const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
    try {
      await fail({ f, seed });
      f.store.enqueueSubmission({ id: 'legacy-final-hotfix', ownerId: ownerIdFor(BOSS), agentId: seed.agentId,
        taskId: f.record('lead').task.taskId, kind: 'report', message: 'done', final: true });
      await pollTimes(f, seed, 3);
      assert.equal(answerDispatch(f, seed.requestId).state, 'failed');
      assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer']);
    } finally { f.service.close(); }
  }

  // Expired: expiry settles it as a blocked no-write before migration could queue it.
  {
    const seed = await answerRaceSeed();
    const f = await fixture({ directory: seed.directory, snapshot: seed.desktop });
    try {
      await fail({ f, seed });
      ageAnswer(f, seed);
      await f.poll(seed);
      const dispatch = answerDispatch(f, seed.requestId);
      assert.equal(dispatch.expired, 'dispatch-expired');
      assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer']);
    } finally { f.service.close(); }
  }
});

// Cross-package regression from the hotfix review: a verified cancellation must
// expose the planned-but-unwritten native intent of an answer that lost the
// write-time race, so the cleanup package can seal it as blocked after restart.
test('a cancelled answer that loses the write-time external turn race stays blocked across restart', async () => {
  const seed = await answerRaceSeed({ queuedInput: true });
  let external;
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop,
    raceBeforeAnswer: async desktop => {
      external = (await desktop.request('turn/start', { threadId: seed.threadId,
        input: [{ type: 'text', text: 'another client' }] })).turn.id;
    } });
  let snapshot, writesBeforeCancel;
  try {
    await pollTimes(f, seed, 2);
    const request = f.store.backendState(seed.agentId).requests[seed.requestId];
    assert.equal(f.codex.runningTurn(seed.threadId), external);
    assert.equal(request.status, 'waiting');
    assert.equal(request.attempted, false);
    assert.equal(request.afterTurnId, external);
    assert.equal(request.reschedule?.reason, 'turn-started-before-write');
    assert.equal(request.reschedule?.notSent, true);
    assert.equal(request.reschedule?.afterTurnId, external);
    assert.equal(request.intent?.method, 'turn/start');
    assert.equal(request.intent?.outcome, 'not-sent');
    assert.equal(request.intent?.priorTurnId, external);
    assert.deepEqual(answerWrites(f).map(input => input.method), ['turn/steer'],
      'the race wrote no answer turn');

    writesBeforeCancel = f.codex.inputs().length;
    await f.service.cancel({ name: 'lead' }, extra(BOSS));
    await pollTimes(f, seed, 4);
    assert.equal(f.codex.inputs().length, writesBeforeCancel, 'cancellation writes nothing');
    const task = f.record('lead').task, dispatch = answerDispatch(f, seed.requestId);
    assert.equal(task.state, 'cancelled');
    assert.equal(task.cancelVerified, true);
    assert.equal(task.cancelTreeSettled, true);
    assert.equal(dispatch.state, 'cancelled');
    assert.equal(dispatch.accepted, false);
    assert.equal(dispatch.deliveryIntent?.method, 'start');
    snapshot = f.codex.snapshot();
  } finally { f.service.close(); }

  // Reopen from the persisted roster only: the request must not be replayed and
  // its planned turn must still have no native write receipt.
  const reopened = await fixture({ directory: seed.directory, snapshot });
  try {
    const task = reopened.record('lead').task;
    const dispatch = answerDispatch(reopened, seed.requestId);
    const answer = task.answers.find(entry => entry.answerId === seed.requestId);
    const backend = reopened.store.backendState(seed.agentId);
    const request = backend.requests[seed.requestId];
    assert.equal(reopened.codex.inputs().length, writesBeforeCancel, 'restart writes nothing');
    assert.deepEqual(answerWrites(reopened).map(input => input.method), ['turn/steer']);
    assert.deepEqual([request.status, request.route, request.attempted], ['waiting', 'after-current', false]);
    assert.equal(request.afterTurnId, external);
    assert.equal(request.reschedule?.reason, 'turn-started-before-write');
    assert.equal(request.reschedule?.notSent, true);
    assert.equal(request.reschedule?.afterTurnId, external);
    assert.equal(request.intent?.method, 'turn/start');
    assert.equal(request.intent?.outcome, 'not-sent');
    assert.equal(request.intent?.threadId, seed.threadId);
    assert.equal(request.intent?.priorTurnId, external);
    assert.equal(request.native, undefined, 'the planned turn has no native write');

    const row = (await reopened.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.deepEqual([row.delivery, row.status, row.queued], ['blocked', 'blocked', false]);
    assert.equal(cancelledUnsentAnswer(task, dispatch, backend), true);
    assert.equal(answerOutcome(task, answer, backend), 'blocked');

    // The ordinary queue input shares the wait but is not an answer: it can never
    // produce answer proof, and it was never written.
    const queueRow = reopened.store.supplements(seed.agentId).find(entry => entry.mode === 'queue');
    assert.ok(queueRow, 'the ordinary queue input is still recorded');
    assert.equal(task.answers.some(entry => entry.answerId === queueRow.requestId), false);
    assert.equal(cancelledUnsentAnswer(task, queueRow, backend), false);
    assert.deepEqual(queueWrites(reopened), [], 'the ordinary queue input was never written');
  } finally { reopened.service.close(); }
});

test('a later unknown answer write stays unknown even when an older receipt was not sent', async () => {
  const seed = await answerRaceSeed();
  const f = await fixture({ directory: seed.directory, snapshot: seed.desktop, loseStartReply: true });
  try {
    await pollTimes(f, seed, 2);
    const dispatch = answerDispatch(f, seed.requestId);
    const request = f.store.backendState(seed.agentId).requests[seed.requestId];
    assert.equal(dispatch.state, 'unknown');
    assert.deepEqual([request.status, request.attempted], ['unknown', true]);
    assert.equal(request.reschedule?.notSent, true, 'the older no-write receipt still exists');
    assert.equal(request.intent?.method, 'turn/start');
    assert.equal(request.intent?.outcome, undefined, 'the later write never proved itself not sent');

    await f.service.cancel({ name: 'lead' }, extra(BOSS));
    await pollTimes(f, seed, 4);
    const task = f.record('lead').task;
    const answer = task.answers.find(entry => entry.answerId === seed.requestId);
    const cancelled = answerDispatch(f, seed.requestId);
    const backend = f.store.backendState(seed.agentId);
    const row = (await f.service.inspect({ name: 'lead' }, extra(BOSS))).inputs
      .find(entry => entry.requestId === seed.requestId);
    assert.equal(row.delivery, 'unknown');
    assert.equal(cancelledUnsentAnswer(task, cancelled, backend), false);
    assert.equal(answerOutcome(task, answer, backend), 'unknown',
      'an older notSent receipt cannot seal a later unknown write');
  } finally { f.service.close(); }
});

test('a delivered report keeps a temporary registration failure out of the public error', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
    await f.ask(lead, 'Which contract applies?');
    await f.poll(lead);

    // The report tools are temporarily unreadable, and no report has been delivered
    // for this task yet: the dispatch preflight refusal is still accurate here.
    f.registration.ready = false;
    assert.equal((await f.answer(lead, 'Contract B.')).answered, true);
    await f.poll(lead);
    const noisy = (await f.service.list(extra(BOSS))).items.find(item => item.name === 'lead');
    assert.equal(noisy.error?.code, 'codex-report-not-ready');
    assert.equal(noisy.reports.pending, 0);

    // The helper's cross-session report still arrives. Once it is delivered, the same
    // preflight code is noise and must not remain the agent's public error.
    assert.equal((await f.report(lead, 'Half fixed.')).accepted, true);
    await f.poll(lead); await f.poll(lead);
    const quiet = (await f.service.list(extra(BOSS))).items.find(item => item.name === 'lead');
    assert.equal(quiet.reports.latest.delivery, 'delivered', 'the report was actually delivered');
    assert.equal(quiet.error, undefined, 'a delivered report makes the registration preflight noise disappear');
  } finally { f.service.close(); }
});
