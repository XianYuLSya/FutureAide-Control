import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.mjs';
import { createCliAgents } from './cli-agents.mjs';

const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const ACTIVE = new Set(['creating', 'running', 'reconnecting', 'closing']);

function parseArguments(argv) {
  const values = Object.fromEntries(argv.reduce((pairs, value, index, all) => {
    if (index % 2 === 0) pairs.push([value, all[index + 1]]);
    return pairs;
  }, []));
  if (!/^agent-[a-f0-9]{32}$/.test(values['--agent'] ?? '')) throw new Error('Invalid CLI-agent worker identity.');
  if (!/^worker-[a-f0-9]{32}$/.test(values['--lease'] ?? '')) throw new Error('Invalid CLI-agent worker lease.');
  if (!values['--config']) throw new Error('Invalid CLI-agent worker configuration.');
  return values;
}

/** True while a worker should remain available for queued input, an answer, or a report. */
export function workerActive(record, store) {
  if (!record || record.closed || !record.task) return false;
  if (ACTIVE.has(record.state)) return true;
  const queued = store.supplements(record.agentId)
    .some(item => item.task === record.task?.taskId && ['queued', 'sending', 'unknown'].includes(item.status));
  const answers = (record.task?.answers ?? []).some(answer => !answer.dispatched);
  if (record.owner?.client === 'claude-code' && ['awaiting_input', 'awaiting_report', 'delivery_pending'].includes(record.state)) return queued || answers;
  const reports = (record.task?.reports ?? []).some(report => !['delivered', 'blocked'].includes(report.delivery?.state));
  const questions = (record.task?.questions ?? []).some(question => question.state === 'pending'
    && !['delivered', 'blocked'].includes(question.noticeState));
  if (record.state === 'awaiting_input') return queued || answers || reports || questions;
  if (record.state === 'awaiting_report') return queued || answers || reports || (record.task?.finalSubmitted === true && !record.task.result);
  if (record.state === 'awaiting_descendants') {
    // Keep a worker alive even after the last child settles: its next poll must
    // be able to call finishTask. Otherwise a parent with a delivered final can
    // be stranded in awaiting_descendants with no worker left to observe it.
    return true;
  }
  if (record.state === 'delivery_pending') return reports;
  return false;
}

/**
 * One dedicated worker per active CLI agent. The worker owns a lease and calls
 * service.poll until the agent has no runnable/queued work.
 */
export async function runWorker({ service, agentId, lease, pollMs = 500, maxMinutes = 0 }) {
  let owned = service.store.renewLease(`worker:${agentId}`, lease, 60000);
  const heartbeat = setInterval(() => {
    owned = service.store.renewLease(`worker:${agentId}`, lease, 60000);
  }, 10000);
  heartbeat.unref();
  const deadline = maxMinutes > 0 ? Date.now() + maxMinutes * 60000 : 0;
  try {
    while (owned) {
      const record = service.store.get(agentId);
      if (!workerActive(record, service.store)) break;
      try {
        await service.poll(agentId);
      } catch {
        // Durable state remains the source of truth. A later poll can recover.
      }
      const current = service.store.get(agentId);
      if (!workerActive(current, service.store)) break;
      if (deadline && Date.now() >= deadline) break;
      const delay = current?.state === 'delivery_pending' ? Math.max(5000, pollMs) : pollMs;
      await wait(Math.max(50, Math.min(delay, 5000)));
    }
  } finally {
    clearInterval(heartbeat);
    service.store.releaseLease(`worker:${agentId}`, lease);
    try { service.store.setWorker(agentId, null); } catch { /* The record may have retired. */ }
    try { await service.resume(agentId); } catch { /* A sender can add work during this worker's exit. */ }
    service.close();
  }
}

async function main() {
  const values = parseArguments(process.argv.slice(2));
  const config = await loadConfig(values['--config']);
  const service = createCliAgents(config);
  await runWorker({ service, agentId: values['--agent'], lease: values['--lease'],
    pollMs: Number(values['--poll']) || 500, maxMinutes: Number(values['--max-minutes']) || 0 });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch(error => {
    process.stderr.write(`cli-agent-worker: ${String(error?.message ?? error)}\n`);
    process.exitCode = 1;
  });
}
