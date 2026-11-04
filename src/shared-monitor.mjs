// One shared listener per plugin instead of one Node process per subagent. The
// listener polls every agent that still has work through the same scoped state
// machine, and exits as soon as nothing is left, so an idle plugin keeps no
// background process at all. DSH and Claude Desktop share this path.
//
// The lease keys keep their historical names because the roster's sleep guard
// reads them directly: 'idle-monitor' is the shared monitor, not a per-agent one.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync, watch } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MONITOR_LEASE = 'idle-monitor';
export const MONITOR_READY_LEASE = 'idle-monitor:ready';

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
 * Bindings come from the adapter's own state (binding.transcriptFile), so a new
 * child session directory joins the set as soon as it is recorded.
 */
export function monitorDirectories(config, { env = process.env, bindings = [], exists = defaultExists } = {}) {
  const directories = new Set();
  const host = config.managedStateDirectory ?? (config.hostBridgeFile ? path.join(path.dirname(config.hostBridgeFile), 'managed-host') : undefined);
  if (host) directories.add(host);
  const claudeRoot = env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude');
  directories.add(path.join(claudeRoot, 'sessions'));
  for (const file of bindings) {
    if (typeof file === 'string' && file && path.isAbsolute(file)) directories.add(path.dirname(file));
  }
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

export function monitorAlive(store, now = Date.now()) {
  const owner = store.lease(MONITOR_LEASE);
  const ready = store.lease(MONITOR_READY_LEASE);
  return Boolean(owner && ready && owner.holder === ready.holder && owner.expires > now && ready.expires > now);
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
 */
export async function ensureSharedMonitor(config, store, { spawnProcess = spawn } = {}) {
  if (!config.configFile) return false;
  if (monitorAlive(store)) return true;
  const owner = store.lease(MONITOR_LEASE);
  if (owner && owner.expires > Date.now()) return true; // Another caller is starting it.
  const holder = `monitor-${randomUUID()}`;
  if (!store.claimLease(MONITOR_LEASE, holder, 30000)) return true;
  try { await monitorSpawn(config.configFile, holder, spawnProcess); }
  catch (error) { store.releaseLease(MONITOR_LEASE, holder); throw error; }
  return true;
}
