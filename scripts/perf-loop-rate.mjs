// Rounds and polls per second of a real scoped-worker process, measured the same way as
// the live one: precise coverage over the inspector, on a synthetic roster in a temp
// directory. Same load for `--src` and `--src <before copy>`, so the two numbers differ
// only by the loop rules.
//
//   node scripts/perf-loop-rate.mjs --src <dir> --names 6 --seconds 20
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[index + 1] : fallback;
};
const srcDir = path.resolve(option('src', 'src'));
const names = Number(option('names', 6));
const seconds = Number(option('seconds', 20));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const { RosterStore } = await import(pathToFileURL(path.join(srcDir, 'roster-store.mjs')).href);

const root = mkdtempSync(path.join(os.tmpdir(), 'fa-loop-'));
const stateDir = path.join(root, 'state'), hostDir = path.join(root, 'managed-host'), claude = path.join(root, 'claude');
for (const directory of [stateDir, hostDir, path.join(claude, 'sessions')]) mkdirSync(directory, { recursive: true });
const inspectPort = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
});
const port = await new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
});
const configFile = path.join(root, 'config.json');
writeFileSync(configFile, JSON.stringify({ target: 'dsh', dataRoot: path.join(root, 'dsh'), dshDataRoot: path.join(root, 'dsh'),
  hostBridgeFile: path.join(root, 'host-bridge.json'), managedStateDirectory: hostDir, reportPort: port }));

const store = new RosterStore(path.join(stateDir, 'roster.sqlite'));
store.saveOwner({ ownerId: 'owner-loop', workspace: root, createdAt: new Date().toISOString() });
// Every name owes a delivery that can never land: the channel does not exist. A real
// monitor keeps coming back to these, which is exactly the load being compared.
for (let index = 0; index < names; index += 1) {
  store.insert({ agentId: `agent-${index}`, ownerId: 'owner-loop', name: `worker-${index}`, sessionId: `session-${index}`,
    state: 'running', lifetime: 'persistent',
    observation: { throughSeq: index, tree: { settled: false, running: true }, questions: [], reports: [], filler: 'x'.repeat(40000) },
    task: { taskId: `task-${index}`, message: 'm', state: 'running', dispatches: [], answers: [],
      reports: [{ id: `report-${index}`, final: true, message: 'done', delivery: { state: 'pending' } }] } });
}
store.close();

const holder = `monitor-${randomUUID()}`;
// The spawner owns the holder lease; the worker only reads it every round.
const control = new RosterStore(path.join(stateDir, 'roster.sqlite'));
control.claimLease('idle-monitor', holder, 600000);
const child = spawn(process.execPath, [path.join(srcDir, 'scoped-worker.mjs'), '--config', configFile, '--lease', holder],
  // The live monitor already holds 9229; this worker gets its own inspector port so the
  // measurement can only ever attach to the process it started.
  { cwd: srcDir, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CLAUDE_CONFIG_DIR: claude, FUTUREAIDE_MONITOR_TRACE: '1', NODE_OPTIONS: `--inspect-port=${inspectPort}` } });
const tail = [];
child.stderr.on('data', chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) tail.push(line.trim()); });
await sleep(3000);
if (!child.pid || child.exitCode !== null) throw new Error(`worker did not stay up: ${tail.join(' | ')}`);

// Attach exactly like the live measurement.
process._debugProcess(child.pid);
const base = `http://127.0.0.1:${inspectPort}`;
let targets;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { const list = await (await fetch(`${base}/json/list`)).json(); if (list?.length) { targets = list; break; } } catch { /* retry */ }
  await sleep(250);
}
if (!targets) throw new Error('inspector not reachable');
const socket = new WebSocket(targets[0].webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
socket.addEventListener('message', event => {
  let message; try { message = JSON.parse(event.data); } catch { return; }
  if (!message.id || !pending.has(message.id)) return;
  const { resolve, reject } = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('ws error')), { once: true });
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
await send('Profiler.enable');
const startedAt = Date.now();
await send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
await sleep(seconds * 1000);
const { result } = await send('Profiler.takePreciseCoverage');
await send('Profiler.stopPreciseCoverage');
const elapsed = (Date.now() - startedAt) / 1000;

const count = (name) => {
  let total = 0;
  for (const script of result ?? []) {
    if (!(script.url || '').includes('futureaide-control')) continue;
    for (const fn of script.functions ?? []) {
      if (fn.functionName === name && fn.ranges?.[0]) total += fn.ranges[0].count;
    }
  }
  return total;
};
const rounds = count('monitorScan'), polls = count('pollLocked');
const output = { src: srcDir, names, seconds: Number(elapsed.toFixed(1)),
  roundsPerSecond: Number((rounds / elapsed).toFixed(2)), pollsPerSecond: Number((polls / elapsed).toFixed(2)),
  pollsPerRound: rounds ? Number((polls / rounds).toFixed(2)) : null,
  traceRounds: tail.filter(line => line.includes('round=')).length, traceTail: tail.slice(-16) };
console.log(JSON.stringify(output, null, 2));
socket.close();
try { child.kill(); } catch { /* gone */ }
await sleep(300);
try { control.close(); } catch { /* closed */ }
