import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { RosterStore } from '../src/roster-store.mjs';
import { ensureSharedMonitor, monitorAlive, monitorDirectories, monitorSpawn } from '../src/shared-monitor.mjs';

const LEASE = 'monitor-00000000-0000-4000-8000-000000000000';
const config = configFile => ({ configFile });
const normalize = value => resolve(value);

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
    assert.equal(monitorAlive(store), true);
    assert.equal(await ensureSharedMonitor(config('D:/fixture.json'), store, recorder), true);
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

test('the watch set covers the DSH host, the Claude registry and every binding', () => {
  const config = { stateDirectory: 'D:/state', hostBridgeFile: 'D:/state/host-bridge.json' };
  const directories = monitorDirectories(config, { env: { CLAUDE_CONFIG_DIR: 'D:/claude' }, exists: () => true,
    bindings: ['D:/claude/projects/p1/session-a.jsonl', 'D:/claude/projects/p2/session-b.jsonl'] });
  assert.deepEqual(directories, ['D:/state/managed-host', 'D:/claude/sessions',
    'D:/claude/projects/p1', 'D:/claude/projects/p2'].map(normalize));
  // The roster directory is never watched: its -shm/-wal churn would echo our own
  // poll back at us. External commits are read from dataVersion() instead.
  assert.equal(directories.includes(normalize('D:/state')), false);
  // A directory that does not exist yet is skipped instead of breaking the watch.
  const filtered = monitorDirectories(config, { env: { CLAUDE_CONFIG_DIR: 'D:/claude' },
    exists: directory => !directory.includes('projects'), bindings: ['D:/claude/projects/p1/session-a.jsonl'] });
  assert.equal(filtered.some(directory => directory.includes('projects')), false);
  // The managed host directory can be configured explicitly.
  const explicit = monitorDirectories({ stateDirectory: 'D:/state', managedStateDirectory: 'D:/host' },
    { env: { CLAUDE_CONFIG_DIR: 'D:/claude' }, exists: () => true });
  assert.ok(explicit.includes(normalize('D:/host')));
});

test('a listener is only alive while one holder owns both leases', async () => {
  const store = new RosterStore(':memory:');
  try {
    store.claimLease('idle-monitor', LEASE, 60000);
    store.claimLease('idle-monitor:ready', LEASE, 60000);
    assert.equal(monitorAlive(store), true);
    store.db.prepare('UPDATE leases SET holder=? WHERE key=?').run('monitor-11111111-1111-4111-8111-111111111111', 'idle-monitor:ready');
    assert.equal(monitorAlive(store), false, 'a readiness lease from another holder is not our listener');
    store.db.prepare('UPDATE leases SET expires=0 WHERE key=?').run('idle-monitor');
    assert.equal(monitorAlive(store), false, 'an expired holder is not alive');
  } finally { store.close(); }
});
