// One shared listener per plugin instead of one Node process per subagent. The
// listener polls every agent that still has work through the same scoped state
// machine, and exits as soon as nothing is left, so an idle plugin keeps no
// background process at all. DSH and Claude Desktop share this path.
//
// The lease keys keep their historical names because the roster's sleep guard
// reads them directly: 'idle-monitor' is the shared monitor, not a per-agent one.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const MONITOR_LEASE = 'idle-monitor';
export const MONITOR_READY_LEASE = 'idle-monitor:ready';

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
