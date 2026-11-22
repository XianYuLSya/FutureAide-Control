// The local expiry placeholder explicitly records that no native write occurred.
export function unsentExpiredAnswer(dispatch) {
  return dispatch?.kind === 'answer' && dispatch.expired === 'dispatch-expired'
    && dispatch.accepted === false && !dispatch.attempted
    && dispatch.error?.code === 'dispatch-expired'
    && dispatch.error?.message === 'This input expired after six hours without being sent. Its body is kept.';
}

// Resolve an answer from evidence for the same task and question/request. This is
// synchronous so roster transactions and cleanup inventory apply the same rule.
export function answerOutcome(task, answer) {
  const questions = Array.isArray(answer.questionIds) ? answer.questionIds : [];
  const candidates = (task?.dispatches ?? []).filter(d => d.kind === 'answer' &&
    ((typeof answer.answerId === 'string' && !!answer.answerId && d.requestId === answer.answerId) || (questions.length > 0 &&
      (d.answerIds ?? []).some(id => questions.includes(id)))));
  const uncertain = d => !unsentExpiredAnswer(d) && (['sending','unknown','retrying','queued'].includes(d.state)
    || ['local-pending','after-current','answer-pending','unknown'].includes(d.delivery)
    || (d.attempted && !d.accepted && !d.rejected));
  if (candidates.some(uncertain)) return 'unknown';
  if (typeof answer.undelivered === 'string' && answer.undelivered) return 'blocked';
  if (answer.dispatched !== true) return 'unknown';
  if (answer.nativeAnswered === true) return 'accepted';
  // Older persisted dispatches may predate the route field. An explicit accepted
  // dispatch still proves the write, but an explicitly unknown route never does.
  return candidates.some(d => d.accepted === true &&
    (d.delivery == null || ['current-turn','new-turn','answered'].includes(d.delivery)))
    ? 'accepted' : 'unknown';
}
