// A real scoped-worker.mjs process, on a synthetic roster in a temporary directory.
// Nothing here touches the live roster, the live managed-host directory or any real
// chat: every path is under a temp directory and the only outbound call the worker
// can make is to a DSH host that does not exist.
//
//   node scripts/worker-smoke.mjs [--out report.json]
//
// Checks: quiet cadence, file event -> poll within a second, another process commit
// -> reaction within a second, no self-driven hot loop, the lease survives past its
// own heartbeat (70s+), and the process retires after its idle dwell.
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { RosterStore } from '../src/roster-store.mjs';
import { idleSignal } from '../src/idle-monitor.mjs';

const argv = process.argv.slice(2);
const outFile = argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

const root = mkdtempSync(path.join(os.tmpdir(), 'futureaide-smoke-'));
const configFile = path.join(root, 'config.json');
const stateDirectory = path.join(root, 'state');
const hostDirectory = path.join(root, 'managed-host');
const claudeDirectory = path.join(root, 'claude');
for (const directory of [stateDirectory, hostDirectory, path.join(claudeDirectory, 'sessions')]) mkdirSync(directory, { recursive: true });
const recordFile = name => path.join(stateDirectory, 'roster.sqlite');

const port = await freePort();
writeFileSync(configFile, JSON.stringify({
  target: 'dsh',
  dataRoot: path.join(root, 'dsh'),
  dshDataRoot: path.join(root, 'dsh'),
  hostBridgeFile: path.join(root, 'host-bridge.json'),
  managedStateDirectory: hostDirectory,
  reportPort: port,
}));

const OWNER = 'owner-smoke';
const waiter = { agentId: 'agent-waiter', ownerId: OWNER, name: 'waiter', sessionId: 'session-waiter',
  state: 'awaiting_report', lifetime: 'persistent',
  task: { taskId: 'task-waiter', message: 'wait', state: 'awaiting_report', dispatches: [], answers: [], reports: [] } };
const quiet = { agentId: 'agent-quiet', ownerId: OWNER, name: 'quiet', sessionId: 'session-quiet',
  state: 'idle', lifetime: 'persistent', task: { taskId: 'task-quiet', message: 'done', state: 'idle', dispatches: [], answers: [], reports: [] } };

const store = new RosterStore(recordFile('roster'));
store.saveOwner({ ownerId: OWNER, workspace: root, createdAt: new Date().toISOString() });
const sleepFile = path.join(hostDirectory, `${createHash('sha256').update(`${OWNER}\n${waiter.agentId}`).digest('hex')}.json`);
const sleepingState = (questionState) => ({ ownerId: OWNER, agentId: waiter.agentId, sessionId: waiter.sessionId,
  taskId: 'task-waiter', throughSeq: 0, questions: [{ id: 'q-1', state: questionState }], reports: [] });
store.insert({ ...waiter, sleep: { taskId: 'task-waiter', sessionId: waiter.sessionId, signal: idleSignal(sleepingState('a')) } });
store.insert(quiet);
writeFileSync(sleepFile, JSON.stringify(sleepingState('a')));

const holder = `monitor-${randomUUID()}`;
const started = Date.now();
const lines = [];
const child = spawn(process.execPath, [path.join('src', 'scoped-worker.mjs'), '--config', configFile, '--lease', holder], {
  cwd: process.cwd(),
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, FUTUREAIDE_MONITOR_TRACE: '1', CLAUDE_CONFIG_DIR: claudeDirectory },
});
let exited;
const done = new Promise(resolve => { child.on('exit', code => { exited = { code, at: Date.now() }; resolve(); }); });
const rounds = [];
child.stderr.on('data', chunk => {
  for (const line of String(chunk).split('\n')) {
    if (!line.includes('round=')) { if (line.trim()) lines.push(line.trim()); continue; }
    const round = { at: Date.now() };
    for (const [, key, value] of line.matchAll(/(\w+)=([\w-]+)/g)) round[key] = Number(value);
    rounds.push(round);
  }
});
// The spawner owns the holder lease; the worker only reads it every round and renews
// it from its own heartbeat.
store.claimLease('idle-monitor', holder, 60000);

const checks = {};
const waitForRoundSince = async (since, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const round = rounds.find(item => item.at >= since);
    if (round) return round.at - since;
    await sleep(20);
  }
  return null;
};

// 1. Quiet cadence and no self-driven hot loop. The first rounds are the boot pair.
await sleep(12000);
const quietRounds = rounds.filter(round => round.at - started < 12000).slice(2);
checks.quietRoundsIn12s = quietRounds.length;
checks.quietGapMs = quietRounds.length > 1
  ? Math.round((quietRounds.at(-1).at - quietRounds[0].at) / (quietRounds.length - 1)) : null;
checks.hotLoop = quietRounds.length > 8;

// 2. A commit from another process is noticed within a second, in the quiet phase.
const beforeCommit = Date.now();
const other = new RosterStore(recordFile('roster'));
const changed = other.get(quiet.agentId); changed.observation = { questions: [], tree: { settled: true } };
other.save(changed);
const commitRound = await waitForRoundSince(beforeCommit + 1, 3000);
// The round that answers a commit must be the sweeping one: a commit nobody announced
// cannot be turned into a named hint, so it has to sweep rather than wait its turn.
await sleep(1200);
other.close();
checks.commitToRoundMs = commitRound;
const commitRounds = rounds.filter(round => round.at >= beforeCommit - 2).slice(0, 3);
checks.commitRoundSweeps = commitRounds.some(round => round.sweep === 1);
checks.commitNoticed = commitRounds.some(round => round.external === 1 || round.sweep === 1);

// 3. A file event that names one record reaches a poll within a second.
const beforeWake = Date.now();
writeFileSync(sleepFile, JSON.stringify(sleepingState('b')));
const wakeRound = await waitForRoundSince(beforeWake, 3000);
const woken = () => store.get(waiter.agentId)?.sleep === undefined;
const wakeDelay = wakeRound;
if (wakeDelay !== null) {
  const deadline = Date.now() + 2000;
  while (!woken() && Date.now() < deadline) await sleep(20);
}
checks.fileEventToRoundMs = wakeDelay;
checks.fileEventToWake = woken();
// 3b. After the wake the loop polls once and then goes quiet: it must not answer a
// single event with a burst of rounds, and it must not wait out the whole sweep either.
const wakeAt = rounds.find(round => round.at >= beforeWake)?.at ?? beforeWake;
checks.roundsAfterWakeIn2s = rounds.filter(round => round.at > wakeAt && round.at <= wakeAt + 2000).length;

// 4. The lease outlives its own heartbeat window, sampled until 75s of life.
checks.leaseSamples = [];
while (Date.now() - started < 75000) {
  const lease = store.lease('idle-monitor');
  checks.leaseSamples.push({ atMs: Date.now() - started, expiresInMs: lease ? lease.expires - Date.now() : null, holder: lease?.holder ?? null });
  await sleep(5000);
}
checks.leaseHeldThroughout = checks.leaseSamples.every(sample => sample.expiresInMs > 0 && sample.holder === holder);
checks.roundsIn75s = rounds.length;

// 5. Nothing left to watch: the process must retire after its idle dwell.
const waited = store.get(waiter.agentId);
if (waited) store.remove(waited);
const closed = store.get(quiet.agentId);
closed.state = 'idle'; closed.closed = true;
store.save(closed);
const retireFrom = Date.now();
const timeout = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 45000);
await done;
clearTimeout(timeout);
checks.exitCode = exited?.code ?? null;
checks.exitDelayMs = exited ? exited.at - retireFrom : null;
checks.traceLines = lines.slice(0, 5);

const result = { root, port, rounds: rounds.length, ...checks };
console.log(JSON.stringify(result, null, 2));
store.close();
if (outFile) writeFileSync(path.resolve(outFile), JSON.stringify(result, null, 2));
const ok = !checks.hotLoop && checks.fileEventToRoundMs !== null && checks.fileEventToRoundMs <= 1000
  && checks.fileEventToWake && checks.roundsAfterWakeIn2s >= 1 && checks.roundsAfterWakeIn2s <= 5 && checks.commitToRoundMs !== null && checks.commitToRoundMs <= 1200 && checks.commitRoundSweeps && checks.commitNoticed
  && checks.leaseHeldThroughout && checks.exitCode === 0 && checks.exitDelayMs !== null && checks.exitDelayMs <= 40000;
if (!ok) process.exitCode = 1;
