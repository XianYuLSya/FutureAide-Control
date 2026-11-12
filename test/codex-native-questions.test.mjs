// Native questions handed to the parent.
//
// A managed Codex helper can stop on its own `request_user_input` card. Those cards are
// native turn state, not a chat message: they are read only behind the thread's own
// `waitingOnUserInput` flag, relayed only for this name's own accepted turn, answered
// against the card the desktop reports, and never claimed when the write is unproven.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createCodexBackend, nativeQuestionId, nativeAnswers } from '../src/codex-backend.mjs';
import { livePage, liveThread, liveTurn } from './live-thread-fixture.mjs';
import { CODEX_MODELS } from './assembly/renderer.mjs';

const WORKSPACE = 'D:/work/project';
const CARD_ID = nativeQuestionId({ threadId: 'root-1', turnId: 'turn-1', itemId: 'item-1', requestId: '7' });

const card = (overrides = {}) => ({ requestId: '7', threadId: 'root-1', turnId: 'turn-1', itemId: 'item-1',
  isBlocking: true, kind: 'question', createdAt: '2026-11-13T00:00:00Z',
  questions: [{ id: 'q1', header: '选一个', question: '用哪个方案？', isOther: false, isSecret: false,
    options: [{ label: '选项A', description: '第一个' }, { label: '选项B', description: '' }] }],
  ...overrides });

/** The Codex Desktop RPC, reduced to one managed thread and its native question cards. */
function desktop({ flags = [], cards = [], interruptClears = true, turnState = null, turnAfterInterrupt } = {}) {
  const calls = [];
  let pending = cards.map(entry => structuredClone(entry));
  let script = [], reads = 0, readAnswer = 'observed', turn = turnState;
  const api = {
    calls,
    count: method => calls.filter(call => call.method === method).length,
    paramsOf: method => calls.filter(call => call.method === method).map(call => call.params),
    replies: () => calls.filter(call => call.method === 'futureaide/userInput/reply').map(call => call.params),
    pending: () => pending.map(entry => structuredClone(entry)),
    setCards: list => { pending = list.map(entry => structuredClone(entry)); },
    /** The next reply outcomes, in order; a function receives the request params. */
    script: (...outcomes) => { script = outcomes; return api; },
    unverifiedReads: () => { readAnswer = 'unverified'; return api; },
    throwingReads: () => { readAnswer = 'throw'; return api; },
    setKind: (requestId, kind) => { for (const entry of pending) if (String(entry.requestId) === String(requestId)) entry.kind = kind; return api; },
    setTurnState: status => { turn = status; return api; },
    readCount: () => reads,
    flags: value => { flags = value; return api; },
  };
  async function request(method, params = {}) {
    calls.push({ method, params: structuredClone(params) });
    switch (method) {
      case 'config/read': return { model: 'gpt-6-astra', provider: 'openai', reasoningEffort: 'high', profile: null };
      case 'model/list': return livePage(structuredClone(CODEX_MODELS));
      case 'thread/list': return livePage();
      case 'thread/read':
        return { thread: liveThread({ id: 'root-1', cwd: WORKSPACE, status: flags.length
          ? { type: 'active', activeFlags: [...flags] } : { type: 'idle' } }) };
      case 'thread/turns/list': return livePage(turn === null ? [] : [liveTurn({ id: 'turn-1', status: turn, startedAt: 1, items: [] })]);
      case 'thread/name/set': return {};
      case 'thread/resume':
        return { thread: liveThread({ id: 'root-1', cwd: WORKSPACE, status: { type: 'idle' } }) };
      case 'futureaide/userInput/read': {
        reads += 1;
        if (readAnswer === 'throw') throw Object.assign(new Error('Native Desktop request timed out'), { code: 'codex-native-rpc-response-timeout' });
        return readAnswer === 'observed' ? { status: 'observed', requests: pending } : { status: 'unverified', reason: 'guard' };
      }
      case 'futureaide/userInput/reply': {
        const next = script.length ? script.shift() : { status: 'answered' };
        const outcome = typeof next === 'function' ? next(params) : next;
        if (outcome.status === 'answered') {
          pending = pending.filter(entry => !(String(entry.requestId) === String(params.card?.requestId)
            && entry.threadId === params.card?.threadId && entry.turnId === params.card?.turnId));
        }
        return outcome;
      }
      case 'turn/interrupt':
        if (interruptClears) pending = [];
        if (turnAfterInterrupt) turn = turnAfterInterrupt;
        return {};
      default: throw new Error(`unexpected native method ${method}`);
    }
  }
  return { ...api, request };
}

/** A name whose task already had turn-1 accepted natively, plus the desktop stand-in. */
async function fixture(options = {}) {
  const { explicit = null, extra = {}, presented } = options;
  const native = desktop(options);
  const record = { name: 'helper', agentId: 'a', sessionId: 'logical', workspace: WORKSPACE,
    task: { taskId: 'task-1' }, ...extra };
  let saved = {
    requests: { r1: { requestId: 'r1', taskId: 'task-1', status: 'accepted', turnId: 'turn-1',
      marker: 'm', messageHash: 'x', afterSeq: 0, attempted: true } },
    projections: {},
    binding: { sessionId: 'root-1', owned: true },
    tree: { nodes: [{ sessionId: 'root-1', parentSessionId: null, status: 'idle', changes: [] }] },
  };
  const deps = {
    load: () => record,
    readNativeState: () => structuredClone(saved),
    writeNativeState: value => { saved = structuredClone(value); return true; },
    ensureCodexReports: async () => ({ ready: true }),
    readCodexReportStatus: async () => ({ ready: true }),
    readCodexReportState: async () => ({ questions: explicit ? [explicit] : [], reports: [] }),
    ...(presented === undefined ? {} : { presentedNativeQuestion: () => presented }),
    hostOptions: { nativeRequest: native.request },
    withHostLock: async action => action(),
  };
  const backend = await createCodexBackend(record, deps);
  return { backend, native, deps, record, state: () => saved,
    /** The same name seen by a fresh adapter: a monitor restart reads the same record. */
    restart: async () => createCodexBackend(record, deps) };
}

test('several pending cards are shown and answered one at a time', async () => {
  const second = card({ requestId: '8', itemId: 'item-2', createdAt: '2026-11-13T00:00:05Z',
    questions: [{ id: 'q2', header: '再选', question: '还要哪个？', isOther: true, isSecret: false, options: null }] });
  const secondId = nativeQuestionId(second);
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card(), second] });
  const first = await f.backend.observe();
  assert.equal(first.questions.length, 1, 'exactly one card is asked at a time');
  const shown = first.questions[0].id;
  assert.ok([CARD_ID, secondId].includes(shown));

  // Answering the shown card settles it; the next observe lights up the other one.
  f.native.script({ status: 'answered' }, { status: 'answered' });
  const answered = await f.backend.answer({ answerId: 'a1', message: '选项A' });
  assert.deepEqual(answered, { consumedQuestionIds: [shown], nativeAnswered: true });
  const next = await f.backend.observe();
  assert.deepEqual(next.questions.map(entry => entry.id),
    [shown === CARD_ID ? secondId : CARD_ID], 'the remaining card is asked after the first settled');
});

test('a card whose kind changed before the answer is never written to', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  f.native.setKind('7', 'mcp-approval'); // became an approval between relay and answer
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-answer-unconfirmed');
  assert.equal(f.native.count('futureaide/userInput/reply'), 0, 'an approval is never answered');
});

test('an unproven withdrawal is never permission to interrupt the turn', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, { status: 'unknown' });
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-answer-unconfirmed');
  assert.equal(f.native.count('turn/interrupt'), 0, 'unknown is not a reason to interrupt');
  assert.ok(f.state().nativeCards[CARD_ID], 'the card stays for the next attempt');
});

test('a proven stop needs the card gone and the turn no longer running', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()], turnState: 'inProgress' });
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, { status: 'unsupported' });
  // The interrupt clears the card, but the turn row still says inProgress.
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-answer-unconfirmed');
  assert.ok(f.state().nativeCards[CARD_ID], 'an unproven stop claims nothing');

  // With the turn read back as ended, the same flow completes as a fallback.
  f.native.setTurnState('interrupted');
  f.native.setCards([card()]);
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, { status: 'unsupported' });
  const done = await f.backend.answer({ answerId: 'b', message: '选项A' });
  assert.equal(done.nativeFallback, true);
  assert.equal(done.interrupted, true);
});

test('a failed or unverified read keeps the card already observed', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  assert.equal((await f.backend.observe()).questions.length, 1);
  f.native.throwingReads();
  assert.equal((await f.backend.observe()).questions.length, 1, 'a failed read is not evidence the card is gone');
  f.native.unverifiedReads();
  assert.equal((await f.backend.observe()).questions.length, 1);
  assert.ok(f.state().nativeCards[CARD_ID]);
});

test('a refused answer permission writes nothing', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A', canAnswer: () => false }),
    error => error.code === 'native-answer-unconfirmed');
  assert.equal(f.native.count('futureaide/userInput/reply'), 0, 'no write without the round\'s permission');
  assert.ok(f.state().nativeCards[CARD_ID], 'the card is kept');

  // The same answer goes through when the round still allows it.
  const done = await f.backend.answer({ answerId: 'b', message: '选项A', canAnswer: () => true });
  assert.equal(done.nativeAnswered, true);
});

test('the permission is asked again before the interrupt', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, { status: 'unsupported' });
  // Permitted for the withdrawal, then the round is gone by the time the turn is reached.
  let calls = 0;
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A', canAnswer: () => ++calls === 1 }),
    error => error.code === 'native-answer-unconfirmed');
  assert.equal(f.native.count('turn/interrupt'), 0, 'an expired round never interrupts a turn');
  assert.ok(calls >= 2, 'the permission was asked again after the reads');
});

test('a card that lost its type evidence is never interrupted', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, () => {
    f.native.setKind('7', 'mcp-approval');
    return { status: 'unsupported' };
  });
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-answer-unconfirmed');
  assert.equal(f.native.count('turn/interrupt'), 0, 'no turn is touched on a card without type evidence');
});

test('a turn row that is gone is not proof of a stop', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] }); // no turn row at all
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, { status: 'unsupported' });
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-answer-unconfirmed');
  assert.ok(f.state().nativeCards[CARD_ID], 'an absent turn row claims nothing');
});

test('a presented card that is gone is never replaced by the next one', async () => {
  const second = card({ requestId: '8', itemId: 'item-2', createdAt: '2026-11-13T00:00:05Z' });
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [second], presented: CARD_ID });
  const view = await f.backend.observe();
  assert.deepEqual(view.questions, [], 'the card the parent is answering is not swapped for another');
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-question-not-pending');
  assert.equal(f.native.count('futureaide/userInput/reply'), 0, 'nothing is written to a substitute card');
});

test('a read that cannot be verified keeps the card already proven', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  assert.equal((await f.backend.observe()).questions.length, 1);
  // The flag still says the thread waits on a human; only the read itself fails.
  f.native.throwingReads();
  assert.deepEqual((await f.backend.observe()).questions.map(entry => entry.id), [CARD_ID]);
  f.native.unverifiedReads();
  assert.deepEqual((await f.backend.observe()).questions.map(entry => entry.id), [CARD_ID]);
});

test('an explicit question keeps the native card off the parent until it is consumed', async () => {
  const explicit = { id: 'ask-1', taskId: 'task-1', state: 'pending', message: '选哪个？' };
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()], explicit });
  const view = await f.backend.observe();
  assert.deepEqual(view.questions.map(entry => entry.id), ['ask-1'], 'only the explicit question is shown');
  const answered = await f.backend.answer({ answerId: 'a1', message: '左边' });
  assert.deepEqual(answered.consumedQuestionIds, ['ask-1'], 'the explicit question is answered first');
  assert.equal(f.native.count('futureaide/userInput/reply'), 0, 'the native card was not touched');
  const next = await f.backend.observe();
  assert.ok(next.questions.some(entry => entry.id === CARD_ID) || f.state().nativeCards === undefined,
    'the native card only comes up after the explicit one is consumed');
});

test('a card that was already presented to the parent is settled first', async () => {
  const explicit = { id: 'ask-1', taskId: 'task-1', state: 'pending', message: '选哪个？' };
  // The real contract function decides this from the record, so the record is shaped as
  // the shared layer leaves it once the card had a notice.
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()], explicit,
    extra: { target: 'codex-desktop',
      observation: { taskId: 'task-1', questions: [{ id: CARD_ID, state: 'pending' }] },
      task: { taskId: 'task-1', questionNotices: { [CARD_ID]: { state: 'pending' } } } } });
  const view = await f.backend.observe();
  assert.deepEqual(view.questions.map(entry => entry.id), [CARD_ID], 'the card that is out is the one shown');
  f.native.script({ status: 'answered' });
  const answered = await f.backend.answer({ answerId: 'a1', message: '选项A' });
  assert.deepEqual(answered, { consumedQuestionIds: [CARD_ID], nativeAnswered: true });
});

test('a thread that is not waiting on a human costs no question request', async () => {
  const f = await fixture({ cards: [card()] });
  const view = await f.backend.observe();
  assert.deepEqual(view.questions, []);
  assert.equal(f.native.count('futureaide/userInput/read'), 0, 'no waiting flag means no extra RPC');
});

test('an owned card of this turn is relayed once, with a stable id and a readable body', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  const view = await f.backend.observe();
  assert.equal(view.questions.length, 1);
  const [question] = view.questions;
  assert.equal(question.id, CARD_ID);
  assert.equal(question.taskId, 'task-1');
  assert.equal(question.state, 'pending');
  assert.match(question.message, /选一个：用哪个方案？/);
  assert.match(question.message, /选项A（第一个）/);
  assert.deepEqual(f.state().nativeCards[CARD_ID].turnId, 'turn-1');

  // A restart reads the same card and derives the same id, so the parent's answer still
  // refers to the same question.
  const restarted = await f.restart();
  const again = await restarted.observe();
  assert.deepEqual(again.questions.map(entry => entry.id), [CARD_ID]);
});

test('cards that are not ours, not this turn, or not a plain question are never relayed', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [
    card(),
    card({ requestId: '8', threadId: 'someone-else' }),
    card({ requestId: '9', turnId: 'turn-old' }),
    card({ requestId: '10', kind: 'mcp-approval' }),
    card({ requestId: '11', kind: 'secret' }),
    card({ requestId: '12', kind: 'unknown' }),
  ] });
  const view = await f.backend.observe();
  assert.deepEqual(view.questions.map(entry => entry.id), [CARD_ID], 'only the owned, accepted, plain question');
  assert.equal(f.native.count('futureaide/userInput/reply'), 0, 'nothing was written');
});

test('an answer by option label is written once and consumes the question', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  const result = await f.backend.answer({ answerId: 'answer-1', message: '选项A' });
  assert.deepEqual(result, { consumedQuestionIds: [CARD_ID], nativeAnswered: true });
  const [reply] = f.native.replies();
  assert.deepEqual(reply.answers, { q1: { answers: ['选项A'] } });
  assert.equal(reply.card.requestId, '7');
  assert.equal(reply.card.threadId, 'root-1');
  assert.equal(reply.card.turnId, 'turn-1');
  assert.equal(reply.card.itemId, 'item-1');
  assert.equal(f.state().nativeCards, undefined, 'the card is settled on this name');

  // The same answer id is answered from the record, with no second write.
  const repeat = await f.backend.answer({ answerId: 'answer-1', message: '选项A' });
  assert.deepEqual(repeat, result);
  assert.equal(f.native.count('futureaide/userInput/reply'), 1);
});

test('an answer that is not an offered option is refused before any write', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '随便写' }),
    error => error.code === 'native-answer-invalid');
  assert.equal(f.native.count('futureaide/userInput/reply'), 0);
  assert.ok(f.state().nativeCards[CARD_ID], 'the question is still pending');
});

test('a card that is already gone is stale, never a success', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  f.native.setCards([]); // answered elsewhere between the relay and the reply
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-question-not-pending');
  assert.equal(f.native.count('futureaide/userInput/reply'), 0, 'no blind write to a stale card');
  assert.equal(f.state().nativeCards, undefined);
});

test('an unsupported direct answer withdraws the card and still sends the ordinary message', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, { status: 'answered' }); // direct, then empty withdrawal
  const result = await f.backend.answer({ answerId: 'a', message: '选项A' });
  assert.deepEqual(result.consumedQuestionIds, [CARD_ID]);
  assert.equal(result.nativeFallback, true);
  assert.equal(result.nativeAnswered, undefined, 'the native channel never carried the answer');
  assert.equal(result.continuation, 'Parent answer:\n选项A\nContinue the same task.');
  const [, withdrawal] = f.native.replies();
  assert.deepEqual(withdrawal.answers, {}, 'the withdrawal is an empty answer map');
});

test('an unwithdrawable card interrupts only its own turn, and only a proven stop counts', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()],
    turnState: 'inProgress', turnAfterInterrupt: 'interrupted' });
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, { status: 'unsupported' });
  const result = await f.backend.answer({ answerId: 'a', message: '选项A' });
  assert.equal(result.nativeFallback, true);
  assert.equal(result.interrupted, true);
  assert.equal(result.continuation, 'Parent answer:\n选项A\nContinue the same task.');
  const [interrupt] = f.native.paramsOf('turn/interrupt');
  assert.deepEqual(interrupt, { threadId: 'root-1', turnId: 'turn-1' }, 'only the card\'s own thread and turn');
});

test('an interrupt that leaves the card behind claims nothing', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()], interruptClears: false });
  await f.backend.observe();
  f.native.script({ status: 'unsupported' }, { status: 'unsupported' });
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-answer-unconfirmed');
  assert.ok(f.state().nativeCards[CARD_ID], 'the card is kept for the next attempt');
});

test('an unverifiable read claims nothing', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  f.native.unverifiedReads();
  await assert.rejects(f.backend.answer({ answerId: 'a', message: '选项A' }),
    error => error.code === 'native-answer-unconfirmed');
  assert.equal(f.native.count('futureaide/userInput/reply'), 0);
});

test('a pending native question keeps the thread from being released', async () => {
  const f = await fixture({ flags: ['waitingOnUserInput'], cards: [card()] });
  await f.backend.observe();
  const outcome = await f.backend.releaseIdleThreads({ taskId: 'task-1' });
  assert.equal(outcome.state, 'deferred');
  assert.equal(outcome.reason, 'release-native-question-pending');
});

test('the card id is derived from thread, turn, item and request, not the numeric request alone', () => {
  const base = { threadId: 't', turnId: 'turn', itemId: 'item', requestId: '1' };
  assert.notEqual(nativeQuestionId(base), nativeQuestionId({ ...base, threadId: 't2' }));
  assert.notEqual(nativeQuestionId(base), nativeQuestionId({ ...base, turnId: 'turn2' }));
  assert.notEqual(nativeQuestionId(base), nativeQuestionId({ ...base, itemId: 'item2' }));
  assert.notEqual(nativeQuestionId({ ...base, requestId: '1' }), nativeQuestionId({ ...base, requestId: '2' }));
  assert.equal(nativeQuestionId(base), nativeQuestionId({ ...base }),
    'the same card keeps one id across reconnects');
});

test('several questions in one card take a numbered JSON answer', () => {
  const multi = { questions: [
    { id: 'q1', header: '一', question: '选', isOther: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] },
    { id: 'q2', header: '二', question: '写', isOther: true, options: null }] };
  assert.deepEqual(nativeAnswers(multi, '{"1":["A"],"2":["自由"]}'),
    { q1: { answers: ['A'] }, q2: { answers: ['自由'] } });
  assert.throws(() => nativeAnswers(multi, '{"1":["A"]}'), error => error.code === 'native-answer-invalid');
  assert.throws(() => nativeAnswers(multi, '{"1":["C"],"2":["x"]}'), error => error.code === 'native-answer-invalid');
  assert.deepEqual(nativeAnswers(multi, '1. A\n2. 自由'),
    { q1: { answers: ['A'] }, q2: { answers: ['自由'] } });
});
