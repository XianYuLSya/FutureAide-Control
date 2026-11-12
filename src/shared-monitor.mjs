// One shared listener per plugin instead of one Node process per subagent. The
// listener polls every agent that still has work through the same scoped state
// machine, and exits as soon as nothing is left, so an idle plugin keeps no
// background process at all. DSH and Claude Desktop share this path.
//
// The lease keys keep their historical names because the roster's sleep guard
// reads them directly: 'idle-monitor' is the shared monitor, not a per-agent one.
//
// Liveness: the lease pair alone cannot tell a listener that is running from one that
// was killed mid-lease, because a killed worker cannot release or renew anything for
// up to a minute. The worker records its PID and OS creation time in a separate
// lease. A missing PID or a different creation time permits replacing the worker.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processStartTime } from './claude-caller-identity.mjs';

export const MONITOR_LEASE = 'idle-monitor';
export const MONITOR_READY_LEASE = 'idle-monitor:ready';
// The worker registers itself as <lease holder>:<pid>:<procStart>.
export const MONITOR_PROCESS_LEASE = 'idle-monitor:pid';
/** How long a recorded identity is believed without a renewal from its own worker. */
export const MONITOR_PROCESS_TTL_MS = 60000;
const LEASE_HOLDER = /^monitor-[0-9a-f-]{36}$/;
const PROCESS_HOLDER = /^(monitor-[0-9a-f-]{36}):([1-9]\d*)(?::(\d+))?$/;

/**
 * One watcher per directory. fs.watch does not accept an array of paths, so each
 * directory gets its own watch and the set is kept in step with what the listener
 * currently cares about: new directories are watched, dropped ones are closed,
 * and close() releases everything. Watchers are non-persistent, so they never keep
 * the process alive on their own.
 */
export function createDirectoryWatchers(onEvent, { watchImpl = watch } = {}) {
  const watchers = new Map();
  return {
    update(directories) {
      const wanted = new Set(directories);
      for (const [directory, watcher] of watchers) {
        if (wanted.has(directory)) continue;
        watcher.close();
        watchers.delete(directory);
      }
      for (const directory of wanted) {
        if (watchers.has(directory)) continue;
        try {
          // The listener is told which directory changed, not the raw event type.
          // The file name is carried along when the platform reports it: the managed
          // host names one file per name, so it can point at a single record instead
          // of a whole-roster sweep. A null name (or a directory we do not map) is
          // simply a hint to sweep.
          const watcher = watchImpl(directory, { persistent: false }, (eventType, filename) => onEvent(directory, filename ?? null));
          watcher.on('error', () => { watcher.close(); watchers.delete(directory); onEvent(directory, null); });
          watchers.set(directory, watcher);
        } catch { /* A directory that cannot be watched is simply skipped. */ }
      }
      return watchers.size;
    },
    get size() { return watchers.size; },
    close() {
      for (const watcher of watchers.values()) watcher.close();
      watchers.clear();
    },
  };
}

/**
 * Directories whose file events are worth waking for. Every one of them belongs
 * to a different process — the DSH managed host, the Claude session registry and
 * each managed session's transcript directory — so an event never comes from this
 * listener's own work.
 *
 * The roster directory is deliberately NOT watched: reading a WAL database touches
 * its -shm/-wal files, so watching it would echo the listener's own poll back as an
 * event and spin the loop. Roster commits made by another connection are detected
 * instead through RosterStore.dataVersion(), which does not move for our own
 * commits.
 */
export function monitorDirectories(config, { env = process.env, exists = defaultExists } = {}) {
  const directories = new Set();
  const host = config.managedStateDirectory ?? (config.hostBridgeFile ? path.join(path.dirname(config.hostBridgeFile), 'managed-host') : undefined);
  if (host) directories.add(host);
  const claudeRoot = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  directories.add(path.join(claudeRoot, 'sessions'));
  return [...directories].filter(directory => exists(directory)).map(directory => path.resolve(directory));
}

function defaultExists(directory) {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}

/**
 * The managed host writes one state file per name, named
 * sha256(owner + newline + agent).json, so a file event usually names exactly one
 * record. Returns that file's hash, or null for anything else (a session registry,
 * a transcript directory, a partial write).
 */
export function wakeHintName(filename) {
  const match = typeof filename === 'string' ? /^([0-9a-f]{64})(?:\.json)?$/i.exec(filename) : null;
  return match ? match[1].toLowerCase() : null;
}

/**
 * Hints a file event leaves for the next round: the names to poll, whether the
 * whole roster has to be swept, and whether the sweep may ignore the per-name
 * poll floor (an external commit is news nobody was waiting for).
 *
 * Unmapped events ask for a sweep at most once per sweepRequestMs; a burst keeps
 * the marker without waking the loop again, because the sweep already pending will
 * see everything the burst touched.
 */
export function createWakeQueue({ sweepRequestMs = 1000, now = Date.now } = {}) {
  const names = new Set();
  let sweep = false, force = false, lastSweepRequest = -Infinity;
  return {
    get pending() { return names.size; },
    get sweeping() { return sweep; },
    /** One file event. True means the loop should be woken now. */
    event(agentId) {
      if (agentId) { names.add(agentId); return true; }
      sweep = true;
      if (now() - lastSweepRequest < sweepRequestMs) return false;
      lastSweepRequest = now();
      return true;
    },
    /** Another connection committed: a sweep now, without the per-name poll floor. */
    commit() { sweep = true; force = true; return true; },
    /** Work was queued in this process for one name. */
    queued(agentId) { if (agentId) names.add(agentId); return Boolean(agentId); },
    /** Everything waiting, consumed; the queue is empty afterwards. */
    take() {
      const taken = { names: [...names], sweep, force };
      names.clear();
      sweep = false;
      force = false;
      return taken;
    },
    /** A hint whose own poll was still running: back in the queue, and wake again. */
    defer(ids) { for (const id of ids) names.add(id); return ids.length > 0; },
  };
}

/**
 * A wake that fires at most once per intervalMs and is never lost: a request inside
 * the window schedules one wake for the end of that window, so a poll that wrote
 * durable state is acted on within the interval, not at the next five-second sweep.
 */
export function throttledSignal(signal, { intervalMs = 1000, now = Date.now } = {}) {
  let last = -Infinity, timer;
  const fire = () => { clearTimeout(timer); timer = undefined; last = now(); signal(); };
  return {
    request() {
      const wait = last + intervalMs - now();
      if (wait <= 0) fire();
      else timer ??= setTimeout(fire, wait);
    },
    close() { clearTimeout(timer); timer = undefined; },
  };
}

/**
 * Wait for work in slices. A file event wakes the wait at once; a commit from
 * another process cannot, so every slice re-reads the roster's commit counter and
 * ends the wait so the loop can sweep. Injected functions keep this testable.
 */
export async function waitForCommit({ timeoutMs, floorMs = 0, sliceMs = 1000,
  sleep, signalled, readVersion, version }) {
  const deadline = Date.now() + timeoutMs;
  let first = true;
  while (true) {
    const remaining = Math.max(0, deadline - Date.now());
    await sleep(Math.max(first ? floorMs : 0, Math.min(remaining, sliceMs)));
    first = false;
    if (signalled()) return { reason: 'work' };
    const current = readVersion();
    if (current !== version) return { reason: 'commit', version: current };
    if (Date.now() >= deadline) return { reason: 'timeout' };
  }
}

/**
 * How long the quiet wait may last before the next round. The round itself is what
 * sweeps the roster and scans the DSH sleeping state, so this number is a promise about
 * that fallback as much as about the wait: a pending release re-check may shorten the
 * wait, never stretch it past the next sweep. `releaseInMs` is the moment a finished
 * round's release re-check becomes due, `sweepInMs` the time left until the sweep is due.
 */
export function monitorWaitMs({ busy, busyMs = 1000, idleMs = 5000, sweepInMs = idleMs, releaseInMs, floorMs = 0 }) {
  if (busy) return busyMs;
  const idle = releaseInMs === undefined ? idleMs : Math.min(idleMs, Math.max(0, releaseInMs));
  return Math.max(floorMs, Math.min(Math.max(0, sweepInMs), idle));
}

/**
 * Is that PID a live process? Signal 0 asks the operating system and sends nothing —
 * one syscall per question, no process-table scan, no `tasklist`/CIM query, so every
 * MCP connection can ask it on a timer. Only ESRCH ("no such process") proves death;
 * EPERM and every other error mean the PID exists but may not be signalled, and an
 * unanswerable question is answered the old way: assume alive, because a listener must
 * never be replaced on a guess.
 */
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

/**
 * The switch this file obeys. It is the installation's own user-facing setting for the
 * background lifecycle, not a new one of ours: with it off, every reader here answers
 * from the leases alone, exactly as before.
 */
export function lifecycleEnabled(config = {}) { return config?.idleSessionCleanup !== false; }

/**
 * The monitor's three lease rows in one consistent read: the two ownership rows and the
 * identity row only mean anything together, and reading them one by one would let a
 * second connection commit in between — a pair that never existed, or a PID belonging to
 * the listener that was just replaced. Expired rows are returned as they are; callers
 * decide what a lapsed row means (`liveAt`).
 */
export function monitorLeases(store, now = Date.now()) {
  const keys = [MONITOR_LEASE, MONITOR_READY_LEASE, MONITOR_PROCESS_LEASE];
  const rows = typeof store.leases === 'function'
    ? store.leases(keys)
    // A store without the snapshot call is read key by key: correct, just not atomic.
    : new Map(keys.map(key => [key, store.lease(key)]).filter(([, row]) => row));
  const row = key => { const value = rows.get(key); return value ? { holder: value.holder, expires: value.expires } : undefined; };
  const snapshot = { at: now, owner: row(MONITOR_LEASE), ready: row(MONITOR_READY_LEASE), identityRow: row(MONITOR_PROCESS_LEASE) };
  return { ...snapshot, live: { owner: liveAt(snapshot.owner, now), ready: liveAt(snapshot.ready, now), identityRow: liveAt(snapshot.identityRow, now) } };
}

function liveAt(row, now) { return row && row.expires > now ? row : undefined; }

/** The identity described by one snapshot row, when it belongs to that holder and is inside its window. */
function identityFrom(row, holder, now) {
  const live = liveAt(row, now);
  if (!live) return undefined;
  const match = PROCESS_HOLDER.exec(live.holder);
  if (!match || match[1] !== holder) return undefined;
  const pid = Number(match[2]);
  if (!Number.isSafeInteger(pid)) return undefined;
  return { holder: live.holder, pid, procStart: match[3] ?? null };
}

/** The identity row, when it belongs to that holder and its lease is still inside its window. */
export function monitorProcess(store, holder, now = Date.now()) {
  return identityFrom(monitorLeases(store, now).identityRow, holder, now);
}

/**
 * Is this process the listener? One snapshot answers it: a process that still holds the
 * holder and readiness leases and is asking the question is alive by construction, with
 * no OS query and no second read.
 */
export function monitorSelfHeld(store, holder, now = Date.now()) {
  const { owner, ready } = monitorLeases(store, now);
  const held = row => Boolean(row && row.holder === holder && row.expires > now);
  return held(owner) && held(ready);
}

/** The worker registers itself only while SQLite can prove it still owns the lease. */
export function recordMonitorPid(store, holder, pid, procStart, leaseMs = MONITOR_PROCESS_TTL_MS) {
  if (!LEASE_HOLDER.test(holder ?? '') || !Number.isSafeInteger(pid) || pid <= 0
      || typeof procStart !== 'string' || !/^\d+$/.test(procStart)) return false;
  return store.claimLeaseWhileHeld(MONITOR_PROCESS_LEASE, `${holder}:${pid}:${procStart}`, leaseMs, MONITOR_LEASE, holder);
}

/** Keep the identity inside its window; the worker's heartbeat renews it with its leases. */
export function renewMonitorPid(store, holder, pid, procStart, leaseMs = MONITOR_PROCESS_TTL_MS) {
  return store.renewLease(MONITOR_PROCESS_LEASE, `${holder}:${pid}:${procStart}`, leaseMs);
}

/**
 * Check the worker's ownership and readiness leases. With cleanup enabled, the
 * OS creation time must match the registered identity.
 *
 *   lease-not-ready      nothing yet, or a start in progress that cannot be falsified
 *   lease                the switch is off: leases alone, as before
 *   identity-unknown     no identity row for this holder: an older listener, or a start
 *                        that has not registered itself yet
 *   identity-unverified  an identity row exists but cannot be confirmed: its creation
 *                        time is unreadable, or the process may not be signalled. Not
 *                        proof of life, and not proof of death either
 *   process              the recorded PID is alive and its creation time matches
 *   process-gone         the PID disappeared or its creation time changed
 *
 * The rows are read once, and the answer is only trusted for the rows it was computed
 * from: the OS creation-time query is asynchronous, so the same three rows are read
 * again afterwards and a changed set is verified afresh (once) instead of an answer
 * about a lapsed or replaced listener being reported as alive.
 */
export async function monitorState(store, now = Date.now(), { isProcessAlive = processAlive,
  startTime = processStartTime, idleSessionCleanup = true } = {}) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    // The caller's reference time decides the first read; a re-read after the async query
    // is about the rows as they are now.
    const at = attempt === 0 ? now : Date.now(), snapshot = monitorLeases(store, at);
    const { owner, ready } = snapshot.live;
    const paired = Boolean(owner && ready && owner.holder === ready.holder);
    if (!idleSessionCleanup) {
      return paired ? { alive: true, holder: owner.holder, reason: 'lease' } : { alive: false, holder: owner?.holder, reason: 'lease-not-ready' };
    }
    const identity = owner ? identityFrom(snapshot.identityRow, owner.holder, at) : undefined;
    if (!identity) {
      return paired
        ? { alive: false, holder: owner.holder, reason: 'identity-unknown' }
        : { alive: false, holder: owner?.holder, reason: 'lease-not-ready' };
    }
    // Existence alone recovers a listener that was confirmed and then died before it ever
    // reported ready: the process question has an answer although the pair is incomplete.
    let gone = false;
    try { gone = isProcessAlive(identity.pid) === false; } catch { /* only the creation time can tell */ }
    if (!gone && !paired) return { alive: false, holder: owner.holder, pid: identity.pid, reason: 'lease-not-ready' };
    let current;
    if (!gone) {
      // An identity we cannot read is not an identity: a PID alone cannot tell our
      // worker from a reused PID, so that answer is "unverified", never "alive".
      try { current = await startTime(identity.pid); } catch { /* identity remains unknown */ }
    }
    // The answer belongs to those exact live rows: a renewal by the same holder keeps them
    // valid, a lease that lapses during the query does not, and a row that lapsed must
    // never be reported alive just because its holder name is still written there.
    const latest = monitorLeases(store, Date.now()), before = snapshot.live, after = latest.live;
    const unchanged = ['owner', 'ready', 'identityRow'].every(key => before[key]?.holder === after[key]?.holder);
    if (!unchanged) continue; // lapsed or moved by a second connection: judge what is there now
    if (gone) return { alive: false, holder: owner.holder, pid: identity.pid, processHolder: identity.holder, reason: 'process-gone' };
    const matched = typeof current === 'string' && /^\d+$/.test(current) && identity.procStart !== null;
    if (matched && current === identity.procStart) {
      return { alive: true, holder: owner.holder, pid: identity.pid, reason: 'process' };
    }
    if (matched) {
      return { alive: false, holder: owner.holder, pid: identity.pid, processHolder: identity.holder, reason: 'process-gone' };
    }
    return { alive: false, holder: owner.holder, pid: identity.pid, reason: 'identity-unverified' };
  }
  // The rows kept moving under the query: report the newest set, never a stale answer.
  const at = Date.now(), snapshot = monitorLeases(store, at);
  const { owner, ready } = snapshot.live;
  if (!owner || !ready || owner.holder !== ready.holder) return { alive: false, holder: owner?.holder, reason: 'lease-not-ready' };
  if (!idleSessionCleanup) return { alive: true, holder: owner.holder, reason: 'lease' };
  const identity = identityFrom(snapshot.identityRow, owner.holder, at);
  return { alive: false, holder: owner.holder, pid: identity?.pid,
    reason: identity ? 'identity-unverified' : 'identity-unknown' };
}

/**
 * The status/lifecycle reading of the shared listener. `options.idleSessionCleanup` is
 * the same installation switch `ensureSharedMonitor` reads from its config, so a status
 * surface and the background lifecycle always answer with the same rule.
 */
export async function monitorAlive(store, now = Date.now(), options = {}) {
  return (await monitorState(store, now, options)).alive;
}

/** Spawn the single detached monitor. A PID alone never confirms a successful spawn. */
export function monitorSpawn(configFile, lease, spawnProcess = spawn) {
  if (!configFile) throw new Error('The installed plugin has no private configuration path for recovery.');
  if (!/^monitor-[0-9a-f-]{36}$/.test(lease ?? '')) throw new Error('Invalid shared monitor lease.');
  const script = fileURLToPath(new URL('./scoped-worker.mjs', import.meta.url));
  const child = spawnProcess(process.execPath, [script, '--config', configFile, '--lease', lease], {
    detached: true, stdio: 'ignore', windowsHide: true,
  });
  return new Promise((resolve, reject) => {
    // Spawn failures arrive asynchronously; a surrounding try/catch cannot catch
    // an unhandled ChildProcess error event. Confirm spawn before saving its PID.
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(child.pid); });
  });
}

/**
 * Make sure the shared monitor exists. True means one is running or being
 * started by some caller; false means this build cannot watch this installation.
 * A failed spawn releases its lease so the next call can try again.
 *
 * A listener that is provably gone releases its own rows first, by holder, so the
 * replacement can claim them at once: compare-and-delete, not a blind takeover.
 *
 * Nothing else is a reason to skip the attempt: an unreadable creation time, an identity
 * row that is not ours yet, a start in progress. Those are not proof of a listener
 * either, so the claim below is made and the lease CAS decides — it refuses a holder
 * whose rows have not lapsed and starts exactly one replacement when they have. A
 * holder that is not proven dead keeps its rows: nothing here steals them.
 *
 * The answer follows the refusal too. A caller refused by the very holder whose process
 * identity is unknown or unreadable — no identity row, a lapsed one, one belonging to
 * another holder, or a creation time that cannot be read — gets false: an unexpired row
 * is not an ensured listener, and saying true would park work on a worker nobody can
 * vouch for. A refusal from a different holder (somebody else won the claim meanwhile)
 * and the ordinary start in progress (a holder without readiness yet) keep the older
 * meaning: true, one is being started.
 *
 * With config.idleSessionCleanup off this is the original lease-only function: no
 * identity is read, none is written, and an unexpired holder lease answers true without
 * an attempt, as it always did.
 */
export async function ensureSharedMonitor(config, store, { spawnProcess = spawn, isProcessAlive = processAlive, startTime = processStartTime,
  idleSessionCleanup = lifecycleEnabled(config) } = {}) {
  if (!config.configFile) return false;
  const state = await monitorState(store, Date.now(), { isProcessAlive, startTime, idleSessionCleanup });
  if (state.alive) return true;
  if (!idleSessionCleanup) {
    // The switch is off: leases alone, and an unexpired holder is taken at its word.
    const { owner } = monitorLeases(store).live;
    if (owner) return true;
  }
  if (state.reason === 'process-gone') {
    // Release only rows that still are the ones the answer was computed from. The verdict
    // came from one snapshot; if a second connection has replaced that holder meanwhile,
    // its rows — and its fresh identity row in particular — belong to the successor and
    // must not be cleared by a stale PID.
    const latest = monitorLeases(store);
    const stillOurs = latest.owner?.holder === state.holder && latest.identityRow?.holder === state.processHolder;
    if (stillOurs) {
      store.releaseLease(MONITOR_READY_LEASE, state.holder);
      store.releaseLease(MONITOR_PROCESS_LEASE, state.processHolder);
      store.releaseLease(MONITOR_LEASE, state.holder);
    }
  }
  const holder = `monitor-${randomUUID()}`;
  if (!store.claimLease(MONITOR_LEASE, holder, 30000)) {
    const { owner } = monitorLeases(store).live;
    const unknownIdentity = state.reason === 'identity-unverified' || state.reason === 'identity-unknown';
    // The unmatched rows stay: an unreadable holder is waited out on its own lease, never
    // taken over. The caller is simply told the truth about what that means.
    if (owner && owner.holder === state.holder && unknownIdentity) return false;
    return true;
  }
  try { await monitorSpawn(config.configFile, holder, spawnProcess); }
  catch (error) { store.releaseLease(MONITOR_LEASE, holder); throw error; }
  return true;
}
