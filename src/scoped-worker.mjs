// The single shared listener for every named subagent of this installation.
//
// Event path: file events on the DSH managed host directory, the Claude session
// registry and every managed session's transcript directory wake the loop, and
// the roster directory is used only as a hint. A hint is confirmed through
// RosterStore.dataVersion(), which does not move for this connection's own
// commits — so a poll that saves its own progress cannot wake itself into a hot
// loop. External commits and real host events still wake it immediately.
//
// Fallback cadence: one round each second while work remains, one round each
// second when quiet as well, so a missed file event costs at most a second.
//
// Exit: a real idle dwell (IDLE_EXIT_MS without work, without an external commit
// and without a sleeping or managed Claude name) releases the leases and ends the
// process. The loopback tool service lives in this process, so any open managed
// Claude session keeps it alive; a DSH-only installation still goes to zero
// background processes.
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createScopedAgents } from './scoped-agents.mjs';
import { backgroundBatch, pollSleeping, scanSleeping } from './idle-monitor.mjs';
import { createDirectoryWatchers, monitorDirectories, MONITOR_LEASE, MONITOR_READY_LEASE } from './shared-monitor.mjs';
import { closeReportService, ensureReportService, reportPort, rosterIdentity } from './report-endpoint.mjs';

const MIN_ROUND_MS = 250;      // never poll faster than this
const IDLE_WAIT_MS = 1000;     // cadence for a quiet installation
const IDLE_EXIT_MS = 30000;    // real idle dwell before the process ends

const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) pairs.push([value, all[index + 1]]);
  return pairs;
}, []));
if (!values['--config'] || !/^monitor-[0-9a-f-]{36}$/.test(values['--lease'] ?? '')) throw new Error('Invalid shared monitor identity.');
const config = await loadConfig(values['--config']);
const hostDirectory = config.managedStateDirectory ?? path.join(path.dirname(config.hostBridgeFile), 'managed-host');
const service = createScopedAgents(config), store = service.store, holder = values['--lease'];

let wake, heartbeat, running = true, signalled = false, lastDelivery = 0;
let idleSince, lastVersion = store.dataVersion(), rounds = 0;
// Measurement aid only: FUTUREAIDE_MONITOR_TRACE=1 prints one line per round so a
// test or a manual run can count rounds without reading the database.
const trace = process.env.FUTUREAIDE_MONITOR_TRACE === '1'
  ? message => process.stderr.write(`[futureaide-monitor] ${message}\n`) : () => {};
const failures = new Map();
const ownsLease = () => { const lease = store.lease(MONITOR_LEASE); return running && lease?.holder === holder && lease.expires > Date.now(); };
const deliveries = backgroundBatch(() => pollSleeping(store, agentId => service.poll(agentId),
  (agentId, taskId) => service.wake(agentId, taskId), ownsLease), signal);
function signal() { if (wake) wake(); else signalled = true; }

// fs.watch accepts a single path, so every watched directory owns one watcher.
const watchers = createDirectoryWatchers(signal);
function attach(directories) { return watchers.update(directories); }

function sleepUntilSignalled(timeoutMs) {
  if (timeoutMs <= 0) { signalled = false; return Promise.resolve(); }
  return new Promise(resolve => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, timeoutMs);
    wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
  });
}

/** Open managed Claude names — including an idle zero-model reservation — keep this
 *  process (and therefore its tool service) alive. */
const hasManagedClaude = () => store.hasOpenTarget('claude-desktop');

try {
  // The loopback tool service is hosted here (config.reportPort, then
  // FUTUREAIDE_REPORT_PORT, then the default) so an idle managed session always
  // finds it; DSH work alone does not need it. A service answering for another
  // roster is reported and never reused.
  const reports = await ensureReportService({ store, port: reportPort(config), log: message => trace(`report: ${message}`) });
  if (reports.ready !== true) {
    trace(`tool service not ready: ${reports.reason?.code ?? 'unknown'} roster=${rosterIdentity(store).slice(0, 12)}`);
    process.stderr.write(`[futureaide-monitor] tool service not ready: ${reports.reason?.code ?? 'unknown'}\n`);
  }
  // A killed predecessor leaves a readiness lease behind; it cannot belong to any
  // running listener once this process owns the holder lease.
  const staleReady = store.lease(MONITOR_READY_LEASE);
  if (staleReady && staleReady.holder !== holder && store.lease(MONITOR_LEASE)?.holder !== staleReady.holder) {
    store.releaseLease(MONITOR_READY_LEASE, staleReady.holder);
  }
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
    const roundStarted = Date.now();
    attach(monitorDirectories(config, { bindings: store.listClaudeBindings().map(binding => binding.transcriptFile) }));
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
    const version = store.dataVersion();
    const external = version !== lastVersion;
    lastVersion = version;
    if (running && Date.now() - lastDelivery >= 30000) {
      lastDelivery = Date.now();
      deliveries.start();
    }
    if (busy || external) idleSince = undefined;
    else idleSince ??= Date.now();
    rounds += 1;
    trace(`round=${rounds} busy=${busy} external=${external} idleMs=${idleSince === undefined ? 0 : Date.now() - idleSince} watched=${watchers.size}`);
    const quiet = !busy && !external && !store.hasSleeping() && !hasManagedClaude();
    if (quiet && Date.now() - idleSince >= IDLE_EXIT_MS) {
      store.releaseLease(MONITOR_READY_LEASE, holder);
      const stillQuiet = !store.hasSleeping() && !hasManagedClaude() && store.dataVersion() === lastVersion;
      if (stillQuiet) break;
      if (!store.claimLease(MONITOR_READY_LEASE, holder, 60000)) break;
      idleSince = Date.now();
    }
    // A self-write can only arrive as a hint; it never shortens the round floor.
    const floor = Math.max(0, MIN_ROUND_MS - (Date.now() - roundStarted));
    await sleepUntilSignalled(Math.max(floor, external ? 0 : IDLE_WAIT_MS));
  }
} finally {
  await deliveries.drain();
  clearInterval(heartbeat);
  watchers.close();
  await closeReportService();
  store.releaseLease(MONITOR_READY_LEASE, holder);
  store.releaseLease(MONITOR_LEASE, holder);
  service.close();
}
