import { randomUUID, createHash } from 'node:crypto';
import { createCodexHost, emptyProjection, markerLine, CODEX_FILE_COVERAGE } from './codex-host.mjs';
import { isCodexReadRetryable, isCodexRpcUnavailable, isCodexThreadMissing } from './codex-ipc.mjs';
import { CODEX_ASK_PARENT_INSTRUCTION, presentedNativeQuestion } from './report-contract.mjs';

const METHODS = ['probe', 'create', 'beginTask', 'observe', 'history', 'answer', 'deliver', 'receipt',
  'rootTurn', 'matchRootSelection', 'turn', 'models', 'model', 'selectModel', 'cancel', 'destroy', 'cursor'];
const MAX_TITLE_ATTEMPTS = 5;
const FIRST_DISPATCH_GRACE_MS = 2 * 60 * 1000;
const fail = (code, message, extra = {}) => Object.assign(new Error(message), { code }, extra);
// The ordinary message the shared layer still sends after a withdrawn or interrupted
// card: the helper never got the parent's text through the native channel, so it must
// arrive the usual way. A direct native answer is the only case that skips it.
const NATIVE_FALLBACK_CONTINUATION = answer => `Parent answer:\n${answer}\nContinue the same task.`;

/** A card's question id is derived from everything that identifies it on the wire. A
 * reconnect can reuse the numeric request id, so that id alone is not an identity. */
export function nativeQuestionId(card) {
  const identity = [card?.threadId, card?.turnId, card?.itemId, card?.requestId];
  return `native-${createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 32)}`;
}

/** The question text the parent sees: header, body, the offered answers, and - when a
 * card carries several questions - one short reply format. */
export function nativeQuestionText(card) {
  const questions = Array.isArray(card?.questions) ? card.questions : [];
  const lines = [];
  for (const [index, question] of questions.entries()) {
    const header = typeof question?.header === 'string' && question.header.trim() ? question.header.trim() : `问题 ${index + 1}`;
    const body = typeof question?.question === 'string' ? question.question.trim() : '';
    lines.push(questions.length > 1 ? `${index + 1}. ${header}：${body}` : `${header}：${body}`);
    if (question?.isOther === true) lines.push('   （也可以直接写自由文本）');
    for (const option of Array.isArray(question?.options) ? question.options : []) {
      const label = typeof option?.label === 'string' ? option.label.trim() : '';
      if (!label) continue;
      const description = typeof option?.description === 'string' ? option.description.trim() : '';
      lines.push(`   - ${label}${description ? `（${description}）` : ''}`);
    }
  }
  if (questions.length > 1) {
    lines.push('回复格式：一行 JSON，键为题号 1..N、值为答案数组，例如 {"1":["选项"],"2":["自由文本"]}。');
  }
  return lines.join('\n');
}

/** One question's answer, validated against the card before anything is written. */
function nativeAnswerValues(question, raw) {
  const values = (Array.isArray(raw) ? raw : [raw]).map(value => String(value ?? '').trim()).filter(Boolean);
  if (!values.length) throw fail('native-answer-invalid', 'An answer cannot be empty; nothing was sent.');
  const labels = (Array.isArray(question?.options) ? question.options : [])
    .map(option => typeof option?.label === 'string' ? option.label.trim() : '').filter(Boolean);
  for (const value of values) {
    if (labels.includes(value) || question?.isOther === true) continue;
    throw fail('native-answer-invalid',
      `"${value}" is not one of the offered answers${labels.length ? `: ${labels.join(' / ')}` : ''}. Nothing was sent.`);
  }
  return { answers: values };
}

/** The whole card's structured answer: one question is the text itself, several need a
 * JSON object keyed by question number (or id) or numbered lines. */
export function nativeAnswers(card, message) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) throw fail('native-answer-invalid', 'An answer needs text; nothing was sent.');
  const questions = Array.isArray(card?.questions) ? card.questions : [];
  if (!questions.length) throw fail('native-answer-invalid', 'This native card carries no question.');
  if (questions.length === 1) return { [questions[0].id]: nativeAnswerValues(questions[0], text) };
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const answers = {};
    for (const [index, question] of questions.entries()) {
      const key = [String(index + 1), question.id].find(candidate => parsed[candidate] !== undefined);
      if (key === undefined) throw fail('native-answer-invalid', `Missing an answer for question ${index + 1}; nothing was sent.`);
      answers[question.id] = nativeAnswerValues(question, parsed[key]);
    }
    return answers;
  }
  const answers = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s*[.、:：)]\s*(.+)$/);
    if (!match) continue;
    const question = questions[Number(match[1]) - 1];
    if (!question) throw fail('native-answer-invalid', `There is no question ${match[1]}; nothing was sent.`);
    answers[question.id] = nativeAnswerValues(question, match[2]);
  }
  if (Object.keys(answers).length !== questions.length) {
    throw fail('native-answer-invalid', 'Answer every question by number, or send one JSON object; nothing was sent.');
  }
  return answers;
}

export async function createCodexBackend(record, deps = {}) {
  const load = deps.load ?? (() => record);
  const releasing = (deps.hostOptions?.idleSessionCleanup ?? deps.idleSessionCleanup) !== false;
  const host = { ...createCodexHost({ ...deps.hostOptions, idleSessionCleanup: releasing }), ...deps.host };
  const state = () => ({ requests: {}, projections: {}, ...deps.readNativeState?.() });
  const save = value => {
    if (!deps.writeNativeState) throw fail('codex-state-unavailable', 'The shared native-state store is required.');
    // A release attempt may have been recorded while this caller was awaiting a native
    // read. It is never part of what a dispatch saves, so the stored copy wins: erasing
    // it would leave the next dispatch with no reason to resubscribe the thread.
    if (releasing && !deps.writeNativeRelease && deps.readNativeState) {
      const latest = deps.readNativeState() ?? {};
      if (latest.release === undefined) delete value.release;
      else value.release = latest.release;
    }
    if (deps.writeNativeState(value) === false) throw fail('agent-not-found', 'This managed Codex name was removed.');
    return value;
  };
  // The release record is the one field this backend owns alone. `deps.writeNativeRelease`
  // is the store's own atomic patch and the only writer used when it exists: a read then
  // write across two SQLite connections races even inside one synchronous section. The
  // local fallback below is for the in-memory deps of the unit tests, which have exactly
  // one connection. It reports `false` when the round's fence (taskId + ticket) is gone,
  // which is a refusal to write, never a failure of the round.
  const writeRelease = async (patch, fence = {}) => {
    if (typeof deps.writeNativeRelease === 'function') return (await deps.writeNativeRelease(patch, fence)) !== false;
    if (!deps.writeNativeState) throw fail('codex-state-unavailable', 'The shared native-state store is required.');
    const latest = { ...state() };
    const current = load();
    if (fence.taskId !== undefined && (current.task?.taskId ?? latest.taskId) !== fence.taskId) return false;
    if (fence.ticket !== undefined && current.releaseState?.ticket !== undefined
        && current.releaseState.ticket !== fence.ticket) return false;
    latest.release = { ...patch };
    if (deps.writeNativeState(latest) === false) throw fail('agent-not-found', 'This managed Codex name was removed.');
    return true;
  };
  // An accepted dispatch that restored its own subscription is already the caller's
  // result; recording that must never turn it into a failure, so a lost fence or a store
  // refusal here is dropped. It only means the next release asks again, which is right.
  const markResubscribed = async (sessionId, taskId) => {
    try {
      const latest = state();
      if (!latest.release) return;
      await writeRelease({ ...latest.release, taskId: taskId ?? latest.release.taskId,
        nodes: { ...(latest.release.nodes ?? {}), [sessionId]: 'resubscribed' } },
      taskId === undefined ? {} : { taskId });
    } catch { /* best effort: the turn is already accepted */ }
  };
  // The shared layer fences a dispatch by handing the adapter a callback with the call
  // itself; it reads the current name's row, so every answer is current. A call that
  // carries none keeps today's behaviour exactly. The callback is synchronous and
  // read-only, and it is asked again wherever a real write is about to leave: after the
  // host lock, before a thread is created, and inside the native send once the thread has
  // been read or resumed.
  const fenceOf = callback => {
    if (typeof callback !== 'function') return undefined;
    return () => {
      const reason = callback();
      return typeof reason === 'string' && reason ? reason : undefined;
    };
  };
  const locked = action => deps.withHostLock ? deps.withHostLock(action) : action();
  // Native user-input cards live beside the delivery records in this name's state: they
  // survive a monitor restart, and a card is answered only while it is still the card the
  // desktop reports, matched on its original id, thread, turn and item.
  const nativeCardsFor = (value, taskId) => Object.values(value.nativeCards ?? {})
    .filter(card => card && card.taskId === taskId);
  const nativeQuestion = card => ({ id: card.id, taskId: card.taskId, state: 'pending',
    message: nativeQuestionText(card), ...(card.createdAt === undefined ? {} : { createdAt: card.createdAt }) });
  // One card at a time: the first attributable card is the one the parent is asked about
  // and the one an answer applies to. The next card only appears after this one settles.
  const firstNativeCard = cards => cards.slice().sort((left, right) => (String(left.createdAt ?? '')).localeCompare(String(right.createdAt ?? ''))
    || String(left.id).localeCompare(String(right.id)))[0];
  const firstNativeQuestion = cards => {
    const card = firstNativeCard(cards);
    return card ? [nativeQuestion(card)] : [];
  };
  /**
   * The native card the parent has already been told about. The shared layer owns that
   * bookkeeping and hands it in; until it does, this adapter's own record of having shown
   * a card is the honest stand-in. A card that is already out must be settled first, and
   * only one kind of question may be in front of the parent at a time.
   */
  const presentedNative = () => {
    // The real pure function from the shared contract is the default; a test may hand in
    // its own stand-in, and production never needs extra wiring.
    const presented = typeof deps.presentedNativeQuestion === 'function'
      ? deps.presentedNativeQuestion : presentedNativeQuestion;
    const answer = presented(load());
    const id = typeof answer === 'string' ? answer : answer?.id;
    return typeof id === 'string' && id ? id : undefined;
  };
  const sameNativeCard = (entry, card) => entry.threadId === card.threadId
    && entry.turnId === card.turnId && entry.itemId === card.itemId
    && entry.requestId === card.requestId;
  const forgetNativeCard = (value, card) => {
    if (!value.nativeCards?.[card.id]) return;
    delete value.nativeCards[card.id];
    if (!Object.keys(value.nativeCards).length) delete value.nativeCards;
    save(value);
  };
  function consumeNative(value, card, answerId, extra) {
    // The answer id keeps the proof: a repeated answer with the same id is answered from
    // the record instead of writing a second time.
    const result = { consumedQuestionIds: [card.id], ...extra };
    (value.answers ??= {})[answerId] = result;
    forgetNativeCard(value, card);
    return result;
  }
  /**
   * Read the pending native cards of this task, but only when the thread itself says it
   * waits for a human. Without that flag no extra request is made at all, so an ordinary
   * poll and every fixture written before this feature behave exactly as they did.
   */
  // The card the parent is already answering is the only one that may be shown; when it
  // is gone this never falls back to the next card, because the parent's answer is for it.
  const selectNative = cards => {
    const presented = presentedNative();
    if (presented) return cards.filter(card => card.id === presented).map(nativeQuestion);
    return firstNativeQuestion(cards);
  };
  async function refreshNativeQuestions(value, tree, { explicitWaiting = false } = {}) {
    const taskId = load().task?.taskId, binding = value.binding;
    const present = nativeCardsFor(value, taskId);
    if (typeof host.readUserInput !== 'function' || binding?.owned !== true) return [];
    const flags = Array.isArray(tree?.activeFlags) ? tree.activeFlags : null;
    const statusType = typeof tree?.statusType === 'string' ? tree.statusType : null;
    // A card is only ever proven gone by the thread's own state: an explicitly empty flag
    // list, an idle thread or a terminal one. A missing field, like a failed or unverified
    // read, is not evidence, and the cards already observed are kept.
    if ((flags !== null && flags.length === 0) || ['idle', 'notLoaded', 'systemError'].includes(statusType)) {
      if (value.nativeCards) { value.nativeCards = {}; save(value); }
      return [];
    }
    // A read that cannot be made proves nothing: the card already observed and not yet
    // disposed stays in front of the parent, so the round stays awaiting an answer.
    const unproven = () => (explicitWaiting && !presentedNative() ? [] : selectNative(present));
    if (statusType !== 'active' || flags === null || !flags.includes('waitingOnUserInput')) return unproven();
    let seen;
    try { seen = await host.readUserInput({ nativeSessionId: binding.sessionId }); }
    catch { return unproven(); }
    if (seen.status !== 'observed') return unproven();
    // Only a turn this task already had accepted natively can own a card; anything else
    // cannot be attributed and is left alone.
    const turns = new Set(Object.values(value.requests ?? {})
      .filter(request => request?.taskId === taskId && request.status === 'accepted' && typeof request.turnId === 'string')
      .map(request => request.turnId));
    const kept = {};
    for (const entry of seen.requests) {
      if (entry.threadId !== binding.sessionId) continue;
      // The transport marks everything that is not a plain question (secret text, an MCP
      // approval) and that is never relayed, answered or written here.
      if (entry.kind !== 'question') continue;
      if (typeof entry.turnId !== 'string' || !turns.has(entry.turnId)) continue;
      const id = nativeQuestionId(entry);
      kept[id] = { ...entry, id, taskId };
    }
    value.nativeCards = kept;
    save(value);
    // An explicit ask_parent that is waiting wins the parent's attention unless a native
    // card is already out; a card that is out is settled first, and only then the next.
    const cards = Object.values(kept);
    if (!cards.length) return [];
    if (presentedNative()) return selectNative(cards);
    if (explicitWaiting) return [];
    return firstNativeQuestion(cards);
  }
  async function withdrawNative(value, card, live, message, answerId, requireAnswerable, canAnswer) {
    // The direct answer is not supported on this build. The UI primitive withdraws the
    // card with an empty answer map. Only an explicit `unsupported` for that attempt, on
    // a card that is re-confirmed on the same turn, may go on to interrupt the turn.
    requireAnswerable();
    let withdrawal;
    try { withdrawal = await host.replyUserInput({ card: { ...live, id: card.id, taskId: card.taskId }, answers: {}, canAnswer }); }
    catch { throw fail('native-answer-unconfirmed', 'The withdrawal could not be made; nothing was sent.'); }
    if (withdrawal.status === 'answered') {
      return consumeNative(value, card, answerId,
        { nativeFallback: true, continuation: NATIVE_FALLBACK_CONTINUATION(message), withdrewCard: true });
    }
    if (withdrawal.status !== 'unsupported') {
      // `unknown` is unproven and `not-pending` means there is nothing left to stop:
      // neither is permission to interrupt a turn.
      if (withdrawal.status === 'not-pending') forgetNativeCard(value, card);
      throw fail('native-answer-unconfirmed',
        `The card could not be withdrawn (${withdrawal.reason ?? withdrawal.status}); nothing was interrupted.`);
    }
    // Re-confirm the very same card on the very same turn before touching the turn.
    let before;
    try { before = await host.readUserInput({ nativeSessionId: card.threadId }); }
    catch { throw fail('native-answer-unconfirmed', 'The card could not be re-confirmed; nothing was interrupted.'); }
    if (before.status !== 'observed' || !before.requests.some(entry => sameNativeCard(entry, card))) {
      forgetNativeCard(value, card);
      throw fail('native-question-not-pending', 'This native question is no longer pending; nothing was interrupted.');
    }
    // The card must still be a plain question: a turn is never touched on the strength of
    // a card that lost its type evidence.
    const stillLive = before.requests.find(entry => sameNativeCard(entry, card));
    if (stillLive?.kind !== 'question') {
      forgetNativeCard(value, card);
      throw fail('native-answer-unconfirmed', 'This card is no longer a plain question; nothing was interrupted.');
    }
    if (typeof host.interruptTurn !== 'function' || typeof card.turnId !== 'string' || !card.turnId) {
      throw fail('native-answer-unconfirmed', 'The card cannot be withdrawn and its turn is unknown; nothing was sent.');
    }
    // Asked once more right before the interrupt, after the read that re-confirmed it.
    requireAnswerable();
    try { await host.interruptTurn({ nativeSessionId: card.threadId, turnId: card.turnId, canAnswer }); }
    catch { throw fail('native-answer-unconfirmed', 'The turn could not be interrupted; nothing was claimed.'); }
    // A stop needs both halves read back: the card gone AND that turn no longer running.
    let after, turn;
    try {
      after = await host.readUserInput({ nativeSessionId: card.threadId });
      turn = typeof host.readTurnStatus === 'function'
        ? await host.readTurnStatus({ nativeSessionId: card.threadId, turnId: card.turnId })
        : undefined;
    } catch { throw fail('native-answer-unconfirmed', 'The stop could not be read back; nothing was claimed.'); }
    const cardGone = after.status === 'observed' && !after.requests.some(entry => sameNativeCard(entry, card));
    // A turn row that is missing or unreadable is not proof of a stop: the thread can be
    // active with its turn row gone, so only a read-back of that same turn counts.
    const stopped = turn === undefined ? undefined
      : (turn.present === true && ['ended', 'completed', 'failed', 'interrupted'].includes(turn.status));
    if (!cardGone || stopped !== true) {
      throw fail('native-answer-unconfirmed',
        'The turn was interrupted, but the stop was not proven; nothing was claimed.', { cardGone, stopped });
    }
    return consumeNative(value, card, answerId,
      { nativeFallback: true, continuation: NATIVE_FALLBACK_CONTINUATION(message), interrupted: true });
  }
  async function answerNative(value, message, answerId, { explicitWaiting = false, canAnswer } = {}) {
    // The shared layer's own fence for this round: synchronous, asked again after every
    // asynchronous read and immediately before any write. Absent means an older caller
    // that never had one, and then nothing here behaves differently.
    const answerable = () => {
      const check = typeof canAnswer === 'function' ? canAnswer : deps.canAnswer;
      if (typeof check !== 'function') return true;
      try { return check() === true; } catch { return false; }
    };
    const requireAnswerable = () => {
      if (!answerable()) {
        throw fail('native-answer-unconfirmed', 'This question can no longer be answered for this round; nothing was sent.');
      }
    };
    const taskId = load().task?.taskId, binding = value.binding;
    const cards = nativeCardsFor(value, taskId);
    const presented = presentedNative();
    if (!cards.length && !presented) return undefined;
    if (binding?.owned !== true || typeof host.readUserInput !== 'function' || typeof host.replyUserInput !== 'function') {
      throw fail('native-answer-unconfirmed', 'The native question cannot be verified on this host; nothing was sent.');
    }
    // Whoever the parent was last shown is answered first; a card that is already out is
    // settled before an explicit question, and an explicit waiting question keeps the
    // native one off the parent's plate until it is consumed.
    const shown = presented ? cards.find(entry => entry.id === presented) : undefined;
    if (presented && !shown) {
      // The parent is answering that card; a different, later card is never substituted.
      throw fail('native-question-not-pending', 'The question this answer belongs to is no longer pending; nothing was sent.');
    }
    if (!presented && explicitWaiting) return undefined;
    const card = shown ?? firstNativeCard(cards);
    let seen;
    try { seen = await host.readUserInput({ nativeSessionId: binding.sessionId }); }
    catch { throw fail('native-answer-unconfirmed', 'The desktop could not be asked whether this question is still pending; nothing was sent.'); }
    if (seen.status !== 'observed') {
      throw fail('native-answer-unconfirmed', 'The desktop could not be asked whether this question is still pending; nothing was sent.');
    }
    const live = seen.requests.find(entry => sameNativeCard(entry, card));
    if (!live) {
      // A card that is gone was not answered by this call, and a stale card is never
      // written to: the parent gets a refusal, not a claimed success.
      forgetNativeCard(value, card);
      throw fail('native-question-not-pending', 'This native question is no longer pending; nothing was sent.');
    }
    // The card can change shape between the relay and the answer; only a plain question
    // this build understands may be written to.
    if (live.kind !== 'question') {
      forgetNativeCard(value, card);
      throw fail('native-answer-unconfirmed', 'This card is no longer a plain question; nothing was sent.');
    }
    const answers = nativeAnswers({ ...live, id: card.id }, message);
    // Checked after the read that just happened, immediately before the write.
    requireAnswerable();
    let reply;
    try { reply = await host.replyUserInput({ card: { ...live, id: card.id, taskId }, answers, canAnswer: answerable }); }
    catch { throw fail('native-answer-unconfirmed', 'The answer could not be confirmed by the desktop; nothing was claimed.'); }
    if (reply.status === 'answered') return consumeNative(value, card, answerId, { nativeAnswered: true });
    if (reply.status === 'unsupported') return withdrawNative(value, card, live, message, answerId, requireAnswerable, answerable);
    if (reply.status === 'not-pending') {
      forgetNativeCard(value, card);
      throw fail('native-question-not-pending', 'This native question is no longer pending; nothing was sent.');
    }
    throw fail('native-answer-unconfirmed',
      `The desktop did not confirm this answer (${reply.reason ?? reply.status}); nothing was claimed.`);
  }
  async function applyPendingTitle(value) {
    if (!value.pendingTitle || !value.binding) return;
    if (value.pendingTitle.attempts >= MAX_TITLE_ATTEMPTS) {
      delete value.pendingTitle; save(value); return;
    }
    const projection = value.projections[value.binding.sessionId];
    if (!projection?.messages?.length || typeof host.setTitle !== 'function') return;
    value.pendingTitle.attempts += 1;
    save(value);
    try {
      await host.setTitle({ nativeSessionId: value.binding.sessionId, name: value.pendingTitle.name });
      delete value.pendingTitle;
    } catch {
      // An empty rollout is expected on the first attempts. Keep the task state
      // untouched; the next refresh retries, up to the bounded attempt count.
      if (value.pendingTitle.attempts >= MAX_TITLE_ATTEMPTS) delete value.pendingTitle;
    }
    save(value);
  }
  async function reportsReady() {
    const result = await deps.ensureCodexReports?.(load());
    if (result?.ready !== true || !deps.readCodexReportState) {
      throw fail('codex-report-not-ready', 'The explicit Codex parent-report tools have not been connected.');
    }
  }
  async function recover(value) {
    if (value.binding) return value;
    const first = Object.values(value.requests).find(request => request.attempted);
    if (!first) return value;
    const native = await host.findCreatedSession({ workspace: load().workspace, marker: first.marker, startedAt: first.startedAt });
    if (native?.nativeSessionId) {
      value.binding = { sessionId: native.nativeSessionId, owned: true };
      value.pendingTitle ??= { name: load().name, attempts: 0 };
      save(value);
    } else if (Number.isFinite(Date.parse(first.startedAt))
        && Date.now() - Date.parse(first.startedAt) >= FIRST_DISPATCH_GRACE_MS) {
      // The first write was never observed. After the grace period, stop looking
      // and turn the ambiguous dispatch into a visible terminal failure.
      throw fail('codex-first-dispatch-unconfirmed',
        'The first Codex dispatch was not found in any thread after 2 minutes. It was not delivered; reassign the task if needed.',
        { terminal: true });
    }
    return value;
  }
  async function refresh() {
    let value = await recover(state());
    if (!value.binding) return { value, tree: { nodes: [], running: false,
      settled: !Object.values(value.requests).some(r => r.attempted) }, histories: {} };
    const observed = await host.observe({ nativeSessionId: value.binding.sessionId, workspace: load().workspace,
      projections: value.projections, requests: value.requests });
    value.projections = observed.projections;
    value.tree = observed.tree;
    for (const [id, delivery] of Object.entries(value.projections[value.binding.sessionId]?.deliveries ?? {})) {
      const request = value.requests[id];
      if (!request || request.status !== 'accepted') continue;
      // The projection is observation, not recovery: an unknown write with a
      // write-ahead intent is settled only by the strict read-only reconciliation.
      // A body reference can no longer become a delivery because projectCodexTurns
      // now requires the exact final-line marker.
      request.deliverySeq = delivery.seq;
      if (!request.turnId) request.turnId = delivery.turnId;
      if (request.route === 'accepted-route-unknown') {
        // The same criteria as reconcile: a start needs the exact marker as the
        // first user input of a turn different from the recorded prior turn; a
        // steer needs the expected turn and a non-first input. A planned start is
        // never evidence by itself.
        const intended = request.intent ?? request.native ?? {};
        const method = intended.method;
        if (method === 'turn/start' && delivery.firstUser === true
            && intended.priorTurnId !== undefined && delivery.turnId !== intended.priorTurnId) {
          request.route = 'new-turn';
          request.turnId = delivery.turnId;
          request.native = { ...(request.native ?? {}), method, turnId: delivery.turnId, strengthened: true };
        } else if (method === 'turn/steer' && delivery.firstUser === false
            && typeof intended.expectedTurnId === 'string' && delivery.turnId === intended.expectedTurnId) {
          request.route = 'current-turn';
          request.turnId = delivery.turnId;
          request.native = { ...(request.native ?? {}), method, turnId: delivery.turnId, strengthened: true };
        }
      }
    }
    await applyPendingTitle(value);
    save(value);
    return { value, ...observed };
  }
  function projection(value) { return value.projections[value.binding?.sessionId] ?? emptyProjection(); }
  /**
   * One request's public receipt. `delivery` is the route the native write took
   * (`current-turn` / `new-turn` / `after-current` / `accepted-route-unknown`);
   * the stored wire selection stays on `request.delivery` for old readers.
   */
  function receiptFrom(value, id) {
    const request = value.requests[id];
    if (!request) return undefined;
    return {
      accepted: request.status === 'accepted',
      status: request.status,
      ...(Number.isSafeInteger(request.afterSeq) ? { afterSeq: request.afterSeq } : {}),
      ...(request.route ? { delivery: request.route } : {}),
      ...(request.turnId ? { turnId: request.turnId } : {}),
      ...(request.afterTurnId ? { afterTurnId: request.afterTurnId } : {}),
      ...(request.mode ? { mode: request.mode } : {}),
      ...(request.intent ? { intent: request.intent } : {}),
      ...(request.native ? { native: request.native } : {}),
      ...(request.reschedule ? { reschedule: request.reschedule } : {}),
      ...(request.status === 'accepted' ? { result: { accepted: true, requestId: id } } : {}),
    };
  }
  /** Request ids the shared task record independently proves are first dispatches. */
  const taskStartIds = () => new Set((load().task?.dispatches ?? [])
    .filter(dispatch => dispatch?.kind === 'task' && dispatch.accepted === true
      && typeof dispatch.turnId === 'string' && dispatch.model)
    .map(dispatch => dispatch.requestId));
  /** Accepted turn/start evidence, keyed by the native turn it started. A steer's
   * frozen pin is never evidence of how that turn was started, even when the steer
   * shares the turn id; only a recorded start, a legacy task row, or a task dispatch
   * the shared layer marked as the first dispatch counts. */
  const knownSelectionsFor = value => {
    const taskStarts = taskStartIds();
    return Object.values(value.requests ?? {})
      .filter(request => request?.status === 'accepted' && typeof request.turnId === 'string'
        && typeof request.delivery?.model === 'string'
        && (request.route === 'new-turn' || request.kind === 'task'
          || taskStarts.has(request.requestId)))
      .map(request => ({ turnId: request.turnId, model: request.delivery.model,
        ...(request.delivery.effort ? { reasoningEffort: request.delivery.effort } : {}) }));
  };
  /**
   * A process can die after the native write and before its receipt is saved. Recovery
   * only reads the bound thread's own user inputs and never sends the message again.
   * A marker proves receipt; the write-ahead intent decides the route, and a route it
   * cannot prove stays explicitly unknown.
   */
  async function reconcileRequest(value, request) {
    if (!request || !['unknown', 'sending'].includes(request.status)) return request;
    if (!value.binding || typeof host.findDispatchInput !== 'function') return request;
    let evidence;
    try {
      evidence = await host.findDispatchInput({ nativeSessionId: value.binding.sessionId, marker: request.marker });
    } catch {
      return request;
    }
    if (evidence?.status === 'not-found') {
      request.reconcile = { at: new Date().toISOString(), result: 'not-found' };
      save(value);
      return request;
    }
    if (evidence?.status === 'ambiguous') {
      Object.assign(request, { status: 'accepted', route: 'accepted-route-unknown',
        native: { method: request.intent?.method ?? null, ambiguous: true, at: new Date().toISOString() } });
      save(value);
      return request;
    }
    if (evidence?.status !== 'found') return request;
    if (!request.intent) {
      // A legacy unknown has no write-ahead intent. The exact marker in this
      // request's own native user input proves it was written, but nothing can
      // prove which method took it. Accept the fact and leave the route unknown;
      // never reverse-infer steer/start and never replay.
      Object.assign(request, {
        status: 'accepted', route: 'accepted-route-unknown', turnId: evidence.turnId,
        native: { method: null, turnId: evidence.turnId, recovered: true, legacy: true,
          at: new Date().toISOString() },
      });
      save(value);
      return request;
    }
    const route = request.intent.method === 'turn/steer' && evidence.turnId === request.intent.expectedTurnId
      ? 'current-turn'
      : request.intent.method === 'turn/start' && evidence.firstUser === true
        && evidence.turnId !== request.intent.priorTurnId
        ? 'new-turn' : 'accepted-route-unknown';
    Object.assign(request, {
      status: 'accepted',
      route,
      ...(route === 'accepted-route-unknown' ? {} : { turnId: evidence.turnId }),
      native: { method: request.intent.method, turnId: evidence.turnId, recovered: true,
        at: new Date().toISOString() },
    });
    save(value);
    return request;
  }
  const ownedIds = value => value.tree?.nodes?.map(node => node.sessionId) ?? (value.binding ? [value.binding.sessionId] : []);
  async function reportState(value) {
    const current = load();
    const data = await deps.readCodexReportState?.(current) ?? { questions: [], reports: [] };
    return { questions: (data.questions ?? []).filter(q => q.taskId === current.task?.taskId)
      .map(q => ({ ...q, state: value.answeredQuestionIds?.includes(q.id) ? 'answered' : q.state })),
    reports: (data.reports ?? []).filter(r => r.taskId === current.task?.taskId) };
  }
  return {
    target: 'codex-desktop', labels: { host: 'Codex Desktop', bridge: 'The Codex Desktop bridge' }, requiredMethods: METHODS,
    async probe() {
      const [result, reportStatus] = await Promise.all([
        host.probe(), deps.readCodexReportStatus?.(load()),
      ]);
      if (result.missing?.length) throw fail('codex-backend-not-ready', `Missing native Codex capabilities: ${result.missing.join(', ')}.`);
      return { identity: result.identity, methods: METHODS, treeProtocol: 1,
        reportProtocol: reportStatus?.ready === true && deps.readCodexReportState ? 1 : null,
        evidence: 'native-rpc' };
    },
    async create() {
      await reportsReady();
      save({ ...state(), reserved: true });
      return { sessionId: load().sessionId, modelRequestsStarted: 0 };
    },
    async beginTask() {
      const { value } = await refresh();
      if (value.taskId !== load().task?.taskId) {
        value.taskId = load().task?.taskId;
        value.taskStartSeq = projection(value).seq;
        value.taskNodeBaselines = Object.fromEntries(Object.entries(value.projections).map(([id, p]) => [id, p.seq]));
        value.answeredQuestionIds = [];
        value.answers = {};
        // A card belongs to the round that produced it: the next round starts clean.
        delete value.nativeCards;
        save(value);
      }
      // An unbound name has no native session yet, so there is no live selection
      // to read. In particular this keeps an explicit first selection independent
      // from a config.toml default that omits model or effort.
      const currentModel = value.binding ? await host.readCurrentModel(value.binding.sessionId) : undefined;
      return { treeProtocol: 1, reportProtocol: 1, throughSeq: projection(value).seq,
        ...(currentModel ? { currentModel } : {}) };
    },
    async observe() {
      const { value, tree } = await refresh();
      const p = projection(value), explicit = await reportState(value), current = load();
      // A native question is only ever read behind the thread's own waiting flag.
      const native = await refreshNativeQuestions(value, tree,
        { explicitWaiting: explicit.questions.some(question => question.state === 'pending') });
      const logical = id => id === value.binding?.sessionId ? current.sessionId : id;
      const nodes = tree.nodes.map(node => ({ ...node, sessionId: logical(node.sessionId),
        parentSessionId: node.parentSessionId ? logical(node.parentSessionId) : null,
        changes: node.changes.filter(change => change.seq > (value.taskNodeBaselines?.[node.sessionId] ?? 0)) }));
      if (!nodes.length) nodes.push({ sessionId: current.sessionId, parentSessionId: null,
        name: current.name, status: 'idle', activity: 'idle', changes: [], coverage: CODEX_FILE_COVERAGE });
      return { sessionId: current.sessionId, taskId: current.task?.taskId, running: tree.running,
        throughSeq: p.seq, currentModel: p.currentModel, modelSelectionObserved: false,
        changes: nodes.flatMap(n => n.changes), coverage: CODEX_FILE_COVERAGE, ...explicit,
        questions: native.length || presentedNative() ? native : explicit.questions,
        tree: { ...tree, nodes } };
    },
    async history({ targetSessionId, maxMessages = 20 } = {}) {
      const value = state();
      const id = !targetSessionId || targetSessionId === load().sessionId ? value.binding?.sessionId : targetSessionId;
      if (!id && !value.binding) return { messages: [], hasMore: false };
      if (typeof host.readHistory === 'function') {
        if (id !== value.binding?.sessionId && !(value.tree?.nodes ?? []).some(node => node.sessionId === id)) {
          throw fail('unknown-owned-node', 'This thread is not in the managed Codex tree.');
        }
        const page = await host.readHistory({ nativeSessionId: id, maxMessages });
        return { messages: page.messages.slice(-maxMessages), hasMore: page.hasMore || page.messages.length > maxMessages };
      }
      const { histories } = await refresh();
      if (!histories[id]) throw fail('unknown-owned-node', 'This thread is not in the managed Codex tree.');
      const page = histories[id];
      return { messages: page.messages.slice(-maxMessages), hasMore: page.hasMore || page.messages.length > maxMessages };
    },
    async answer({ answerId, message, canAnswer }) {
      const value = state();
      if (value.answers?.[answerId]) return value.answers[answerId];
      const pending = (await reportState(value)).questions.filter(q => q.state === 'pending');
      const native = await answerNative(value, message, answerId, { canAnswer, explicitWaiting: pending.length > 0 });
      if (native) return native;
      if (!pending.length) throw fail('question-not-pending', 'There is no pending question for this task.');
      const result = { consumedQuestionIds: pending.map(q => q.id), continuation: `Parent answer:\n${message}\nContinue the same task.` };
      value.answeredQuestionIds = [...(value.answeredQuestionIds ?? []), ...result.consumedQuestionIds];
      (value.answers ??= {})[answerId] = result; save(value);
      return result;
    },
    async deliver({ requestId, message, kind, mode, selectionExplicit, model: dispatchModel,
      explicitModel, allowStart = true, writeBlockReason }) {
      // The shared layer's fence for this call. Absent means the caller never gated its
      // dispatch, and then nothing here may behave differently.
      const asksWrite = fenceOf(writeBlockReason);
      if (!requestId || typeof message !== 'string' || !message.trim()) throw fail('invalid-dispatch', 'A request id and message are required.');
      if (mode !== undefined && !['steer', 'queue'].includes(mode)) {
        throw fail('invalid-mode', 'mode must be steer or queue; no name, record or native write was touched.',
          { terminal: true });
      }
      await reportsReady();
      let value = await recover(state());
      const hash = createHash('sha256').update(message).digest('hex');
      let prior = value.requests[requestId];
      if (prior && prior.messageHash !== hash) throw fail('request-id-conflict', 'This request id already belongs to another message.');
      // A lost RPC reply or a process exit before the receipt is persisted is verified
      // read-only against the bound thread. It is never sent again.
      if (prior && ['unknown', 'sending'].includes(prior.status)) {
        prior = await reconcileRequest(value, prior);
        if (['accepted', 'unknown', 'sending'].includes(prior.status)) return receiptFrom(value, requestId);
      }
      if (prior && ['accepted', 'rejected', 'failed'].includes(prior.status)) {
        return receiptFrom(value, requestId);
      }
      // The tri-state selection intent:
      //   true      - this call explicitly selects; an active turn must prove it;
      //   false     - this call made no selection; a frozen pin is for the next turn;
      //   undefined - a legacy call/record. With an old frozen selection, an active
      //               turn must prove that selection or nothing is written.
      const priorExplicit = prior?.explicitModel === true;
      const explicitNow = selectionExplicit !== undefined ? selectionExplicit === true
        : (explicitModel === true || priorExplicit);
      if (prior && !priorExplicit && selectionExplicit === true) {
        throw fail('request-id-conflict', 'This request id was already recorded without a model selection.');
      }
      if (prior && !priorExplicit && dispatchModel !== undefined && selectionExplicit === undefined) {
        throw fail('request-id-conflict', 'This request id was already recorded without a model selection.');
      }
      let frozenSelection;
      if (explicitNow) {
        frozenSelection = prior?.model
          ?? dispatchModel
          ?? load().task?.dispatches?.find(item => item.requestId === requestId && item.explicitModel === true)?.model
          ?? value.selectedModels?.[`${requestId}-model`];
      } else if (selectionExplicit === false) {
        // A queue row freezes the pin it was accepted with, even when the caller did
        // not select it. It is used only if this input later starts a new turn.
        frozenSelection = prior?.model ?? dispatchModel;
      } else {
        // Legacy: an old explicit selection must be verified on an active turn; a
        // 0.5.13 display-only model without the flag is ignored and the turn inherits.
        frozenSelection = priorExplicit ? prior?.model
          : (prior ? undefined : dispatchModel);
      }
      if (explicitNow && !frozenSelection?.model) {
        throw fail('model-required', 'An explicit Codex model selection requires a model id; no turn was started.', { terminal: true });
      }
      if (explicitModel === true && dispatchModel !== undefined && frozenSelection
          && (dispatchModel.model !== frozenSelection.model
            || (dispatchModel.reasoningEffort ?? undefined) !== (frozenSelection.reasoningEffort ?? undefined)
            || (dispatchModel.provider ?? undefined) !== (frozenSelection.provider ?? undefined))) {
        throw fail('request-id-conflict', 'This request id already belongs to another model selection.');
      }
      // Resolve only when this request carries a frozen selection and has no resolved
      // wire value yet. Every retry reuses the same native slug and effort.
      let delivery = prior?.delivery;
      if (frozenSelection?.model && !delivery) {
        try {
          delivery = await host.resolveModelDelivery({ selection: frozenSelection, workspace: load().workspace });
        } catch (error) {
          // Catalog/config resolution is read-only: a transient transport failure
          // here is safe to retry and must not become a failed dispatch. A real
          // missing model or effort remains terminal.
          if (['model-required', 'model-not-found', 'effort-not-supported',
            'codex-model-catalog-empty'].includes(error?.code)) {
            error.terminal = true;
            throw error;
          }
          if (isCodexReadRetryable(error)) {
            throw fail(error.code, error.message, {
              retryableRead: true,
              ...(error.rpcMessage ? { rpcMessage: error.rpcMessage } : {}),
            });
          }
          throw error;
        }
        if (!delivery?.model) throw fail('codex-native-rpc-invalid-response',
          'The selected model could not be mapped to a native Codex model slug.', { terminal: true });
      }
      value.nonce ??= randomUUID();
      if (!prior) {
        prior = { requestId, marker: markerLine(requestId, value.nonce), messageHash: hash, taskId: load().task?.taskId,
          kind: kind ?? (value.binding ? 'supplement' : 'task'),
          startedAt: new Date().toISOString(), afterSeq: projection(value).seq, status: 'retryable', attempted: false,
          mode: mode ?? 'steer', selectionExplicit: explicitNow,
          ...(frozenSelection ? { model: { ...frozenSelection }, explicitModel: explicitNow,
            ...(delivery ? { delivery: { model: delivery.model, ...(delivery.effort ? { effort: delivery.effort } : {}) } } : {}) }
            : { explicitModel: false }) };
        value.requests[requestId] = prior; save(value);
      } else {
        prior.mode = mode ?? prior.mode ?? 'steer';
        prior.selectionExplicit = selectionExplicit === undefined ? prior.selectionExplicit : explicitNow;
        if (frozenSelection?.model) {
          prior.model ??= { ...frozenSelection };
          prior.explicitModel = prior.explicitModel === true || explicitNow;
        }
        if (delivery?.model && !prior.delivery) {
          prior.delivery = { model: delivery.model, ...(delivery.effort ? { effort: delivery.effort } : {}) };
        }
        // A 0.5.13 request may carry a model without the explicit flag; that
        // historical display value is not a selection and must not leak into a turn.
        if (!frozenSelection && !priorExplicit && selectionExplicit === undefined) {
          delete prior.model; delete prior.delivery;
        }
        if (prior.explicitModel === undefined) prior.explicitModel = false;
        save(value);
      }
      const request = prior;
      const marker = request.marker;
      const effectiveMode = mode ?? request.mode ?? 'steer';
      request.mode = effectiveMode;
      // The caller persists the intended method and target here, after the final read
      // and immediately before the native write leaves. If the process dies after the
      // write, recovery reads this record instead of replaying the message.
      const onIntent = async intent => {
        request.intent = { ...intent, at: new Date().toISOString() };
        request.attempted = true;
        request.status = 'unknown';
        save(value);
      };
      let waiting = false;
      await locked(async () => {
        // The shared layer may fence this dispatch against a round that has already
        // ended, and the host lock can have queued for a while: nothing is attempted
        // under a fence that is already closed, so the request never looks sent.
        const refused = asksWrite?.();
        if (refused) {
          request.status = 'rejected'; request.refused = refused; save(value);
          throw fail(refused, 'The round ended before this input was written; nothing was sent.',
            { terminal: true, notSent: true });
        }
        if (!value.binding) {
          // The first dispatch writes its attempt before thread/start, so a round that
          // ends while the page is being opened is still fenced before any thread.
          request.attempted = true; request.status = 'unknown'; save(value);
        }
        // A thread this name already asked the desktop to release can still read as
        // idle while no subscription is left. The first real write after that has to
        // put the subscription back; a brand-new thread never does, and with the switch
        // off the original resume path is the only thing that touches the thread.
        const released = releasing && value.binding ? state().release?.nodes?.[value.binding.sessionId] : undefined;
        const resubscribe = typeof released === 'string' && released !== 'resubscribed';
        try {
          let turnId;
          let acceptedWrite = false;
          const taskMessage = !value.binding || kind === 'task'
            ? `${message}\n\n${CODEX_ASK_PARENT_INSTRUCTION}` : message;
          if (!value.binding) {
            if (allowStart === false) {
              Object.assign(request, { status: 'retryable', route: 'local-pending', attempted: false,
                reschedule: { reason: 'queue-head-pending', notSent: true, afterTurnId: null,
                  at: new Date().toISOString() } });
              save(value);
              waiting = true;
              return;
            }
            // The attempt record is written; a new thread is not even created for a
            // round that ended in that step.
            const late = asksWrite?.();
            if (late) {
              request.status = 'rejected'; request.refused = late; save(value);
              throw fail(late, 'The round ended before this input was written; no thread was created.',
                { terminal: true, notSent: true });
            }
            // With no selection no model, reasoning effort or permission field is
            // passed: the new thread inherits every one of them from the user's
            // defaults. The caller's task stays first; the marker moves to the last
            // line so the user sees the original request at the top.
            const first = await host.createFirstTurn({ workspace: load().workspace, title: load().name,
              requestId, message: `${taskMessage}\n\nYou are FutureAide managed helper ${JSON.stringify(load().name)}. `
                + 'Deliver the final result with '
                + 'report_parent(message, final=true). Ordinary replies do not report to your parent.\n\n'
                + marker,
              // The thread/start inside this call takes time; the shared fence is asked
              // once more between creating the thread and starting its first turn.
              ...(asksWrite ? { blockReason: asksWrite } : {}),
              onIntent,
              ...(request.delivery ? { model: request.delivery.model,
                effort: request.delivery.effort } : {}) });
            turnId = first?.turnId;
            acceptedWrite = first?.created === true || Boolean(turnId);
            if (first?.nativeSessionId) {
              value.binding = { sessionId: first.nativeSessionId, owned: true };
              value.pendingTitle ??= { name: load().name, attempts: 0 };
              save(value);
            }
            if (acceptedWrite) {
              Object.assign(request, { status: 'accepted', turnId, route: 'new-turn',
                native: { method: 'turn/start', turnId, priorTurnId: null, at: new Date().toISOString() } });
              save(value);
            }
          } else {
            const sent = await host.send({ nativeSessionId: value.binding.sessionId, message: `${taskMessage}\n\n${marker}`, requestId,
              mode: effectiveMode,
              ...(resubscribe ? { resubscribe: true } : {}),
              // The thread read and its resume come first; the fence is asked again
              // right before the turn would actually be written.
              ...(asksWrite ? { blockReason: asksWrite } : {}),
              ...(request.delivery ? { selection: { model: request.delivery.model,
                ...(request.delivery.effort ? { reasoningEffort: request.delivery.effort } : {}) } }
                : (dispatchModel === undefined ? {} : { selection: dispatchModel })),
              selectionExplicit: explicitNow ? true : (selectionExplicit === false ? false : undefined),
              ...(selectionExplicit === undefined && request.model?.model && !explicitNow ? { legacySelection: true } : {}),
              knownSelections: knownSelectionsFor(value),
              ...(allowStart === false ? { allowStart: false } : {}),
              onIntent });
            if (sent?.waiting === true) {
              // Queue met an active root turn: durable "after A", no native write.
              Object.assign(request, { status: 'waiting', route: 'after-current',
                afterTurnId: sent.afterTurnId, attempted: false });
              save(value);
              waiting = true;
              return;
            }
            if (sent?.reschedule === true) {
              // A native rejection proved the write never happened. If an active
              // root turn is now visible, wait behind it (`after-current`); if the
              // root is idle, another queued input or answer may be ahead, so hand
              // the item back to the shared FIFO as local-pending.
              const route = sent.delivery === 'after-current' ? 'after-current' : 'local-pending';
              Object.assign(request, { status: route === 'after-current' ? 'waiting' : 'retryable',
                route, attempted: false,
                ...(sent.afterTurnId ? { afterTurnId: sent.afterTurnId } : {}),
                reschedule: { reason: sent.reason ?? 'steer-turn-ended',
                  notSent: true, afterTurnId: sent.afterTurnId ?? null, at: new Date().toISOString() } });
              if (request.intent) request.intent = { ...request.intent, outcome: 'not-sent' };
              save(value);
              waiting = true;
              return;
            }
            turnId = sent?.turnId ?? sent?.turn?.id;
            acceptedWrite = sent?.sent === true || Boolean(turnId);
            if (acceptedWrite) {
              Object.assign(request, { status: 'accepted', ...(turnId ? { turnId } : {}),
                route: sent?.delivery ?? 'accepted-route-unknown',
                native: { method: sent?.method ?? null, turnId,
                  ...(sent?.priorTurnId !== undefined ? { priorTurnId: sent.priorTurnId }
                    : request.intent?.priorTurnId !== undefined ? { priorTurnId: request.intent.priorTurnId } : {}),
                  at: new Date().toISOString() } });
              if (resubscribe) await markResubscribed(value.binding.sessionId, request.taskId ?? load().task?.taskId);
              save(value);
            }
          }
        } catch (error) {
          if (error.nativeSessionId) {
            value.binding = { sessionId: error.nativeSessionId, owned: true };
            value.pendingTitle ??= { name: load().name, attempts: 0 };
            save(value);
          }
          // A terminal refusal happened before the native write (an ended round, a
          // model change, or a selection that could not be proven). It is not an
          // unknown write and must not be retried.
          if (error.terminal === true) {
            request.status = error.notSent === true ? 'rejected' : 'failed';
            if (error.notSent === true) request.refused = error.code; else delete request.refused;
            if (request.intent) request.intent = { ...request.intent, outcome: 'not-sent' };
            save(value);
            throw fail(error.code ?? 'codex-delivery-refused', error.message,
              { terminal: true, ...(error.notSent === true ? { notSent: true } : {}) });
          }
          // No debug port means the write never reached Codex, so this is a
          // retryable transport failure rather than an unknown write outcome.
          if (isCodexRpcUnavailable(error)) {
            request.attempted = false; request.status = 'retryable'; delete request.intent; save(value);
            throw fail(error.code, error.message, { retryableRead: true });
          }
          // A read-only failure before the write-ahead intent leaves nothing sent; a
          // failure after it is an unknown write and is never replayed. A first
          // dispatch whose thread/start may have left the page is also unknown.
          if (!request.intent) {
            // A read that never reached a write (thread/read, turns/list, a cold
            // resume) is local-pending: the same request id may be attempted again.
            // The root check also runs between those two reads and before onIntent;
            // its stale 'active' metadata is the same read gap when this attempt
            // wrote nothing and no earlier attempt left an intent behind.
            // Only a write that might have left but has no intent is unknown/failed.
            const retryableRead = error.retryableRead === true || isCodexReadRetryable(error)
              || (error.code === 'codex-root-turn-unconfirmed' && request.attempted !== true);
            if (retryableRead) {
              request.status = 'retryable'; request.attempted = false;
            } else if (request.attempted === true) {
              request.status = 'unknown';
            } else {
              request.status = 'failed';
            }
            save(value);
            throw fail(error.code ?? 'codex-delivery-unconfirmed', error.message,
              { ...(retryableRead ? { retryableRead: true } : { uncertain: true }) });
          }
          save(value);
          throw fail(error.code ?? 'codex-delivery-unconfirmed', error.message,
            { uncertain: true, ...(error.terminal ? { terminal: true } : {}) });
        }
      });
      if (waiting) return receiptFrom(state(), requestId);
      try { ({ value } = await refresh()); }
      catch (error) {
        // The native turn id already proved acceptance. A later read failure is
        // an observation gap, not a reason to downgrade that accepted write.
        if (request.status === 'accepted') return receiptFrom(state(), requestId);
        throw fail(error.code ?? 'codex-observation-pending', error.message, { uncertain: true });
      }
      return receiptFrom(state(), requestId);
    },
    async receipt({ requestId }) {
      const value = state();
      const request = value.requests[requestId];
      if (!request) return undefined;
      await reconcileRequest(value, request);
      return receiptFrom(state(), requestId);
    },
    /**
     * The root thread's own turn. It never includes a native descendant and never
     * invents a selection: when the root state cannot be read, the typed error is
     * `codex-root-turn-unconfirmed` rather than an idle answer.
     */
    async rootTurn() {
      const value = state();
      if (!value.binding) return { running: false, confirmed: true };
      if (typeof host.rootTurn !== 'function') {
        throw fail('codex-root-turn-unconfirmed', 'This Codex host cannot read the root turn; nothing was read.',
          { uncertain: true });
      }
      try {
        return await host.rootTurn({ nativeSessionId: value.binding.sessionId, requests: value.requests,
          startRequestIds: taskStartIds() });
      } catch (error) {
        if (error.code === 'codex-empty-rollout') {
          return { running: true, confirmed: false, reason: 'empty-rollout' };
        }
        throw fail('codex-root-turn-unconfirmed', error.message, { uncertain: true, cause: error.code });
      }
    },
    /**
     * Compare a caller's catalog selection with the root turn's actual wire
     * selection. The catalog id (preset-a) is resolved to the native slug (wire-a)
     * first; a catalog id is never compared with a wire slug. `status` is `same`,
     * `different`, `unknown` (no proof), or `idle` (no running root turn).
     */
    async matchRootSelection({ selection: wanted, turnId } = {}) {
      if (!wanted?.model) {
        throw fail('model-required', 'An explicit model selection requires a model id; nothing was compared.',
          { terminal: true });
      }
      let resolved;
      try {
        resolved = await host.resolveModelDelivery({ selection: wanted, workspace: load().workspace });
      } catch (error) {
        if (['model-required', 'model-not-found', 'effort-not-supported',
          'codex-model-catalog-empty'].includes(error?.code)) error.terminal = true;
        throw error;
      }
      const value = state();
      if (!value.binding) return { status: 'idle', running: false, resolved };
      if (typeof host.rootTurn !== 'function') {
        return { status: 'unknown', reason: 'root-turn-unsupported', resolved };
      }
      let root;
      try {
        root = await host.rootTurn({ nativeSessionId: value.binding.sessionId, requests: value.requests,
          startRequestIds: taskStartIds() });
      } catch (error) {
        return { status: 'unknown', reason: error.code ?? 'codex-root-turn-unconfirmed', resolved };
      }
      if (!root.running) return { status: 'idle', running: false, resolved };
      if (turnId && root.turnId !== turnId) {
        return { status: 'unknown', reason: 'turn-changed', running: true,
          ...(root.turnId ? { turnId: root.turnId } : {}), resolved };
      }
      const actual = root.wireSelection;
      if (!actual?.model) {
        return { status: 'unknown', reason: 'no-wire-selection', running: true,
          ...(root.turnId ? { turnId: root.turnId } : {}), resolved };
      }
      const status = actual.model !== resolved.model ? 'different'
        : resolved.effort === undefined ? 'same'
          : actual.reasoningEffort === undefined ? 'unknown'
            : actual.reasoningEffort === resolved.effort ? 'same' : 'different';
      return { status, running: true, ...(root.turnId ? { turnId: root.turnId } : {}),
        ...(root.selectionSource ? { source: root.selectionSource } : {}),
        resolved, actual: { ...actual } };
    },
    async turn({ requestId }) {
      const { value, tree } = await refresh(), p = projection(value), request = value.requests[requestId];
      const native = request?.turnId && p.turns[request.turnId];
      const correlation = request?.status === 'accepted' && request.turnId ? 'request-id' : undefined;
      if (request?.status !== 'accepted' || !native || tree.running || !tree.settled) return { state: 'running', correlation, turnId: request?.turnId };
      return { ...native, correlation, turnId: request.turnId };
    },
    async models() {
      // A sessionless name still needs a real catalog: status and explicit model
      // resolution both read here before any native thread exists. The catalog
      // carries the stable preset id plus supported/default reasoning efforts.
      return host.models({ workspace: load().workspace });
    },
    async model() {
      // model() reports the live thread selection. An unbound name has none yet;
      // returning undefined keeps native inheritance honest and never invents a
      // default from an unresolvable config.toml.
      const value = state();
      return value.binding ? host.readCurrentModel(value.binding.sessionId) : undefined;
    },
    async selectModel() {
      // Codex Desktop has no session-level model switch: an explicit selection is
      // applied by the next turn/start. Pretending to change the picker here would
      // disagree with the next real turn.
      throw fail('model-selection-unsupported',
        'Codex Desktop applies a model selection to an explicit turn. Wait for the current turn to end, then send the selection with the task.');
    },
    async cancel() {
      const { value, tree } = await refresh();
      if (!value.binding) return { cancelRequested: tree.settled };
      if (tree.settled) return { cancelRequested: true };
      const result = await locked(() => host.interrupt({ nativeSessionId: value.binding.sessionId, ownedNodeIds: ownedIds(value) }));
      return { cancelRequested: result.interrupted === true };
    },
    async destroy() {
      let value, tree;
      try { ({ value, tree } = await refresh()); }
      catch (error) {
        // The first dispatch was never found in any thread, so there is no native
        // session to clean. A retried delete of that name must finish.
        if (error.code === 'codex-first-dispatch-unconfirmed') return { destroyed: true };
        // A previous delete may have removed the thread before its verification
        // read; the global missing-thread mapping covers both native wordings.
        if (isCodexThreadMissing(error)) return { destroyed: true };
        throw error;
      }
      if (!value.binding) return { destroyed: true };
      if (!tree.settled) return { destroyed: false, message: 'The managed Codex tree has not settled.' };
      return locked(() => host.destroy({ nativeSessionId: value.binding.sessionId, ownedNodeIds: ownedIds(value), workspace: load().workspace }));
    },
    /**
     * Let the host drop this name's own threads once one round is fully over. The
     * thread set is this name's stored binding plus the tree that same binding was
     * observed with — never a name match, a thread list or a user's chat — and every
     * read is metadata-only, because the resume path would subscribe a cold thread
     * again. The answer is the three states the monitor records: `complete` only when
     * the app-server itself reports the threads unloaded, `waiting` while an accepted
     * request is still inside the idle grace, and `deferred` when nothing may be sent.
     * This runs beside a live dispatch instead of behind the shared host write lock: a
     * delivery queued behind a release would be worse than a narrow race. The round is
     * fenced instead: every attempt and every answer is patched with `{ taskId, ticket }`,
     * so an answer that arrives after the round moved on is dropped by the store rather
     * than overwriting the record, and an attempt whose fence is already gone is never
     * sent at all.
     */
    async releaseIdleThreads({ taskId, ticket, canRelease, signal } = {}) {
      if (typeof taskId !== 'string' || !taskId) return { state: 'deferred', reason: 'release-task-required' };
      if (!releasing) return { state: 'deferred', reason: 'release-disabled' };
      // A name the desktop is waiting on a human for is not idle: the card lives in the
      // thread's own turn, so releasing it would take the question with it.
      if (nativeCardsFor(state(), taskId).length) {
        return { state: 'deferred', reason: 'release-native-question-pending' };
      }
      // The stored task is the round this release belongs to. A name that already moved
      // on keeps the threads its new task is using.
      const movedOn = () => {
        const record = load(), value = state();
        const currentTaskId = record.task?.taskId ?? value.taskId;
        return typeof currentTaskId === 'string' && currentTaskId && currentTaskId !== taskId;
      };
      if (movedOn()) return { state: 'deferred', reason: 'release-task-changed' };
      const value = state(), record = load();
      const binding = value.binding;
      if (binding?.owned !== true || typeof binding.sessionId !== 'string') {
        return { state: 'deferred', reason: 'release-no-owned-binding' };
      }
      if (typeof host.releaseThreads !== 'function') return { state: 'deferred', reason: 'release-unsupported' };
      const fence = { taskId, ...(typeof ticket === 'string' && ticket ? { ticket } : {}) };
      // Ids and their recorded parent links only: the host needs the shape of this tree
      // to release children before the root and to refuse an unobserved child, and
      // nothing here may come from a name match or a thread list.
      const byId = new Map((value.tree?.nodes ?? []).filter(node => typeof node?.sessionId === 'string' && node.sessionId)
        .map(node => [node.sessionId, node]));
      const ownedNodes = [{ sessionId: binding.sessionId, parentSessionId: null },
        ...[...byId.keys()].filter(id => id !== binding.sessionId)
          .map(id => ({ sessionId: id, parentSessionId: byId.get(id)?.parentSessionId ?? null }))];
      // An earlier answer in this round is evidence, not a reason to stay silent.
      const prior = value.release?.taskId === taskId ? value.release : undefined;
      const submitted = Object.entries(prior?.nodes ?? {})
        .filter(([id, status]) => status === 'submitted' && ownedNodes.some(node => node.sessionId === id))
        .map(([id]) => id);
      const marks = () => {
        const stored = state().release;
        return stored?.taskId === taskId ? { ...(stored.nodes ?? {}) } : {};
      };
      const patch = (state, nodes) => ({ taskId, ...(fence.ticket === undefined ? {} : { ticket: fence.ticket }),
        state, at: new Date().toISOString(), nodes });
      const outcome = await host.releaseThreads({ nativeSessionId: binding.sessionId, ownedNodes,
        workspace: record.workspace, submitted, signal,
        // Evaluated synchronously at the moment of each request: the caller's
        // authorization and this round's identity both decide, not a state sampled
        // minutes ago. The transport checks the same callback once before it commits.
        canRelease: () => (typeof canRelease !== 'function' || canRelease() === true) && !movedOn(),
        // Durable and fenced before the request leaves: a refused patch means this round
        // is already superseded, so the host must not send for it. If the answer never
        // comes back, the next real dispatch still knows the thread may need restoring.
        onAttempt: id => writeRelease(patch('waiting', { ...marks(), [id]: 'sending' }), fence) });
      if (movedOn()) {
        // The round ended while the answer was in flight. Nothing is written for it: the
        // markers already on record are what let that next round resubscribe.
        return { state: 'deferred', reason: 'release-task-changed' };
      }
      const settled = ['complete', 'waiting', 'deferred'].includes(outcome?.state) ? outcome.state : 'deferred';
      // A late answer is patched only for its own round: when the fence is gone the store
      // drops it, and this round says so instead of pretending to own the record.
      if (!await writeRelease(patch(settled, { ...marks(), ...(outcome?.nodes ?? {}) }), fence)) {
        return { state: 'deferred', reason: 'release-fence-lost' };
      }
      return { state: settled, ...(typeof outcome?.reason === 'string' ? { reason: outcome.reason } : {}) };
    },
    async cursor() { return { throughSeq: projection((await refresh()).value).seq }; },
  };
}
