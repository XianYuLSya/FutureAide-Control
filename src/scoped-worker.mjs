// The single shared listener for every named subagent of this installation.
//
// Event path: file events on the roster database directory and on the DSH managed
// host directory (session state, queued notices) wake the loop immediately; the
// loop then polls every agent that still owes work through the one scoped state
// machine (service.monitorScan / poll / wake).
//
// Fallback: SQLite write-ahead-log traffic and native hosts do not always emit a
// file event, so each round also waits on a bounded timer — one second while work
// remains, five seconds when everything is quiet. Nothing is polled by a second
// process: the roster lock and the per-agent operation lock arbitrate.
//
// Exit: after three quiet rounds with no sleeping agent the leases are released
// and the process ends, so an idle plugin keeps zero background processes.
//
// This process never hosts the loopback tool service that managed sessions report
// through (hostReportService: false): that service must outlive a task, so the
// plugin's long-lived process owns it and this monitor only reads readiness.
import { watch } from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createScopedAgents } from './scoped-agents.mjs';
import { backgroundBatch, pollSleeping, scanSleeping } from './idle-monitor.mjs';
import { MONITOR_LEASE, MONITOR_READY_LEASE } from './shared-monitor.mjs';

const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) pairs.push([value, all[index + 1]]);
  return pairs;
}, []));
if (!values['--config'] || !/^monitor-[0-9a-f-]{36}$/.test(values['--lease'] ?? '')) throw new Error('Invalid shared monitor identity.');
const config = await loadConfig(values['--config']);
const hostDirectory = config.managedStateDirectory ?? path.join(path.dirname(config.hostBridgeFile), 'managed-host');
const rosterDirectory = config.stateDirectory;
const service = createScopedAgents(config, { hostReportService: false }), store = service.store, holder = values['--lease'];

let watcher, wake, heartbeat, running = true, signalled = false, idleRounds = 0, lastDelivery = 0;
const failures = new Map();
const ownsLease = () => { const lease = store.lease(MONITOR_LEASE); return running && lease?.holder === holder && lease.expires > Date.now(); };
const deliveries = backgroundBatch(() => pollSleeping(store, agentId => service.poll(agentId),
  (agentId, taskId) => service.wake(agentId, taskId), ownsLease), signal);
function signal() { if (wake) wake(); else signalled = true; }

function attach() {
  if (watcher) return;
  // One watcher per interesting directory: the roster database (its WAL file
  // carries every state change) and the DSH managed host state.
  const targets = [rosterDirectory, hostDirectory].filter(Boolean);
  try { watcher = watch(targets.length === 1 ? targets[0] : targets, signal); }
  catch {
    try { watcher = watch(targets[0], signal); }
    catch { watcher = undefined; }
  }
  watcher?.on('error', () => { watcher?.close(); watcher = undefined; signal(); });
}

function sleepUntilSignalled(timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, timeoutMs);
    wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
  });
}

try {
  attach();
  if (!store.claimLease(MONITOR_READY_LEASE, holder, 60000)) throw new Error('Monitor readiness lease is occupied.');
  heartbeat = setInterval(() => {
    if (!store.renewLease(MONITOR_LEASE, holder, 60000) || !store.renewLease(MONITOR_READY_LEASE, holder, 60000)) {
      running = false;
      signal();
    }
  }, 15000);
  heartbeat.unref();
  while (running && store.renewLease(MONITOR_LEASE, holder, 60000)) {
    if (!store.renewLease(MONITOR_READY_LEASE, holder, 60000)) break;
    attach();
    // Sleeping agents keep their existing DSH host-state path unchanged.
    await scanSleeping(store, hostDirectory, (agentId, taskId) => {
      const current = store.lease(MONITOR_LEASE);
      if (current?.holder !== holder || current.expires <= Date.now()) { running = false; return false; }
      return service.wake(agentId, taskId);
    }, failures);
    // Every non-sleeping agent that still owes work is polled by this one process.
    let busy = false;
    try { busy = await service.monitorScan(); }
    catch { busy = true; } // Keep the monitor alive; the next round retries from durable state.
    idleRounds = busy ? 0 : idleRounds + 1;
    if (running && Date.now() - lastDelivery >= 30000) {
      lastDelivery = Date.now();
      deliveries.start();
    }
    if (!busy && idleRounds >= 3 && !store.hasSleeping()) {
      store.releaseLease(MONITOR_READY_LEASE, holder);
      if (!store.hasSleeping()) break;
      if (!store.claimLease(MONITOR_READY_LEASE, holder, 60000)) break;
    }
    if (signalled) { signalled = false; continue; }
    await sleepUntilSignalled(busy ? 1000 : 5000);
  }
} finally {
  await deliveries.drain();
  clearInterval(heartbeat);
  watcher?.close();
  store.releaseLease(MONITOR_READY_LEASE, holder);
  store.releaseLease(MONITOR_LEASE, holder);
  service.close();
}
