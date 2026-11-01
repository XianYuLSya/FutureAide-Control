import { watch } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createScopedAgents } from './scoped-agents.mjs';
import { backgroundBatch, pollSleeping, scanSleeping } from './idle-monitor.mjs';

const args = Object.fromEntries(process.argv.slice(2).reduce((out, item, index, all) => {
  if (index % 2 === 0) out.push([item, all[index + 1]]);
  return out;
}, []));
if (!args['--config'] || !/^monitor-[0-9a-f-]{36}$/.test(args['--lease'] ?? '')) throw new Error('Invalid idle monitor identity.');
const config = await loadConfig(args['--config']);
const directory = config.managedStateDirectory ?? path.join(path.dirname(config.hostBridgeFile), 'managed-host');
const service = createScopedAgents(config), store = service.store, holder = args['--lease'];
let watcher, wake, heartbeat, running = true, lastPoll = 0, signalled = false;
const start = Date.now(), failures = new Map();
function signal() { if (wake) wake(); else signalled = true; }
const ownsLease = () => { const lease = store.lease('idle-monitor'); return running && lease?.holder === holder && lease.expires > Date.now(); };
const deliveries = backgroundBatch(() => pollSleeping(store, agentId => service.poll(agentId),
  (agentId, taskId) => service.wake(agentId, taskId), ownsLease), signal);
function attach() {
  if (watcher) return;
  try {
    watcher = watch(directory, signal);
    watcher.on('error', () => { watcher?.close(); watcher = undefined; signal(); });
  } catch { watcher = undefined; }
}
try {
  attach();
  if (!watcher) throw new Error('Managed host directory cannot be watched.');
  if (!store.claimLease('idle-monitor:ready', holder, 60000)) throw new Error('Monitor readiness lease is occupied.');
  heartbeat = setInterval(() => {
    if (!store.renewLease('idle-monitor', holder, 60000) || !store.renewLease('idle-monitor:ready', holder, 60000)) { running = false; signal(); }
  }, 15000);
  while (running && store.renewLease('idle-monitor', holder, 60000)) {
    if (!store.renewLease('idle-monitor:ready', holder, 60000)) break;
    attach();
    await scanSleeping(store, directory, (agentId, taskId) => {
      const current = store.lease('idle-monitor');
      if (current?.holder !== holder || current.expires <= Date.now()) { running = false; return false; }
      return service.wake(agentId, taskId);
    }, failures);
    if (running && Date.now() - lastPoll >= 30000) {
      lastPoll = Date.now();
      deliveries.start();
    }
    if (Date.now() - start > 35000 && !store.hasSleeping()) {
      store.releaseLease('idle-monitor:ready', holder);
      if (!store.hasSleeping()) break;
      if (!store.claimLease('idle-monitor:ready', holder, 60000)) break;
    }
    if (signalled) { signalled = false; continue; }
    await new Promise(resolve => { const timer = setTimeout(() => { wake = undefined; resolve(); }, 30000); wake = () => { clearTimeout(timer); wake = undefined; resolve(); }; });
  }
} finally {
  await deliveries.drain();
  clearInterval(heartbeat);
  watcher?.close();
  store.releaseLease('idle-monitor:ready', holder);
  store.releaseLease('idle-monitor', holder);
  service.close();
}
