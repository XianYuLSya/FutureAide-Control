// The single shared listener for every named subagent of this installation.
//
// Event path: file events on the DSH managed host directory and on the Claude
// session registry wake the loop. The
// managed host names one file per name (sha256(owner + newline + agent).json), so such
// an event is resolved through RosterStore.wakeIndex() and polls that one record;
// anything it cannot name asks for a whole-roster sweep, at most once per second.
// This loop's own writes do not wake it: RosterStore.dataVersion() does not move for
// this connection's own commits, so a poll that saves its own progress cannot spin.
// A commit from another process (the Codex stdio side, the MCP server) is caught by
// re-reading dataVersion in one-second slices of the quiet wait.
//
// Cadence: names that owe something time-critical — an undelivered report, an
// unconfirmed receipt, a dispatch retry, an attempt about to become due — are polled
// every second (service.fastPollNames(), no roster sweep). Everything else waits for
// its own file event, with a whole-roster sweep at least every five seconds, so a
// missed event costs at most five seconds and a named event costs the round floor.
//
// Exit: a real idle dwell (IDLE_EXIT_MS without work and without an external
// commit) releases the leases and ends the process. A DSH-only installation goes
// to zero background processes.
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { createScopedAgents } from './scoped-agents.mjs';
import { scopedManagement } from './mcp-server.mjs';
import { backgroundBatch, pollSleeping, scanSleeping } from './idle-monitor.mjs';
import { createDirectoryWatchers, createWakeQueue, ensureSharedMonitor, monitorDirectories, monitorSelfHeld, monitorWaitMs,
  recordMonitorPid, renewMonitorPid, throttledSignal, waitForCommit, wakeHintName, MONITOR_LEASE, MONITOR_PROCESS_LEASE,
  MONITOR_READY_LEASE } from './shared-monitor.mjs';
import { closeReportService, ensureReportService, reportPort, rosterIdentity } from './report-endpoint.mjs';
import { processStartTime } from './claude-caller-identity.mjs';

const MIN_ROUND_MS = 250;      // never poll faster than this
const BUSY_WAIT_MS = 1000;     // cadence while something still owes work
const POLL_SIGNAL_MS = 1000;   // a completed poll may wake the loop at most this often
const IDLE_WAIT_MS = 5000;     // cadence for a quiet installation: file events carry the rest
const SWEEP_MS = 5000;         // whole-roster sweep ceiling when no file event names a record
const COMMIT_POLL_MS = 1000;   // slice of the quiet wait that re-reads PRAGMA data_version
const SWEEP_REQUEST_MS = 1000; // at most one sweep per second from unmapped file events
const IDLE_EXIT_MS = 30000;    // real idle dwell before the process ends

const values = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
  if (index % 2 === 0) pairs.push([value, all[index + 1]]);
  return pairs;
}, []));
if (!values['--config'] || !/^monitor-[0-9a-f-]{36}$/.test(values['--lease'] ?? '')) throw new Error('Invalid shared monitor identity.');
const config = await loadConfig(values['--config']);
const hostDirectory = config.managedStateDirectory ?? path.join(path.dirname(config.hostBridgeFile), 'managed-host');

// Hints the next round acts on: a managed-host file event names one record, anything
// unmapped asks for at most one sweep per second. See createWakeQueue.
const hints = createWakeQueue({ sweepRequestMs: SWEEP_REQUEST_MS });
// A poll that wrote durable state wakes the loop at most once a second; one inside
// that second wakes it when the second ends instead of being dropped.
const pollSignal = throttledSignal(signal, { intervalMs: POLL_SIGNAL_MS });
const service = createScopedAgents(config, {
  // This process IS the shared listener. Its own work paths — waking a sleeping name,
  // parking one, a first dispatch — ask "is a listener running?", and the honest answer
  // for that question about oneself is known without asking the OS: a process that holds
  // this holder's current holder and readiness leases and is executing this line is
  // alive by construction. Verifying it instead costs an OS creation-time query for our
  // own PID (a PowerShell start: 1.3s idle, 2.7s under load) inside the round that owes
  // the answer, which is how a wake drifted past the one file-event second the cadence
  // promises. Only that self case skips the check; every other caller still goes to
  // ensureSharedMonitor, and with the switch off nothing changes at all.
  startSharedMonitor: async (serviceConfig, serviceStore) => {
    const lease = values['--lease'], state = serviceStore ?? store;
    if (config.idleSessionCleanup !== false && monitorSelfHeld(state, lease)) return true;
    return ensureSharedMonitor(serviceConfig, state);
  },
  onPollComplete: () => {
    trace("wake= poll-complete");
    pollSignal.request();
  },
  // The loopback tool service runs in this process, so a queued supplement, a cancel
  // or a first dispatch to this target is a wake this loop can act on immediately
  // instead of serving it up to a sweep later.
  onWorkQueued: agentId => { trace("wake= queued " + agentId); if (hints.queued(agentId)) signal(); },
}), store = service.store, holder = values['--lease'];

let wake, heartbeat, running = true, signalled = false, lastDelivery = 0, identity;
let idleSince, lastVersion = store.dataVersion(), rounds = 0, lastSweepAt = 0;
// Measurement aid only: FUTUREAIDE_MONITOR_TRACE=1 prints one line per round so a
// test or a manual run can count rounds without reading the database.
const trace = process.env.FUTUREAIDE_MONITOR_TRACE === '1'
  ? message => process.stderr.write(`[futureaide-monitor] ${message}\n`) : () => {};
const failures = new Map();
// Parsed sleeping state per name, keyed by file size and timestamp: an unchanged
// file is not read again. It only ever skips a read of identical bytes.
const sleepCache = new Map();
const ownsLease = () => { const lease = store.lease(MONITOR_LEASE); return running && lease?.holder === holder && lease.expires > Date.now(); };
const deliveries = backgroundBatch(() => pollSleeping(store, agentId => service.poll(agentId),
  (agentId, taskId) => service.wake(agentId, taskId), ownsLease), signal);
function signal() { if (wake) wake(); else signalled = true; }

function onFileEvent(directory, filename) {
  const hash = wakeHintName(filename);
  const agentId = hash ? store.wakeIndex().get(hash) : undefined;
  trace(`file=${filename ?? 'unknown'} hint=${agentId ?? (hash ? 'unknown-name' : 'sweep')}`);
  if (hints.event(agentId)) signal();
}

// fs.watch accepts a single path, so every watched directory owns one watcher.
const watchers = createDirectoryWatchers(onFileEvent);
function attach(directories) { return watchers.update(directories); }

function sleepUntilSignalled(timeoutMs) {
  if (timeoutMs <= 0) { signalled = false; return Promise.resolve(); }
  return new Promise(resolve => {
    const timer = setTimeout(() => { wake = undefined; resolve(); }, timeoutMs);
    // A real signal also sets the flag: the wait that was cut short has to be able to
    // tell "there is work" from "the slice elapsed", or it would keep waiting.
    wake = () => { clearTimeout(timer); wake = undefined; signalled = true; resolve(); };
  });
}

/**
 * Wait for work. A file event wakes the wait immediately; a commit from another
 * process (the Codex stdio side and the MCP server write this roster with no watcher
 * behind them) cannot, so the quiet wait is cut into one-second slices that re-read
 * PRAGMA data_version — an in-memory counter, no disk — and end the wait so the loop
 * sweeps. A name hinted by that commit must not wait for its own poll floor.
 */
async function waitForWork(timeoutMs, floor) {
  const outcome = await waitForCommit({ timeoutMs, floorMs: floor, sliceMs: COMMIT_POLL_MS,
    sleep: sleepUntilSignalled, signalled: () => signalled, readVersion: () => store.dataVersion(), version: lastVersion });
  signalled = false;
  trace(`wait= ${outcome.reason}`);
  if (outcome.reason === 'commit') {
    lastVersion = outcome.version;
    hints.commit();
    idleSince = undefined;
  }
}

try {
  if (config.idleSessionCleanup !== false) {
    const startedAt = await processStartTime(process.pid);
    if (startedAt !== null) {
      if (!recordMonitorPid(store, holder, process.pid, startedAt)) throw new Error('Monitor holder lease was lost.');
      identity = startedAt;
    }
  }
  // The loopback management tool service is hosted here (config.reportPort, then
  // FUTUREAIDE_REPORT_PORT, then the default) so a calling Claude Desktop session
  // always finds it; DSH work alone does not need it. A service answering for another
  // roster is reported and never reused.
  // The team board is mounted on this same loopback listener, and only when the
  // installation switched it on: with teamBoard off the module is never imported, no
  // projection is read and no route exists. Nothing here polls, scans processes or opens
  // a conversation; both routes answer whatever a request asks for at that moment.
  let board;
  if (config.teamBoard === true) {
    try {
      const { boardRoutes } = await import('./team-board.mjs');
      board = boardRoutes(store);
    } catch (error) {
      trace(`board not mounted: ${error?.code ?? error?.message ?? 'unknown'}`);
      process.stderr.write(`[futureaide-monitor] team board not mounted: ${error?.code ?? error?.message ?? 'unknown'}\n`);
    }
  }
  const reports = await ensureReportService({ store, port: reportPort(config),
    management: scopedManagement({ service }), ...(board ? { board } : {}), log: message => trace(`report: ${message}`) });
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
    if (!store.renewLease(MONITOR_LEASE, holder, 60000) || !store.renewLease(MONITOR_READY_LEASE, holder, 60000)
      || (identity !== undefined && !renewMonitorPid(store, holder, process.pid, identity))) {
      running = false;
      signal();
    }
  }, 15000);
  heartbeat.unref();
  // A round only reads the leases. The heartbeat above is what keeps them alive, so
  // two write transactions per idle second are gone; a lease that was stolen or has
  // expired still stops the loop on the next read.
  while (running && store.leaseHeld(MONITOR_LEASE, holder)) {
    if (!store.leaseHeld(MONITOR_READY_LEASE, holder)) break;
    const roundStarted = Date.now();
    const taken = hints.take();
    // Names that owe something time-critical — an undelivered report, an unconfirmed
    // receipt, a dispatch retry, an attempt about to become due — are polled every
    // second without sweeping the roster. Ordinary running work is driven by its own
    // file events and by the five-second sweep.
    const fast = service.fastPollNames();
    const only = fast.length ? [...new Set([...taken.names, ...fast])] : taken.names;
    const sweepDue = taken.sweep || Date.now() - lastSweepAt >= SWEEP_MS;
    attach(monitorDirectories(config));
    // Sleeping agents keep their existing DSH host-state path unchanged.
    await scanSleeping(store, hostDirectory, (agentId, taskId) => {
      const current = store.lease(MONITOR_LEASE);
      if (current?.holder !== holder || current.expires <= Date.now()) { running = false; return false; }
      return service.wake(agentId, taskId);
    }, failures, sleepCache);
    // Every name that still owes work is polled by this one process. A named file
    // event polls that record; the rest of the roster is swept at least every
    // SWEEP_MS so a missed event costs at most that much delay.
    let busy = false;
    const deferred = [];
    // `only` is what to poll without a sweep; `fresh` is only the real hints, which are
    // the only ones allowed to skip a name's own one-second floor.
    try { busy = await service.monitorScan({ only, fresh: taken.names, sweep: sweepDue, force: taken.force, deferred }); }
    catch (error) {
      busy = true;
      trace(`scan= ${error?.code ?? error?.message ?? 'error'}`);
    }
    if (sweepDue) lastSweepAt = Date.now();
    // A finished round waiting on its release confirmation is not work: the listener
    // sleeps to that exact moment, and a pending re-check keeps the process from ending
    // as idle before it can happen.
    const releaseAt = service.releaseWakeAt();
    // A hint for a name whose own poll was still running is handed back, so the round
    // after that poll ends acts on it instead of waiting for the next sweep.
    if (hints.defer(deferred)) { trace(`wake= deferred ${deferred.join(",")}`); signalled = true; }
    const version = store.dataVersion();
    const external = version !== lastVersion;
    lastVersion = version;
    // A commit nobody told us about is news: the next round sweeps for it instead of
    // waiting out the five-second ceiling.
    if (external) hints.commit();
    if (running && Date.now() - lastDelivery >= 30000) {
      lastDelivery = Date.now();
      deliveries.start();
    }
    // A pending release re-check is work this listener is waiting for, so it never
    // counts as idle dwell and cannot lose the moment by exiting first.
    if (busy || external || releaseAt !== undefined) idleSince = undefined;
    else idleSince ??= Date.now();
    rounds += 1;
    trace(`round=${rounds} busy=${busy} external=${external} sweep=${sweepDue ? 1 : 0} idleMs=${idleSince === undefined ? 0 : Date.now() - idleSince} watched=${watchers.size}`);
    const quiet = !busy && !external && !store.hasSleeping() && releaseAt === undefined;
    if (quiet && Date.now() - idleSince >= IDLE_EXIT_MS) {
      store.releaseLease(MONITOR_READY_LEASE, holder);
      const stillQuiet = !store.hasSleeping() && store.dataVersion() === lastVersion;
      if (stillQuiet) break;
      if (!store.claimLease(MONITOR_READY_LEASE, holder, 60000)) break;
      idleSince = Date.now();
    }
    // A self-write can only arrive as a hint; it never shortens the round floor.
    const floor = Math.max(0, MIN_ROUND_MS - (Date.now() - roundStarted));
    const immediate = signalled || external;
    signalled = false;
    const waitMs = monitorWaitMs({ busy, busyMs: BUSY_WAIT_MS, idleMs: IDLE_WAIT_MS,
      // A pending release re-check may shorten this wait, never lengthen it: the round
      // that follows is the roster sweep and the DSH sleeping scan, so it is capped by
      // whichever comes first, the next sweep or the re-check itself.
      sweepInMs: lastSweepAt + SWEEP_MS - Date.now(),
      releaseInMs: releaseAt === undefined ? undefined : releaseAt - Date.now(), floorMs: floor });
    if (immediate) await sleepUntilSignalled(floor);
    else await waitForWork(waitMs, floor);
  }
} finally {
  await deliveries.drain();
  await service.drainPolls();
  pollSignal.close();
  clearInterval(heartbeat);
  watchers.close();
  await closeReportService();
  store.releaseLease(MONITOR_READY_LEASE, holder);
  if (identity !== undefined) store.releaseLease(MONITOR_PROCESS_LEASE, `${holder}:${process.pid}:${identity}`);
  store.releaseLease(MONITOR_LEASE, holder);
  service.close();
}
