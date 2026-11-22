// The local expiry placeholder explicitly records that no native write occurred.
export function unsentExpiredAnswer(dispatch) {
  return dispatch?.kind === 'answer' && dispatch.expired === 'dispatch-expired'
    && dispatch.accepted === false && !dispatch.attempted
    && dispatch.error?.code === 'dispatch-expired'
    && dispatch.error?.message === 'This input expired after six hours without being sent. Its body is kept.';
}

// A verified cancellation seals only a specific native request proven not sent.
export function cancelledUnsentAnswer(task, dispatch, backend) {
  const id = dispatch?.requestId;
  if (!backend || typeof task?.taskId !== 'string' || !task.taskId
      || task.state !== 'cancelled' || task.cancelVerified !== true || task.cancelTreeSettled !== true
      || dispatch?.kind !== 'answer' || dispatch.state !== 'cancelled' || dispatch.accepted !== false
      || typeof id !== 'string' || !id || dispatch.attempted === true) return false;
  const request = backend.requests?.[id], session = backend.binding?.sessionId;
  const common = backend.binding?.owned === true && typeof session === 'string' && !!session
    && request?.requestId === id && request.taskId === task.taskId && request.kind === 'answer'
    && request.attempted === false && request.reschedule?.notSent === true
    && request.intent?.outcome === 'not-sent' && request.intent.threadId === session;
  if (!common) return false;
  if (request.status === 'retryable' && request.route === 'local-pending'
      && request.intent.method === 'turn/steer' && dispatch.deliveryIntent?.method === 'steer') {
    return typeof request.intent.expectedTurnId === 'string' && !!request.intent.expectedTurnId
      && request.intent.expectedTurnId === dispatch.deliveryIntent.expectedTurnId;
  }
  if (request.status === 'waiting' && request.route === 'after-current'
      && request.intent.method === 'turn/start' && dispatch.deliveryIntent?.method === 'start'
      && request.reschedule.reason === 'turn-started-before-write') {
    return typeof request.intent.priorTurnId === 'string' && !!request.intent.priorTurnId
      && typeof request.afterTurnId === 'string' && !!request.afterTurnId
      && request.reschedule.afterTurnId === request.afterTurnId;
  }
  return false;
}

// Resolve an answer from evidence for the same task and question/request. This is
// synchronous so roster transactions and cleanup inventory apply the same rule.
export function answerOutcome(task, answer, backend) {
  const questions = Array.isArray(answer.questionIds) ? answer.questionIds : [];
  const candidates = (task?.dispatches ?? []).filter(d => d.kind === 'answer' &&
    ((typeof answer.answerId === 'string' && !!answer.answerId && d.requestId === answer.answerId) || (questions.length > 0 &&
      (d.answerIds ?? []).some(id => questions.includes(id)))));
  const uncertain = d => !unsentExpiredAnswer(d) && (['sending','unknown','retrying','queued'].includes(d.state)
    || ['local-pending','after-current','answer-pending','unknown'].includes(d.delivery)
    || (d.attempted && !d.accepted && !d.rejected));
  if (candidates.some(d => uncertain(d) && !cancelledUnsentAnswer(task,d,backend))) return 'unknown';
  if (candidates.length && candidates.every(d => cancelledUnsentAnswer(task,d,backend))) return 'blocked';
  if (typeof answer.undelivered === 'string' && answer.undelivered) return 'blocked';
  if (answer.dispatched !== true) return 'unknown';
  if (answer.nativeAnswered === true) return 'accepted';
  // Older persisted dispatches may predate the route field. An explicit accepted
  // dispatch still proves the write, but an explicitly unknown route never does.
  return candidates.some(d => d.accepted === true &&
    (d.delivery == null || ['current-turn','new-turn','answered'].includes(d.delivery)))
    ? 'accepted' : 'unknown';
}
