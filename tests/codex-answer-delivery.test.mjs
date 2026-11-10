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
import { fileURLToPath } from 'node:url';
import { createScopedAgents } from '../src/scoped-agents.mjs';
import { RosterStore } from '../src/roster-store.mjs';
import { createCodexBackend } from '../src/codex-backend.mjs';
import { ownerIdFor } from '../src/calling-context.mjs';
import { liveThread, liveTurn, livePage } from '../test/live-thread-fixture.mjs';
import { CODEX_MODELS } from '../test/assembly/renderer.mjs';

const workspace = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOSS = '11111111-1111-4111-8111-111111111111';
const extra = threadId => ({ _meta: { threadId } });

/** The Codex Desktop RPC, reduced to threads and turns the adapter reads and writes. */
function codexDesktop() {
  const threads = new Map(), calls = [];
  let created = 0, clock = 1793932679;
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
          status: { type: running(thread) ? 'active' : 'idle' } }) };
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
        const thread = find(params.threadId);
        if (running(thread)) throw Object.assign(new Error('a turn is already running on this thread'), { code: 'codex-native-rpc-rejected' });
        // A turn is the only place a selection can change; the thread reports it afterwards.
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
      default: throw new Error(`unexpected native method ${method}`);
    }
  }
  return {
    request,
    threadIds: () => [...threads.keys()],
    runningTurn: threadId => running(find(threadId))?.id,
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

async function fixture() {
  const base = path.join(workspace, '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const stateDirectory = await mkdtemp(path.join(base, 'answer-'));
  const store = new RosterStore(':memory:');
  const codex = codexDesktop();
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
    backendAdapters: { 'codex-desktop': (record, deps) => createCodexBackend(record, { ...deps, hostOptions: { nativeRequest: codex.request } }) },
    codexProbeRegistration: async () => ({ ready: true, registered: true, tools: ['ask_parent', 'report_parent'], sessionVerified: false }),
    startSharedMonitor: () => true,
    removeTree: async () => {},
  });
  const record = name => store.named(ownerIdFor(BOSS), name);
  return {
    service, store, codex, notices, record,
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

test('answering a task that was already sealed says the answer was not delivered', async () => {
  const f = await fixture();
  try {
    const lead = await f.start('lead', 'Fix the ten places.');
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
    await f.poll(lead); await f.poll(lead);

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
