import { loadConfig } from './config.mjs';
import { createScopedAgents } from './scoped-agents.mjs';

const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) pairs.push([value, all[index + 1]]);
  return pairs;
}, []));
const agentId = values['--agent'];
if (!/^agent-[a-f\d]{32}$/.test(agentId ?? '') || !values['--config']) throw new Error('Invalid internal recovery-worker arguments.');
const service = createScopedAgents(await loadConfig(values['--config']));
const lease = values['--lease'];
if (!/^worker-[a-f\d]{32}$/.test(lease ?? '')) throw new Error('Invalid recovery-worker lease.');
const stopped = record => !record || (['idle', 'failed', 'cancelled', 'cleanup_failed', 'supplement_blocked'].includes(record.state)
  && !service.store.supplements(record.agentId).some(item => item.task === record.task?.taskId && item.status !== 'blocked')
  && (record.callbackBlocked || !(record.task?.reports ?? []).some(report => report.delivery.state !== 'delivered' && report.delivery.state !== 'blocked')));
let owned = service.store.renewLease(`worker:${agentId}`, lease, 60000);
const heartbeat = setInterval(() => { owned = service.store.renewLease(`worker:${agentId}`, lease, 60000); }, 10000);
heartbeat.unref();
try {
  while (owned) {
    const record = service.store.get(agentId);
    if (stopped(record)) break;
    try { await service.poll(agentId); } catch { /* Another call owns this short operation; retry from durable state. */ }
    const current = service.store.get(agentId);
    if (stopped(current)) break;
    await new Promise(resolve => setTimeout(resolve, current.state === 'reconnecting' || current.state === 'delivery_pending' || current.state === 'awaiting_report' ? 5000 : 1000));
  }
} finally {
  clearInterval(heartbeat);
  service.store.releaseLease(`worker:${agentId}`, lease);
  // A new task can arrive between the idle check and this release. Recheck after
  // releasing, so that task either owns a new lease already or starts its worker.
  await service.resume();
  service.close();
}
