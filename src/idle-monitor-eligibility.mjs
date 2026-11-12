/** Sleeping is allowed only after a verified quiet tree and a fully consumed outbox. */
export function canSleep(record, queued, treeSettled) {
  const task = record.task;
  const view = record.observation;
  if (!['awaiting_report', 'awaiting_input', 'delivery_pending', 'failed', 'cancelled'].includes(record.state)
      || record.closed || !task || !view || view.stale || view.running === true || !treeSettled(record, view)) return false;
  // A delivered one-shot can be waiting to clean up until a child settles its callback.
  // The next sweep must revisit it even if the child's delivery produces no wake hint.
  if (record.lifetime === 'once' && record.state === 'delivery_pending' && task.state === 'completed'
      && (task.reports ?? []).some(report => report.final && report.delivery?.state === 'delivered')) return false;
  if ((task.cancelRequested && !(task.cancelVerified && task.cancelTreeSettled)) || (task.answers ?? []).some(answer => !answer.dispatched)) return false;
  if ((view.reports ?? []).some(report => !(task.reports ?? []).some(saved => saved.id === report.id))) return false;
  // A best-effort reminder never keeps a settled task awake: an undecided or failed
  // one is not work the task still owes, exactly as the poll loop treats it.
  if ((task.dispatches ?? []).some(dispatch => !['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)
    && !(dispatch.reminder && ['unknown', 'failed'].includes(dispatch.state)))) return false;
  if (queued.some(item => item.task === task.taskId && item.status !== 'blocked')) return false;
  if (['failed', 'cancelled'].includes(record.state) && !hasPendingDelivery(record)) return false;
  // A written notice whose receipt has not been read back yet keeps this name awake:
  // the receipt lands in the transcript milliseconds after the write, so the ordinary
  // round settles it instead of waiting for the 30-second delivery batch. After five
  // attempts the notice's own backoff has reached 30 seconds, which makes the batch
  // exactly as fast as polling, so the name may sleep again instead of polling forever.
  if (awaitingReceipt(record)) return false;
  return true;
}

/**
 * A notice that was written but is not yet proven delivered. Reading it back is one
 * local transcript read, so a name may keep doing that every round for a few tries.
 */
export function awaitingReceipt(record) {
  const unread = notice => notice && ['unknown', 'sending'].includes(notice.state)
    && (notice.attempts ?? 0) < 5;
  if ((record.task?.reports ?? []).some(report => unread(report.delivery))) return true;
  // Only a question that is still pending gets a notice written for it, so an answered
  // question's notice can never settle: counting it would keep this name awake for the
  // rest of the task on one stale receipt.
  return (record.observation?.questions ?? []).some(question => question.state === 'pending'
    && unread(record.task?.questionNotices?.[question.id]));
}

// A release that came back waiting or deferred is asked again at this spacing,
// and only while the name still holds the same task: a new dispatch is a new round.
export const RELEASE_RECHECK_MS = 60000;
// Past the first attempts a refusal is still not a failure — a thread somebody is
// reading is refused for as long as it is read — so the spacing widens instead of the
// schedule ending.
export const RELEASE_LONG_RECHECK_MS = 300000;
// Kept for the first attempts' spacing; a release is never abandoned after them.
export const RELEASE_ATTEMPT_CAP = 5;
// Answers that cannot change by waiting: a round that moved on, a name with no owned
// thread, a root that is gone or foreign, a node that is no longer ours.
export const PERMANENT_RELEASE_REASONS = new Set(['release-task-required', 'release-task-changed',
  'release-no-owned-binding', 'release-unsupported', 'release-no-root', 'release-tree-too-large',
  'release-root-missing', 'release-root-foreign-workspace', 'release-node-not-descendant']);

/**
 * How long to wait before asking the target again, or undefined when it must not be
 * asked again at all. A guard, a live turn and an unfinished idle grace all clear
 * themselves, so those keep a schedule; only a final answer ends it.
 * @param {number} [attempts] Attempts already made for this round.
 * @param {string|object} [reason] The target's reason, or a transport error.
 * @returns {number|undefined} Delay in milliseconds.
 */
export function releaseRetryDelay(attempts, reason, { quick = RELEASE_RECHECK_MS, slow = RELEASE_LONG_RECHECK_MS } = {}) {
  const code = typeof reason === 'string' ? reason : reason?.code;
  if (typeof code === 'string' && PERMANENT_RELEASE_REASONS.has(code)) return undefined;
  return (attempts ?? 0) <= RELEASE_ATTEMPT_CAP ? quick : slow;
}

/**
 * Whether one managed Codex name has finished a round and owes nothing else, so the
 * threads this plugin created for it may be released. Only the last recorded
 * observation is read here: the release itself is the target's read-only check, and a
 * read that would resume a cold thread must never be what decides this.
 * @param {object} record Live roster record.
 * @param {Array<object>} queued Supplements for this name.
 * @param {boolean} [settled] treeSettled() result. Undefined means the last observation
 *   is stale or missing, which only a failed or verified-cancelled task may survive.
 * @returns {boolean} True when asking the target to release is allowed now.
 */
export function canReleaseThreads(record, queued = [], settled) {
  // One target only: every other target keeps its current behaviour, and the switch
  // outside this gate is what restores it entirely.
  if (record?.target !== 'codex-desktop') return false;
  if (!['persistent', 'once'].includes(record.lifetime)) return false;
  const task = record.task;
  if (!task || record.closed) return false;
  if (!['idle', 'failed', 'cancelled'].includes(record.state)) return false;
  if (!['completed', 'failed', 'cancelled'].includes(task.state)) return false;
  // A delivered one-shot is ordinarily deleted. If cleanup retained blocked callback
  // bodies in the tree, the record can stay listed while its thread is released.
  const deliveredFinal = (task.reports ?? []).some(report => report.final && report.delivery?.state === 'delivered');
  if (record.lifetime === 'once' && task.state === 'completed' && deliveredFinal && !task.autoCleanupHeld) return false;
  // A cancellation counts only once the target confirmed the tree came to rest;
  // before that a turn of its own may still be running.
  if (task.state === 'cancelled' && !(task.cancelVerified && task.cancelTreeSettled)) return false;
  // Every notice the helper wrote must be finished. A non-final report still being
  // retried is work this round still owes, and a final one that never landed is
  // exactly why the task did not complete.
  if ((task.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery?.state))) return false;
  // An answer the caller gave but the helper has not received yet is work in flight.
  if ((task.answers ?? []).some(answer => !answer.dispatched && !answer.undelivered)) return false;
  // A best-effort reminder never decides how a round ends, exactly as the poll loop
  // treats it; every other undecided dispatch is still on its way. Once a final report
  // sealed the round the dispatch keeps whatever state it had when the helper reported,
  // because the report — not the turn — decided how that round ended.
  const sealedByReport = (task.reports ?? []).some(report => report.final && report.treeSettledConfirmed);
  if (!sealedByReport && (task.dispatches ?? []).some(dispatch => !['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state)
    && !(dispatch.reminder && ['unknown', 'failed'].includes(dispatch.state)))) return false;
  // A queued supplement is work the caller already assigned for this task.
  if (queued.some(item => item.task === task.taskId && item.status !== 'blocked')) return false;
  if ((record.observation?.questions ?? []).some(question => question.state === 'pending')) return false;
  if (settled === false) return false;
  // A completed round proved a settled tree when it ended. Only a failure or a
  // verified cancellation may fall back on the target's own read, because the read
  // that would have shown that tree is what failed.
  if (settled === undefined && task.state === 'completed') return false;
  return true;
}

/**
 * Is another release attempt due for this task? A new task always re-arms; a proven
 * release never repeats; a waiting or deferred one is re-asked at a fixed spacing
 * and only a bounded number of times.
 * @param {object} [release] Saved release state on the record.
 * @param {string} [taskId] The task the release would be for.
 * @param {number} [now] Clock, for tests.
 * @returns {boolean} True when the target should be asked now.
 */
export function releaseDue(release, taskId, now = Date.now()) {
  if (typeof taskId !== 'string' || !taskId) return false;
  if (release?.taskId !== taskId) return true;
  if (release.state === 'complete') return false;
  // A release is never abandoned after the first attempts: their spacing widens instead,
  // because a thread somebody is reading is refused for as long as it is read.
  return (release.nextCheckAt ?? 0) <= now;
}

export function hasPendingDelivery(record) {
  if (record.callbackBlocked) return false;
  const task = record.task;
  if ((task?.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery?.state))) return true;
  return (record.observation?.questions ?? []).some(question => question.state === 'pending'
    && !['delivered', 'blocked'].includes(task?.questionNotices?.[question.id]?.state));
}
