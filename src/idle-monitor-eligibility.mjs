/** Sleeping is allowed only after a verified quiet tree and a fully consumed outbox. */
export function canSleep(record, queued, treeSettled) {
  const task = record.task;
  const view = record.observation;
  if (!['awaiting_report', 'awaiting_input', 'delivery_pending', 'failed', 'cancelled'].includes(record.state)
      || record.closed || !task || !view || view.stale || view.running === true || !treeSettled(record, view)) return false;
  if ((task.cancelRequested && !(task.cancelVerified && task.cancelTreeSettled)) || (task.answers ?? []).some(answer => !answer.dispatched)) return false;
  if ((view.reports ?? []).some(report => !(task.reports ?? []).some(saved => saved.id === report.id))) return false;
  if ((task.dispatches ?? []).some(dispatch => !['completed', 'cancelled', 'failed', 'blocked'].includes(dispatch.state))) return false;
  if (queued.some(item => item.task === task.taskId && item.status !== 'blocked')) return false;
  if (['failed', 'cancelled'].includes(record.state) && !hasPendingDelivery(record)) return false;
  return true;
}

export function hasPendingDelivery(record) {
  if (record.callbackBlocked) return false;
  const task = record.task;
  if ((task?.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery?.state))) return true;
  return (record.observation?.questions ?? []).some(question => question.state === 'pending'
    && !['delivered', 'blocked'].includes(task?.questionNotices?.[question.id]?.state));
}
