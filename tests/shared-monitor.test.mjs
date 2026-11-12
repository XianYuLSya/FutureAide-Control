import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path, { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RosterStore } from '../src/roster-store.mjs';
import { processStartTime } from '../src/claude-caller-identity.mjs';
import { idleSignal } from '../src/idle-monitor.mjs';
import { createDirectoryWatchers, ensureSharedMonitor, monitorAlive, monitorDirectories, monitorProcess, monitorSpawn,
  monitorState, monitorWaitMs, processAlive, recordMonitorPid, renewMonitorPid, MONITOR_PROCESS_LEASE } from '../src/shared-monitor.mjs';

const LEASE = 'monitor-00000000-0000-4000-8000-000000000000';
// The identity row a worker writes for itself: holder `<lease holder>:<pid>:<procStart>`.
const PID_KEY = 'idle-monitor:pid';
const config = configFile => ({ configFile });
const normalize = value => resolve(value);
const tick = ms => new Promise(done => setTimeout(done, ms));

/**
 * A real process that has already ended. Its PID provably names no listener any
 * more, which is what a monitor killed with no chance to clean up leaves behind.
 */
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((started, failed) => { child.once('spawn', started); child.once('error', failed); });
  const pid = child.pid;
  child.kill();
  await new Promise(ended => child.once('exit', ended));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the fixture process has to be gone');
  return pid;
}

/** Both leases and the identity row of a worker that died without releasing them. */
function crashedMonitor(store, pid, { expires = 60000 } = {}) {
  store.claimLease('idle-monitor', LEASE, expires);
  store.claimLease('idle-monitor:ready', LEASE, expires);
  store.claimLease(PID_KEY, `${LEASE}:${pid}:100`, expires);
}

function spawnRecorder(fail = false) {
  const calls = [];
  const spawnProcess = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    if (fail) {
      child.unref = () => assert.fail('a failed spawn must not be detached');
      setImmediate(() => child.emit('error', Object.assign(new Error('spawn denied'), { code: 'EACCES' })));
    } else {
      child.pid = 4321;
      child.unref = () => {};
      setImmediate(() => child.emit('spawn'));
    }
    return child;
  };
  return { calls, spawnProcess };
}

test('a live listener is reused instead of spawning another one', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, process.pid, '100'), true);
    const startTime = () => '100';
    assert.equal(await monitorAlive(store, Date.now(), { startTime }), true);
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, { ...recorder, startTime }), true);
    assert.equal(recorder.calls.length, 0, 'no second process for a live listener');
  } finally { store.close(); }
});

test('concurrent callers start exactly one listener', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    const [first, second] = await Promise.all([
      ensureSharedMonitor(config('D:/fixture.json'), store, recorder),
      ensureSharedMonitor(config('D:/fixture.json'), store, recorder),
    ]);
    assert.deepEqual([first, second], [true, true]);
    assert.equal(recorder.calls.length, 1, 'the first caller owns the spawn; the second sees the holder lease');
    assert.ok(store.lease('idle-monitor'), 'the holder lease exists while the worker is starting');
  } finally { store.close(); }
});

test('a failed spawn releases the lease so a later call can retry', async () => {
  const store = new RosterStore(':memory:');
  try {
    const failing = spawnRecorder(true);
    await assert.rejects(ensureSharedMonitor(config('D:/fixture.json'), store, failing), /spawn denied/);
    assert.equal(store.lease('idle-monitor'), undefined, 'no stale holder keeps the plugin from retrying');
    const recorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, recorder), true);
    assert.equal(recorder.calls.length, 1);
  } finally { store.close(); }
});

test('an installation without a private config path never starts a listener', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor({}, store, recorder), false);
    assert.equal(recorder.calls.length, 0);
  } finally { store.close(); }
});

test('the listener reports a pid only after the operating system confirmed the spawn', async () => {
  const child = new EventEmitter();
  child.pid = 9876;
  let detached = false, confirmed = false;
  child.unref = () => { detached = true; };
  const started = monitorSpawn('D:/fixture.json', LEASE, () => child).then(pid => { confirmed = true; return pid; });
  await Promise.resolve();
  assert.equal(confirmed, false);
  child.emit('spawn');
  assert.equal(await started, 9876);
  assert.equal(detached, true);
  assert.throws(() => monitorSpawn('D:/fixture.json', 'agent-1', () => child), /Invalid shared monitor lease/);
  assert.throws(() => monitorSpawn(undefined, LEASE, () => child), /private configuration path/);
});

test('two watched directories each deliver their own event', async () => {
  const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'watch-'));
  const first = path.join(root, 'managed-host');
  const second = path.join(root, 'claude-sessions');
  await mkdir(first); await mkdir(second);
  const seen = [];
  const watchers = createDirectoryWatchers(directory => seen.push(directory));
  try {
    assert.equal(watchers.update([first, second]), 2, 'one watcher per directory');
    await writeFile(path.join(first, 'a.json'), '{}');
    await writeFile(path.join(second, 'b.json'), '{}');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.ok(seen.includes(first), `first directory delivered: ${seen.join(',')}`);
    assert.ok(seen.includes(second), `second directory delivered: ${seen.join(',')}`);
    assert.equal(watchers.update([first]), 1, 'a directory no longer wanted is closed');
  } finally { watchers.close(); }
});

test('the watch set covers the DSH host and the Claude registry', () => {
  const config = { stateDirectory: 'D:/state', hostBridgeFile: 'D:/state/host-bridge.json' };
  const directories = monitorDirectories(config, { env: { CLAUDE_CONFIG_DIR: 'D:/claude' }, exists: () => true });
  assert.deepEqual(directories, ['D:/state/managed-host', 'D:/claude/sessions'].map(normalize));
  // The roster directory is never watched: its -shm/-wal churn would echo our own
  // poll back at us. External commits are read from dataVersion() instead.
  assert.equal(directories.includes(normalize('D:/state')), false);
  // A directory that does not exist yet is skipped instead of breaking the watch.
  const filtered = monitorDirectories(config, { env: { CLAUDE_CONFIG_DIR: 'D:/claude' },
    exists: directory => !directory.includes('sessions') });
  assert.equal(filtered.some(directory => directory.includes('sessions')), false);
  // The managed host directory can be configured explicitly.
  const explicit = monitorDirectories({ stateDirectory: 'D:/state', managedStateDirectory: 'D:/host' },
    { env: { CLAUDE_CONFIG_DIR: 'D:/claude' }, exists: () => true });
  assert.ok(explicit.includes(normalize('D:/host')));
});

// A 60-second lease is a promise the listener can still write to it. A killed
// listener cannot, so its leases stay unexpired for up to a minute while nothing
// polls anything: reading the two leases alone reported that ghost as alive and
// started nothing. The identity row is the listener's own PID, so an unexpired
// lease whose process is gone is replaced at once instead of after the timeout.
test('a listener killed while its leases were still unexpired is replaced at once', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    const pid = await deadPid();
    crashedMonitor(store, pid);
    assert.equal(await monitorAlive(store), false, 'an unexpired lease whose process is gone is not a listener');
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, recorder), true);
    assert.equal(recorder.calls.length, 1, 'the dead listener is replaced exactly once');
    const owner = store.lease('idle-monitor');
    assert.ok(owner && owner.holder !== LEASE, 'the replacement holds a fresh holder lease');
    assert.equal(store.lease('idle-monitor:ready'), undefined, 'the dead listener cannot keep readiness');
    assert.equal(store.lease(PID_KEY), undefined, 'only the replacement worker registers itself');
  } finally { store.close(); }
});

test('a listener whose process is alive is never replaced', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    // This test process stands in for the listener: its PID is alive and verifiable.
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, process.pid, '100'), true);
    const startTime = () => '100';
    assert.equal(await monitorAlive(store, Date.now(), { startTime }), true);
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, { ...recorder, startTime }), true);
    assert.equal(recorder.calls.length, 0, 'a live listener is reused');
    assert.equal(store.lease('idle-monitor').holder, LEASE);
  } finally { store.close(); }
});

test('an unrelated live process with a reused PID cannot hold the monitor leases', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    const actual = await processStartTime(process.pid);
    assert.ok(actual, 'the fixture PID has an OS creation time');
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    // Model a dead monitor's identity retaining a PID now occupied by this test.
    store.claimLease(PID_KEY, `${LEASE}:${process.pid}:${BigInt(actual) - 1n}`, 60000);
    assert.equal(await monitorAlive(store), false);
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, recorder), true);
    assert.equal(recorder.calls.length, 1);
  } finally { store.close(); }
});

test('a start without readiness is being started, a paired row without an identity is not ensured', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    // Another caller claimed the holder lease a moment ago and is spawning: no
    // readiness yet, no identity yet. That is not a crash, it is a start in progress.
    store.claimLease('idle-monitor', LEASE, 30000);
    assert.equal(await monitorAlive(store), false, 'a listener without readiness is not up yet');
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, recorder), true);
    assert.equal(recorder.calls.length, 0, 'a start in progress is never doubled');
    // Both leases but no readable identity — an older build, a lapsed identity row, or a
    // row of another holder. The pair is unexpired and not stolen, but it is not an
    // ensured listener either: the caller is told so and keeps waiting on the lease.
    const counted = countingStore(store);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal((await monitorState(store)).reason, 'identity-unknown');
    assert.equal(await monitorAlive(store), false, 'liveness is unverified without a process identity');
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), counted.store, recorder), false,
      'an unexpired pair nobody can identify is not ensured');
    assert.equal(counted.claims, 1, 'the replacement was attempted');
    assert.equal(recorder.calls.length, 0, 'and refused by the CAS, not by a takeover');
    assert.deepEqual(counted.released, [], 'nothing of that holder is released');
    assert.equal(store.lease('idle-monitor').holder, LEASE);
    assert.equal(store.lease('idle-monitor:ready').holder, LEASE, 'its readiness rows stay with it');
  } finally { store.close(); }
});

test('a PID recorded for another holder never decides this listener', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    // A leftover row of a predecessor whose leases have already gone.
    store.claimLease(PID_KEY, `monitor-11111111-1111-4111-8111-111111111111:${await deadPid()}:100`, 60000);
    assert.equal(await monitorAlive(store), false, 'someone else’s PID says nothing about this holder');
    const counted = countingStore(store);
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), counted.store, recorder), false,
      'an identity row belonging to another holder does not vouch for this one');
    assert.equal(counted.claims, 1);
    assert.equal(recorder.calls.length, 0);
    assert.equal(store.lease('idle-monitor').holder, LEASE, 'and its rows are left alone');
  } finally { store.close(); }
});

test('the installation switch off keeps the old lease-only behaviour', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    crashedMonitor(store, await deadPid());
    const now = Date.now();
    // Off: the PID and its creation time are never asked about at all.
    const neverAsk = () => { throw new Error('the switch is off: no process query may run'); };
    assert.equal(await monitorAlive(store, now, { idleSessionCleanup: false, startTime: neverAsk }), true, 'off: the leases alone still mean alive');
    assert.equal((await monitorState(store, now, { idleSessionCleanup: false, isProcessAlive: neverAsk })).reason, 'lease');
    // The original function answered an unexpired holder lease before ever trying.
    const offCounted = countingStore(store);
    const offRecorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), offCounted.store, { ...offRecorder, idleSessionCleanup: false }), true);
    assert.equal(offCounted.claims, 0, 'off: no replacement is attempted at all');
    assert.equal(offRecorder.calls.length, 0, 'off: nothing is started for a lease that looks alive');
    const byConfig = spawnRecorder();
    assert.equal(await ensureSharedMonitor({ configFile: 'D:/fixture.json', idleSessionCleanup: false }, store, byConfig), true);
    assert.equal(byConfig.calls.length, 0, 'off: the configuration switch behaves the same way');
    // On again: the same rows are a crash, not a listener.
    assert.equal(await monitorAlive(store), false);
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, recorder), true);
    assert.equal(recorder.calls.length, 1);
  } finally { store.close(); }
});

test('concurrent callers replace a dead listener exactly once', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    crashedMonitor(store, await deadPid());
    const [first, second] = await Promise.all([
      ensureSharedMonitor(config('D:/fixture.json'), store, recorder),
      ensureSharedMonitor(config('D:/fixture.json'), store, recorder),
    ]);
    assert.deepEqual([first, second], [true, true]);
    assert.equal(recorder.calls.length, 1, 'one replacement, not one per caller');
  } finally { store.close(); }
});

/**
 * A store whose two decision points are observable: how often a replacement was
 * attempted, and which rows were released. Everything else is inherited unchanged.
 */
function countingStore(store) {
  const counted = { store: Object.create(store), claims: 0, released: [] };
  counted.store.claimLease = (key, holder, leaseMs) => {
    if (key === 'idle-monitor') counted.claims += 1;
    return store.claimLease(key, holder, leaseMs);
  };
  counted.store.releaseLease = (key, holder) => { counted.released.push(key); return store.releaseLease(key, holder); };
  return counted;
}

// The reviewer's probe: the PID exists, but its OS creation time comes back null, so the
// listener behind the leases cannot be told apart from a reused PID. That is not proof of
// life. It must not be reported alive, and starting one must not be skipped on the
// strength of the leases; the replacement claim has to be attempted and the lease CAS is
// what decides. A holder that is not proven dead keeps its rows: nothing is stolen.
test('a PID with no readable creation time is not alive, and starting a listener still tries', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, process.pid, '100'), true);
    const options = { isProcessAlive: () => true, startTime: async () => null };
    const state = await monitorState(store, Date.now(), options);
    assert.equal(state.alive, false, 'a PID nobody can identify is not reported alive');
    assert.equal(state.reason, 'identity-unverified');
    assert.equal(await monitorAlive(store, Date.now(), options), false);
    const counted = countingStore(store);
    const recorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), counted.store, { ...recorder, ...options }), false,
      'an unexpired row nobody can vouch for is not an ensured listener');
    assert.equal(counted.claims, 1, 'the replacement claim is attempted instead of being skipped');
    assert.equal(recorder.calls.length, 0, 'the CAS refuses an unexpired holder, so nothing starts');
    assert.deepEqual(counted.released, [], 'a holder that is not proven dead is never released');
    assert.equal(store.lease('idle-monitor').holder, LEASE, 'the holder lease is untouched');
    assert.equal(store.lease(PID_KEY).holder, `${LEASE}:${process.pid}:100`, 'its identity row is untouched');
    // An identity check that throws is the same unknown answer, not a replacement.
    const thrown = await monitorState(store, Date.now(), { isProcessAlive: () => true, startTime: () => { throw new Error('denied'); } });
    assert.deepEqual([thrown.alive, thrown.reason], [false, 'identity-unverified']);
  } finally { store.close(); }
});

// The refusal is only "not ensured" when it comes from the row that could not be read.
// A holder that won the claim in the meantime is a start in progress, and that keeps the
// older meaning: one is being started, so the answer is true.
test('a refusal from a holder that just took the claim is a start in progress', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, process.pid, '100'), true);
    const successor = 'monitor-22222222-2222-4222-8222-222222222222';
    const counted = countingStore(store);
    // Between the identity check and the claim, another caller takes the holder lease.
    counted.store.claimLease = (key, holder, leaseMs) => {
      if (key === 'idle-monitor') {
        counted.claims += 1;
        store.db.prepare('UPDATE leases SET holder=?,expires=? WHERE key=?').run(successor, Date.now() + 60000, 'idle-monitor');
        store.db.prepare('UPDATE leases SET holder=?,expires=? WHERE key=?').run(successor, Date.now() + 60000, 'idle-monitor:ready');
      }
      return store.claimLease(key, holder, leaseMs);
    };
    const recorder = spawnRecorder();
    const options = { isProcessAlive: () => true, startTime: async () => null };
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), counted.store, { ...recorder, ...options }), true,
      'a fresh holder is being started, so this is not a verified-but-unreadable row');
    assert.equal(counted.claims, 1);
    assert.equal(recorder.calls.length, 0, 'the new holder is left alone');
    assert.equal(store.lease('idle-monitor').holder, successor);
  } finally { store.close(); }
});

test('once that unidentifiable holder lease lapses, the attempted claim takes over', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, process.pid, '100'), true);
    const options = { isProcessAlive: () => true, startTime: async () => null };
    // Every row of that holder lapses: the worker is gone or hung, and now the CAS has
    // nothing to defend, so the attempted claim is the recovery.
    store.db.prepare('UPDATE leases SET expires=0').run();
    const counted = countingStore(store);
    const recorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), counted.store, { ...recorder, ...options }), true);
    assert.equal(counted.claims, 1);
    assert.equal(recorder.calls.length, 1, 'the lapsed holder is replaced exactly once');
    assert.notEqual(store.lease('idle-monitor').holder, LEASE);
  } finally { store.close(); }
});

// A pending release re-check used to stretch the quiet wait to a minute (idleMs * 12).
// That wait is the loop's own fallback for the whole-roster five-second sweep and the
// DSH sleeping-state scan, so while a re-check was pending those stopped running. The
// ceiling is now the earliest of the next sweep and the re-check itself.
test('a pending release re-check cannot defer the five-second sweep', () => {
  assert.equal(monitorWaitMs({ busy: false, idleMs: 5000, sweepInMs: 5000, releaseInMs: 30000 }), 5000,
    'a 30-second countdown may not outlive the next sweep');
  assert.equal(monitorWaitMs({ busy: false, idleMs: 5000, sweepInMs: 5000, releaseInMs: 90000 }), 5000,
    'a long countdown never becomes a minute');
  assert.equal(monitorWaitMs({ busy: false, idleMs: 5000, sweepInMs: 1200, releaseInMs: 30000 }), 1200,
    'the earliest moment wins');
  assert.equal(monitorWaitMs({ busy: false, idleMs: 5000, sweepInMs: 5000, releaseInMs: 2000 }), 2000,
    'a nearer re-check still shortens the wait');
  assert.equal(monitorWaitMs({ busy: false, idleMs: 5000, sweepInMs: 5000, releaseInMs: 0 }), 0,
    'a due re-check is immediate');
  assert.equal(monitorWaitMs({ busy: false, idleMs: 5000, sweepInMs: 5000 }), 5000,
    'no re-check pending: the idle cadence itself');
  assert.equal(monitorWaitMs({ busy: true, busyMs: 1000, idleMs: 5000, sweepInMs: 5000, releaseInMs: 30000 }), 1000,
    'busy keeps its own cadence');
  assert.equal(monitorWaitMs({ busy: false, idleMs: 5000, sweepInMs: 100, releaseInMs: 50, floorMs: 250 }), 250,
    'the round floor still wins over a shorter wait');
});

// Liveness is answered by one signal-0 syscall on the recorded PID. Only "no such
// process" proves death: anything the probe cannot answer keeps the leases in place, so
// an unrelated error can never replace a listener that is really running.
test('an unanswerable identity check leaves the lease in place', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, 4711, '100'), true);
    const denied = () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); };
    const options = { isProcessAlive: denied, startTime: () => null };
    const recorder = spawnRecorder();
    assert.equal(await monitorAlive(store, Date.now(), options), false);
    assert.equal((await monitorState(store, Date.now(), options)).reason, 'identity-unverified');
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, { ...recorder, ...options }), false,
      'unverified is not ensured, and the unexpired row is still not taken over');
    assert.equal(recorder.calls.length, 0);
    assert.equal((await monitorState(store, Date.now(), { isProcessAlive: () => false })).reason, 'process-gone');
    // The identity row is a lease too: once it lapses the PID is unknown again, not dead.
    store.db.prepare('UPDATE leases SET expires=0 WHERE key=?').run(MONITOR_PROCESS_LEASE);
    const lapsed = await monitorState(store, Date.now(), { isProcessAlive: () => false });
    assert.equal(lapsed.alive, false);
    assert.equal(lapsed.reason, 'identity-unknown');
  } finally { store.close(); }
});

test('the identity is one small lease row, renewed by its own worker and cleaned up with it', async () => {
  const store = new RosterStore(':memory:');
  try {
    // Only the listener that owns the holder lease may label it.
    assert.equal(recordMonitorPid(store, LEASE, 4321, '100'), false, 'no holder lease, no identity');
    store.claimLease('idle-monitor', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, 0, '100'), false, 'a PID has to be a positive integer');
    assert.equal(recordMonitorPid(store, LEASE, undefined), false);
    assert.equal(recordMonitorPid(store, 'agent-1', 4321, '100'), false, 'only the current monitor holder records an identity');
    assert.equal(recordMonitorPid(store, LEASE, 4321, '100'), true);
    assert.deepEqual(monitorProcess(store, LEASE), { holder: `${LEASE}:4321:100`, pid: 4321, procStart: '100' });
    assert.equal(monitorProcess(store, 'monitor-11111111-1111-4111-8111-111111111111'), undefined, 'read by holder');
    const before = store.lease(MONITOR_PROCESS_LEASE).expires;
    assert.equal(renewMonitorPid(store, LEASE, 4321, '100'), true);
    assert.ok(store.lease(MONITOR_PROCESS_LEASE).expires >= before, 'the heartbeat keeps it inside its window');
    assert.equal(renewMonitorPid(store, LEASE, 9999, '100'), false, 'a different PID cannot renew it');
    assert.equal(renewMonitorPid(store, LEASE, 4321, '101'), false, 'a reused PID cannot renew it');
    // A leftover row of a predecessor whose leases are gone must not keep this worker
    // unidentifiable for its remaining minute: the new owner takes the row over.
    store.releaseLease('idle-monitor', LEASE);
    const next = 'monitor-22222222-2222-4222-8222-222222222222';
    store.claimLease('idle-monitor', next, 60000);
    assert.ok(store.lease(MONITOR_PROCESS_LEASE).expires > Date.now(), 'the predecessor row is still inside its window');
    assert.equal(recordMonitorPid(store, next, 5555, '200'), true);
    assert.deepEqual(monitorProcess(store, next), { holder: `${next}:5555:200`, pid: 5555, procStart: '200' });
    store.releaseLease(MONITOR_PROCESS_LEASE, `${next}:5555:200`);
    assert.equal(monitorProcess(store, next), undefined, 'a listener that exits leaves no identity behind');
  } finally { store.close(); }
});

test('a listener that exited before it reported ready is recovered the same way', async () => {
  const store = new RosterStore(':memory:');
  try {
    const recorder = spawnRecorder();
    // Confirmed spawn, identity recorded, then the worker died before its first claim of
    // the readiness lease: no lease pair, but the process question still has an answer.
    store.claimLease('idle-monitor', LEASE, 30000);
    assert.equal(recordMonitorPid(store, LEASE, await deadPid(), '100'), true);
    assert.equal((await monitorState(store)).reason, 'process-gone');
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, recorder), true);
    assert.equal(recorder.calls.length, 1, 'the early exit is replaced once, at once');
    assert.notEqual(store.lease('idle-monitor').holder, LEASE);
  } finally { store.close(); }
});

test('a late spawn confirmation never labels the successor', async () => {
  const store = new RosterStore(':memory:');
  try {
    const successor = 'monitor-22222222-2222-4222-8222-222222222222';
    // A claimed and spawned; its confirmation arrives after A's lease lapsed and a
    // successor took over and identified itself.
    store.claimLease('idle-monitor', LEASE, 30000);
    store.db.prepare('UPDATE leases SET expires=0 WHERE key=?').run('idle-monitor');
    store.claimLease('idle-monitor', successor, 60000);
    store.claimLease('idle-monitor:ready', successor, 60000);
    assert.equal(recordMonitorPid(store, successor, process.pid, '200'), true);
    assert.equal(recordMonitorPid(store, LEASE, 4242, '100'), false, 'a stale holder cannot record an identity');
    assert.deepEqual(monitorProcess(store, successor), { holder: `${successor}:${process.pid}:200`, pid: process.pid, procStart: '200' },
      'the successor keeps its own identity');
    assert.equal(await monitorAlive(store, Date.now(), { startTime: () => '200' }), true, 'the successor is alive and untouched');
  } finally { store.close(); }
});

test('an old registration cannot overwrite the successor after a second connection takes over', async () => {
  const { root, store } = await workerFixture({});
  const peer = new RosterStore(path.join(root, 'state', 'roster.sqlite'));
  try {
    const successor = 'monitor-22222222-2222-4222-8222-222222222222';
    store.claimLease('idle-monitor', LEASE, 60000);
    let replaced = false;
    const takeover = () => {
      if (replaced) return;
      replaced = true;
      peer.releaseLease('idle-monitor', LEASE);
      assert.equal(peer.claimLease('idle-monitor', successor, 60000), true);
      assert.equal(recordMonitorPid(peer, successor, process.pid, '200'), true);
    };
    const read = store.lease.bind(store);
    store.lease = key => {
      const row = read(key);
      if (key === 'idle-monitor') takeover();
      return row;
    };
    if (typeof store.claimLeaseWhileHeld === 'function') {
      const claim = store.claimLeaseWhileHeld.bind(store);
      store.claimLeaseWhileHeld = (...args) => { takeover(); return claim(...args); };
    }
    assert.equal(recordMonitorPid(store, LEASE, 4242, '100'), false);
    assert.equal(replaced, true);
    assert.equal(renewMonitorPid(peer, successor, process.pid, '200'), true);
  } finally { peer.close(); store.close(); }
});

/**
 * A freshly created listener of our own: the caller claims the holder lease exactly as
 * ensureSharedMonitor does, then starts the real worker with that holder. No installed,
 * running or in-use process is ever touched.
 */
async function startWorker(store, configFile, settings = {}) {
  store.claimLease('idle-monitor', LEASE, 30000);
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'scoped-worker.mjs');
  const worker = spawn(process.execPath, [script, '--config', configFile, '--lease', LEASE],
    { stdio: 'ignore', windowsHide: true });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && !store.leaseHeld('idle-monitor:ready', LEASE)) await tick(100);
  assert.equal(store.leaseHeld('idle-monitor:ready', LEASE), true, 'the fixture listener reported ready');
  return worker;
}

async function workerFixture(settings) {
  const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'monitor-identity-'));
  const configFile = path.join(root, 'config.json');
  await writeFile(configFile, JSON.stringify({ workspace: root, reportPort: 0, ...settings }), 'utf8');
  return { root, configFile, store: new RosterStore(path.join(root, 'state', 'roster.sqlite')) };
}

// A sleeping name is woken from the listener's own process, and that path asks
// ensureSharedMonitor whether a listener exists. Asked about itself, the verification is
// a PowerShell creation-time query for its own PID: 1.3s idle and up to 2.7s under load,
// spent inside the round that owes the answering. Running is the answer, so the wake has
// to stay inside the one file-event second the cadence promises.
test('a wake inside the listener’s own process answers within the file-event second', async () => {
  const { root, configFile, store } = await workerFixture({ target: 'dsh' });
  const hostDirectory = path.join(root, 'managed-host');
  await mkdir(hostDirectory, { recursive: true });
  await mkdir(path.join(root, 'claude', 'sessions'), { recursive: true });
  const owner = 'owner-wake';
  const waiting = { agentId: 'agent-wake', ownerId: owner, name: 'wake', sessionId: 'session-wake',
    state: 'awaiting_report', lifetime: 'persistent',
    task: { taskId: 'task-wake', message: 'wait', state: 'awaiting_report', dispatches: [], answers: [], reports: [] } };
  const sleepFile = path.join(hostDirectory, `${createHash('sha256').update(`${owner}\n${waiting.agentId}`).digest('hex')}.json`);
  const sleeping = question => ({ ownerId: owner, agentId: waiting.agentId, sessionId: waiting.sessionId,
    taskId: 'task-wake', throughSeq: 0, questions: [{ id: 'q-1', state: question }], reports: [] });
  store.saveOwner({ ownerId: owner, workspace: root, createdAt: new Date().toISOString() });
  store.insert({ ...waiting, sleep: { taskId: 'task-wake', sessionId: waiting.sessionId, signal: idleSignal(sleeping('a')) } });
  await writeFile(sleepFile, JSON.stringify(sleeping('a')), 'utf8');
  const worker = await startWorker(store, configFile);
  try {
    await tick(1200);
    assert.ok(store.get('agent-wake')?.sleep, 'the fixture name is asleep and agrees with its host state');
    // The host writes a new state: that file event is what the round must answer.
    const started = Date.now();
    await writeFile(sleepFile, JSON.stringify(sleeping('b')), 'utf8');
    while (Date.now() - started < 6000 && store.get('agent-wake')?.sleep) await tick(20);
    const elapsed = Date.now() - started;
    assert.equal(store.get('agent-wake')?.sleep, undefined, 'the sleeping name was woken');
    assert.ok(elapsed <= 1000, `the wake is answered inside the file-event second (took ${elapsed}ms)`);
  } finally {
    try { worker.kill(); } catch { /* already gone */ }
    store.close();
  }
});

/**
 * A store whose snapshot calls can be interleaved: the Nth `leases()` runs `before` once,
 * just before reading, so a second connection can commit between two calls. Everything
 * else is the real store.
 */
function snapshotStore(store, before) {
  const counted = { store: Object.create(store), snapshots: 0, claims: 0, released: [] };
  counted.store.leases = keys => { counted.snapshots += 1; if (before) before(counted.snapshots); return store.leases(keys); };
  counted.store.claimLease = (key, holder, leaseMs) => {
    if (key === 'idle-monitor') counted.claims += 1;
    return store.claimLease(key, holder, leaseMs);
  };
  counted.store.releaseLease = (key, holder) => { counted.released.push(key); return store.releaseLease(key, holder); };
  return counted;
}

async function livePid() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  await new Promise((started, failed) => { child.once('spawn', started); child.once('error', failed); });
  return child;
}

async function rosterFile() {
  const base = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.runtime', 'tests');
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, 'monitor-race-'));
  return path.join(root, 'roster.sqlite');
}

// The creation-time query is asynchronous. A second connection can replace the listener
// while it runs: the rows the answer was computed from are gone, and a successor owns the
// leases. The late answer must not be reported as a live listener — the rows are read
// again, and what is trusted is what is there now.
test('a listener replaced while its identity check ran is not reported alive', async () => {
  const file = await rosterFile();
  const store = new RosterStore(file), peer = new RosterStore(file);
  const child = await livePid();
  const successor = 'monitor-22222222-2222-4222-8222-222222222222';
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, child.pid, '100'), true);
    let answer;
    const pending = new Promise(resolve => { answer = resolve; });
    const startTime = pid => (pid === child.pid ? pending : '200');
    const statePromise = monitorState(store, Date.now(), { isProcessAlive: () => true, startTime });
    await tick(50);
    // The other connection takes over while the query is still running.
    peer.releaseLease('idle-monitor:ready', LEASE);
    peer.releaseLease('idle-monitor:pid', `${LEASE}:${child.pid}:100`);
    peer.releaseLease('idle-monitor', LEASE);
    peer.claimLease('idle-monitor', successor, 60000);
    peer.claimLease('idle-monitor:ready', successor, 60000);
    assert.equal(recordMonitorPid(peer, successor, process.pid, '200'), true);
    answer('100'); // the answer about the old identity arrives late
    const state = await statePromise;
    assert.notEqual(state.holder, LEASE, 'the replaced holder is never reported');
    assert.equal(state.alive, true, 'the successor is alive on its own identity');
    assert.equal(state.reason, 'process');
    assert.equal(state.pid, process.pid);
    assert.deepEqual(monitorProcess(store, successor), { holder: `${successor}:${process.pid}:200`, pid: process.pid, procStart: '200' },
      'the successor identity row is untouched');
  } finally { child.kill(); peer.close(); store.close(); }
});

// The same interleaving, on the other verdict: the identity check says the old listener is
// gone, and only then does a successor arrive. The release must be decided on rows that
// are still the ones the verdict came from — a stale PID may never clear a new holder's
// identity, and the successor's leases are left alone.
test('a stale dead verdict never clears a successor that arrived meanwhile', async () => {
  const file = await rosterFile();
  const store = new RosterStore(file), peer = new RosterStore(file);
  const dead = await deadPid();
  const successor = 'monitor-33333333-3333-4333-8333-333333333333';
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, dead, '100'), true);
    const counted = snapshotStore(store, count => {
      if (count !== 3) return; // between the verdict and the release
      peer.releaseLease('idle-monitor:ready', LEASE);
      peer.releaseLease('idle-monitor:pid', `${LEASE}:${dead}:100`);
      peer.releaseLease('idle-monitor', LEASE);
      peer.claimLease('idle-monitor', successor, 60000);
      peer.claimLease('idle-monitor:ready', successor, 60000);
      recordMonitorPid(peer, successor, process.pid, '200');
    });
    const recorder = spawnRecorder();
    const state = await monitorState(store, Date.now(), { isProcessAlive: () => false });
    assert.deepEqual([state.reason, state.holder], ['process-gone', LEASE], 'the stale verdict is about the old holder');
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), counted.store,
      { ...recorder, isProcessAlive: () => false }), true, 'the successor holds the leases, so nothing is started');
    assert.deepEqual(counted.released, [], 'no row of the successor is released');
    assert.deepEqual(monitorProcess(store, successor), { holder: `${successor}:${process.pid}:200`, pid: process.pid, procStart: '200' },
      'its identity row survives the stale verdict');
    assert.equal(store.lease('idle-monitor').holder, successor);
    assert.equal(store.lease('idle-monitor:ready').holder, successor);
    assert.equal(recorder.calls.length, 0, 'and no second listener is spawned');
    assert.equal(counted.claims, 1, 'the claim was attempted and refused by the successor');
  } finally { peer.close(); store.close(); }
});

// The verification is asynchronous, and a lease can lapse while it runs: the worker stops
// renewing and then dies without cleaning up, so the holder's rows are still there, still
// named by the same holder, only expired. Comparing holders alone would report that as a
// live listener. The re-read decides on live rows at their own moment, not just on names.
test('a lease that lapses while its identity check runs is not reported alive', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(recordMonitorPid(store, LEASE, process.pid, '100'), true);
    let lapsed = false;
    const startTime = () => {
      if (!lapsed) {
        lapsed = true;
        // Same holder, same rows, no renewal: they expire during the query.
        store.db.prepare('UPDATE leases SET expires=? WHERE key IN (?,?,?)')
          .run(Date.now() - 1, 'idle-monitor', 'idle-monitor:ready', MONITOR_PROCESS_LEASE);
      }
      return '100';
    };
    const state = await monitorState(store, Date.now(), { isProcessAlive: () => true, startTime });
    assert.equal(state.alive, false, 'a lapsed lease is not alive, even with the same holder still named');
    assert.equal(state.reason, 'lease-not-ready');
    assert.equal(store.lease('idle-monitor').holder, LEASE, 'the row was kept, not released by the check');
    // And nothing resurrects it: the CAS is free again, so one replacement starts.
    const recorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store,
      { ...recorder, isProcessAlive: () => true, startTime }), true);
    assert.equal(recorder.calls.length, 1, 'the lapsed holder is replaced exactly once');
    assert.notEqual(store.lease('idle-monitor').holder, LEASE);
  } finally { store.close(); }
});

// The counterpart: the same holder renewing its own rows during the check is not a change
// of ownership, and the listener is still the one that answered.
test('a renewal by the same holder during its identity check stays alive', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.claimLease('idle-monitor', LEASE, 5000);
    store.claimLease('idle-monitor:ready', LEASE, 5000);
    assert.equal(recordMonitorPid(store, LEASE, process.pid, '100', 5000), true);
    let renewed = false;
    const startTime = () => {
      if (!renewed) {
        renewed = true;
        store.renewLease('idle-monitor', LEASE, 60000);
        store.renewLease('idle-monitor:ready', LEASE, 60000);
        store.renewLease(MONITOR_PROCESS_LEASE, `${LEASE}:${process.pid}:100`, 60000);
      }
      return '100';
    };
    const state = await monitorState(store, Date.now(), { isProcessAlive: () => true, startTime });
    assert.deepEqual([state.alive, state.reason], [true, 'process'], 'the same holder that renewed is still the listener');
    const recorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store,
      { ...recorder, isProcessAlive: () => true, startTime }), true);
    assert.equal(recorder.calls.length, 0);
  } finally { store.close(); }
});

test('the real worker records its own PID and creation time, and a killed worker is replaced once', async () => {
  const { configFile, store } = await workerFixture({});
  const worker = await startWorker(store, configFile);
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && monitorProcess(store, LEASE)?.pid !== worker.pid) await tick(100);
    assert.equal(monitorProcess(store, LEASE)?.pid, worker.pid, 'the worker writes its own PID');
    const startedAt = await processStartTime(worker.pid);
    assert.ok(startedAt);
    assert.equal(monitorProcess(store, LEASE).procStart, startedAt);
    assert.equal(await monitorAlive(store), true, 'the running worker owns its recorded process identity');
    worker.kill();
    await new Promise(ended => worker.once('exit', ended));
    assert.equal(processAlive(worker.pid), false, 'the fixture listener is gone');
    assert.ok(store.lease('idle-monitor').expires > Date.now(), 'its holder lease outlives the process');
    assert.equal(await monitorAlive(store), false, 'an unexpired lease from a killed worker is not a listener');
    const recorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor({ configFile }, store, recorder), true);
    assert.equal(recorder.calls.length, 1, 'the killed worker is replaced once, at once');
    const owner = store.lease('idle-monitor');
    assert.notEqual(owner.holder, LEASE);
    assert.equal(store.lease(PID_KEY), undefined, 'the launcher leaves identity registration to the replacement');
  } finally {
    try { worker.kill(); } catch { /* already gone */ }
    store.close();
  }
});

test('with the installation switch off the worker keeps no identity and a dead one is waited out', async () => {
  const { configFile, store } = await workerFixture({ idleSessionCleanup: false });
  const worker = await startWorker(store, configFile);
  try {
    await tick(1500); // every chance to write the row it must not write
    assert.equal(store.lease(PID_KEY), undefined, 'switch off: the worker writes no identity row');
    assert.equal(await monitorAlive(store, Date.now(), { idleSessionCleanup: false }), true, 'switch off: the leases are the only evidence');
    worker.kill();
    await new Promise(ended => worker.once('exit', ended));
    assert.equal(await monitorAlive(store, Date.now(), { idleSessionCleanup: false }), true, 'switch off: the unexpired leases still read as alive');
    const recorder = spawnRecorder();
    assert.equal(await ensureSharedMonitor({ configFile, idleSessionCleanup: false }, store, recorder), true);
    assert.equal(recorder.calls.length, 0, 'switch off: the original lease path starts nothing');
    assert.equal(store.lease('idle-monitor').holder, LEASE, 'the original holder lease is left as it was');
  } finally {
    try { worker.kill(); } catch { /* already gone */ }
    store.close();
  }
});

test('a listener is only alive while one holder owns both leases', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    const alive = () => monitorAlive(store, Date.now(), { idleSessionCleanup: false });
    assert.equal(await alive(), true);
    store.db.prepare('UPDATE leases SET holder=? WHERE key=?').run('monitor-11111111-1111-4111-8111-111111111111', 'idle-monitor:ready');
    assert.equal(await alive(), false, 'a readiness lease from another holder is not our listener');
    store.db.prepare('UPDATE leases SET expires=0 WHERE key=?').run('idle-monitor');
    assert.equal(await alive(), false, 'an expired holder is not alive');
  } finally { store.close(); }
});
