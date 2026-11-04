// Count what the running shared monitor actually calls, without restarting it.
//
//   node scripts/perf-coverage.mjs <pid> <seconds> <out.json>
//
// Opens the inspector on the running process (process._debugProcess), asks V8 for
// best-effort precise coverage (call counts, not detailed ranges), waits, and reports
// per-function call counts for the functions a round is made of.
const [pidArg, secondsArg, outArg] = process.argv.slice(2);
const pid = Number(pidArg);
const seconds = Number(secondsArg || 30);
const outFile = outArg;
const port = 9229;
if (!pid) throw new Error('pid required');

const TARGETS = ['monitorScan', 'pollLocked', 'poll', 'observe', 'observeOwn', 'readJson', 'get', 'save', 'locked',
  'scanSleeping', 'listSleeping', 'listWorkerCandidates', 'trySleep', 'finishReports', 'waitForTree', 'deliver',
  'deliverReports', 'publicResult', 'captureObservation', 'sameObservation', 'owesFastPoll', 'settle'];

const log = (...args) => console.log('[cov]', ...args);
process._debugProcess(pid);
const base = `http://127.0.0.1:${port}`;
let targets;
for (let attempt = 0; attempt < 40; attempt += 1) {
  try { const list = await (await fetch(`${base}/json/list`)).json(); if (list?.length) { targets = list; break; } } catch { /* retry */ }
  await new Promise(resolve => setTimeout(resolve, 250));
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
  if (message.error) reject(new Error(`${message.error.code}: ${message.error.message}`)); else resolve(message.result);
});
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', () => reject(new Error('websocket error')), { once: true });
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

await send('Profiler.enable');
const startedAt = Date.now();
await send('Profiler.startPreciseCoverage', { callCount: true, detailed: false });
log(`counting for ${seconds}s`);
await new Promise(resolve => setTimeout(resolve, seconds * 1000));
const { result } = await send('Profiler.takePreciseCoverage');
await send('Profiler.stopPreciseCoverage');
const elapsed = (Date.now() - startedAt) / 1000;

const counts = new Map();
const perFile = new Map();
for (const script of result ?? []) {
  const url = script.url || '';
  if (!url.includes('futureaide-control')) continue;
  for (const fn of script.functions ?? []) {
    // The first range covers the whole function body; its count is how often it ran.
    const range = fn.ranges?.[0];
    if (!range) continue;
    const name = fn.functionName || '(anonymous)';
    const key = `${name} @ ${url.replace(/^.*futureaide-control[\\/]/, '')}:${range.startOffset}`;
    counts.set(key, (counts.get(key) ?? 0) + range.count);
    perFile.set(url, (perFile.get(url) ?? 0) + range.count);
  }
}
const wanted = new Map();
for (const [key, count] of counts) {
  const name = key.split(' @ ')[0];
  if (TARGETS.includes(name)) wanted.set(key, count);
}
const byName = new Map();
for (const [key, count] of wanted) {
  const name = key.split(' @ ')[0];
  const current = byName.get(name) ?? { count: 0, where: key.split(' @ ')[1] };
  byName.set(name, { count: current.count + count, where: current.where });
}
const summary = [...byName].map(([name, entry]) => ({ name, calls: entry.count, perSecond: Number((entry.count / elapsed).toFixed(2)), where: entry.where }))
  .sort((left, right) => right.calls - left.calls);
const output = { pid, seconds: Number(elapsed.toFixed(1)), summary, scripts: result?.length ?? 0 };
console.log(JSON.stringify(output, null, 2));
if (outFile) (await import('node:fs')).writeFileSync(outFile, JSON.stringify({ ...output, all: [...counts].map(([key, count]) => ({ key, count })) }, null, 2));
socket.close();
process.exit(0);
