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
let owned = service.store.renewLease(`worker:${agentId}`, lease, 60000);
const heartbeat = setInterval(() => { owned = service.store.renewLease(`worker:${agentId}`, lease, 60000); }, 10000);
heartbeat.unref();
try {
  while (owned) {
    const record = service.store.get(agentId);
    if (!record || ['idle', 'failed', 'cleanup_failed'].includes(record.state)) break;
    try { await service.poll(agentId); } catch { /* Another call owns this short operation; retry from durable state. */ }
    const current = service.store.get(agentId);
    if (!current || ['idle', 'failed', 'cleanup_failed'].includes(current.state)) break;
    await new Promise(resolve => setTimeout(resolve, current.state === 'reconnecting' || current.state === 'delivery_pending' ? 5000 : 1000));
  }
} finally {
  clearInterval(heartbeat);
  service.store.releaseLease(`worker:${agentId}`, lease);
  // A new task can arrive between the idle check and this release. Recheck after
  // releasing, so that task either owns a new lease already or starts its worker.
  await service.resume();
  service.close();
}
