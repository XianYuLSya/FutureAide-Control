import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { hasPendingDelivery } from './idle-monitor-eligibility.mjs';

export function idleSignal(value) {
  return JSON.stringify([value.taskId ?? null, value.throughSeq ?? -1,
    (value.questions ?? []).map(item => [item.id, item.state]),
    (value.reports ?? []).map(item => [item.id, item.final])]);
}

export async function scanSleeping(store, directory, wake, failures = new Map()) {
  const sleeping = typeof store.listSleeping === 'function'
    ? store.listSleeping()
    : store.list().filter(item => item.sleep);
  for (const record of sleeping) {
    const queued = record.hasSupplement ?? store.supplements(record.agentId)
      .some(item => item.task === record.sleep.taskId && item.status !== 'blocked');
    if (record.sleep.wakePending || record.task?.taskId !== record.sleep.taskId || record.sessionId !== record.sleep.sessionId
        || !['awaiting_report', 'awaiting_input', 'delivery_pending', 'failed', 'cancelled'].includes(record.state)
        || (record.task?.cancelRequested && !(record.task.cancelVerified && record.task.cancelTreeSettled))
        || queued) {
      await wake(record.agentId, record.sleep.taskId);
      continue;
    }
    const key = createHash('sha256').update(`${record.ownerId}\n${record.agentId}`).digest('hex');
    try {
      const state = JSON.parse(await readFile(path.join(directory, `${key}.json`), 'utf8'));
      if (state.ownerId !== record.ownerId || state.agentId !== record.agentId || state.sessionId !== record.sleep.sessionId
          || state.taskId !== record.sleep.taskId) continue;
      failures.delete(record.agentId);
      if (idleSignal(state) !== record.sleep.signal) await wake(record.agentId, record.sleep.taskId);
    } catch {
      // A host write can be partial; preserve the baseline. Repeated unreadable
      // state falls back to the ordinary worker instead of sleeping forever.
      const since = failures.get(record.agentId) ?? Date.now();
      failures.set(record.agentId, since);
      if (Date.now() - since >= 30000) { failures.delete(record.agentId); await wake(record.agentId, record.sleep.taskId); }
    }
  }
}

/** Retry existing durable deliveries under the same per-agent lock, with bounded concurrency. */
export async function pollSleeping(store, poll, wake, ownsLease, concurrency = 2) {
  const pending = typeof store.listPendingDeliveries === 'function'
    ? store.listPendingDeliveries()
    : store.list().filter(record => record.sleep && hasPendingDelivery(record));
  let next = 0;
  async function run() {
    while (next < pending.length && ownsLease()) {
      const record = pending[next++], taskId = record.taskId ?? record.sleep?.taskId;
      try { await poll(record.agentId); } catch { /* The next shared scan retries. */ }
      const current = store.get(record.agentId);
      if (current?.sleep && (current.task?.taskId !== taskId
          || !['awaiting_report', 'awaiting_input', 'delivery_pending', 'failed', 'cancelled'].includes(current.state)
          || current.observation?.tree?.running === true || current.observation?.tree?.settled !== true
          || store.supplements(current.agentId).some(item => item.task === current.task?.taskId && item.status !== 'blocked'))) {
        if (ownsLease()) await wake(current.agentId, current.sleep.taskId);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, run));
}

/** Keep slow delivery work separate from the file-event scan loop. */
export function backgroundBatch(run, notify) {
  let active;
  return {
    start() {
      if (active) return false;
      active = Promise.resolve().then(run).catch(() => {}).finally(() => { active = undefined; notify(); });
      return true;
    },
    async drain() { await active; },
  };
}
