// One shared listener per plugin instead of one Node process per subagent. The
// listener polls every agent that still has work through the same scoped state
// machine, and exits as soon as nothing is left, so an idle plugin keeps no
// background process at all. DSH and Claude Desktop share this path.
//
// The lease keys keep their historical names because the roster's sleep guard
// reads them directly: 'idle-monitor' is the shared monitor, not a per-agent one.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MONITOR_LEASE = 'idle-monitor';
export const MONITOR_READY_LEASE = 'idle-monitor:ready';

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
